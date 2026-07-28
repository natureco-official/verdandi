import { spawn } from 'node:child_process';
import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyAcceptedBaselineFailure } from './validation_policy.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const capsuleRoot = path.resolve(__dirname, '..');

const [taskId, agent] = process.argv.slice(2);

if (!/^T(?:0[1-9]|10)$/.test(taskId ?? '') || !agent) {
  console.error('usage: node validate_one.mjs T01 <agent-name>');
  process.exit(2);
}

const worktreeBase = process.env.CAPSULE_WORKTREE_BASE || '/private/tmp/capsule-baseline-worktrees';
const root = `${worktreeBase}/${taskId}-${agent}`;
const outputDir = process.env.CAPSULE_VALIDATION_OUTPUT_DIR || path.join(__dirname, 'validation');
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;

const packageValidation = (packageDir, testArgs = []) => [
  { kind: 'test', cwd: '.', args: ['--dir', packageDir, 'test', ...testArgs], testFiles: testArgs.map(file => path.join(packageDir, file)) },
  { kind: 'lint', cwd: '.', args: ['--dir', packageDir, 'lint'] },
  { kind: 'typecheck', cwd: '.', args: ['--dir', packageDir, 'typecheck'] },
];

const commands = {
  T01: packageValidation('packages/client', ['test/client/auth.test.ts']),
  T02: [
    { kind: 'test', cwd: '.', args: ['--dir', 'test/integration', 'test', 'test/server/cloudflareWorkers.test.ts'], testFiles: ['test/integration/test/server/cloudflareWorkers.test.ts'] },
    { kind: 'lint', cwd: '.', args: ['--dir', 'test/integration', 'lint'] },
    { kind: 'typecheck', cwd: '.', args: ['--dir', 'test/integration', 'exec', 'tsc', '-p', 'tsconfig.json', '--noEmit'], expectedDiagnosticContentSha256: '0f41fce1e182581f11cc8d6cbf81d9c566ee4f73711043e7ac073d3ebfad4820' },
  ],
  T03: [
    { kind: 'test', cwd: '.', args: ['--dir', 'test/integration', 'test', 'test/server/cloudflareWorkers.test.ts'], testFiles: ['test/integration/test/server/cloudflareWorkers.test.ts'] },
    { kind: 'lint', cwd: '.', args: ['--dir', 'test/integration', 'lint'] },
    { kind: 'typecheck', cwd: '.', args: ['--dir', 'test/integration', 'exec', 'tsc', '-p', 'tsconfig.json', '--noEmit'], expectedDiagnosticContentSha256: 'c470101772c037d75f21d3f114aa56914b2435b36722141d13905fa199dfa084' },
  ],
  T04: [
    {
      kind: 'oracle', cwd: '.', repeat: 3,
      args: ['--dir', 'packages/client', 'test', 'test/client/streamableHttp.test.ts', '-t', 'refresh.*retr'],
      testFiles: ['packages/client/test/client/streamableHttp.test.ts'],
    },
    ...packageValidation('packages/client', [
      'test/client/auth.test.ts',
      'test/client/streamableHttp.test.ts',
    ]),
  ],
  T05: [
    { kind: 'test', cwd: '.', args: ['--dir', 'test/integration', 'test', 'test/server/mcp.test.ts'], testFiles: ['test/integration/test/server/mcp.test.ts'] },
    { kind: 'lint', cwd: '.', args: ['--dir', 'packages/server', 'lint'] },
    { kind: 'typecheck', cwd: '.', args: ['--dir', 'packages/server', 'typecheck'] },
  ],
  T06: packageValidation('packages/core-internal', [
    'test/shared/inboundClassification.test.ts',
    'test/shared/standardHeaderValidation.test.ts',
  ]),
  T07: packageValidation('packages/client', ['test/client/streamableHttp.test.ts']),
  T08: [
    { kind: 'build', cwd: '.', args: ['--filter', './packages/middleware/**', 'build'] },
    { kind: 'declaration-oracle', cwd: '.', executable: process.execPath, args: [path.join(__dirname, 'oracles/T08.mjs'), root] },
    { kind: 'lint', cwd: '.', args: ['--filter', './packages/middleware/**', 'lint'] },
    { kind: 'typecheck', cwd: '.', args: ['--filter', './packages/middleware/**', 'typecheck'] },
  ],
  T09: packageValidation('packages/client', [
    'test/client/mcpParamMirroring.test.ts',
    'test/client/responseCache.test.ts',
  ]),
  T10: packageValidation('packages/server', [
    'test/server/perRequestStreaming.test.ts',
    'test/server/streamableHttp.test.ts',
  ]),
}[taskId];

function run(command) {
  return new Promise(resolve => {
    const cwd = path.join(root, command.cwd);
    const startedAt = new Date().toISOString();
    const started = Date.now();
    const executable = command.executable ?? 'pnpm';
    // Windows'ta pnpm/npm PATH üzerinde .cmd toplu iş dosyasıdır. spawn shell
    // açmadığı için uzantısız ad ENOENT verir (exitCode 127) ve uzantı eklemek
    // de çözmez: Node 20+ .cmd dosyalarını shell'siz çalıştırmayı güvenlik
    // gerekçesiyle reddeder (EINVAL, CVE-2024-27980). Bu yüzden benchmark
    // koşucusu Windows'ta her komutu "bulunamadı" olarak raporluyordu.
    //
    // Shell yalnızca Windows'ta açılıyor ve burada güvenli: çalıştırılabilir
    // ad ile argümanların tamamı bu dosyadaki sabit komut tablosundan geliyor
    // (packageValidation ve commands). taskId/agent yalnızca hangi tablo
    // satırının seçileceğini belirler, komut satırına girmez.
    const child = spawn(executable, command.args, {
      cwd,
      env: process.env,
      shell: process.platform === 'win32',
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let settled = false;
    const capture = (chunks, chunk, stream) => {
      const used = stream === 'stdout' ? stdoutBytes : stderrBytes;
      const remaining = Math.max(0, MAX_CAPTURE_BYTES - used);
      if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
      if (stream === 'stdout') {
        stdoutBytes += Math.min(chunk.length, remaining);
        stdoutTruncated ||= chunk.length > remaining;
      } else {
        stderrBytes += Math.min(chunk.length, remaining);
        stderrTruncated ||= chunk.length > remaining;
      }
    };
    child.stdout.on('data', chunk => capture(stdout, chunk, 'stdout'));
    child.stderr.on('data', chunk => capture(stderr, chunk, 'stderr'));
    let forceKillTimer;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      forceKillTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
    }, 15 * 60 * 1000);
    const finish = (exitCode, signal, spawnError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      const result = {
        kind: command.kind,
        command: [executable, ...command.args],
        cwd,
        startedAt,
        durationMs: Date.now() - started,
        exitCode: spawnError ? 127 : exitCode,
        signal,
        timedOut,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: spawnError ? spawnError.message : Buffer.concat(stderr).toString('utf8'),
        stdoutTruncated,
        stderrTruncated,
      };
      result.acceptedBaselineFailure = classifyAcceptedBaselineFailure(command, result);
      resolve(result);
    };
    child.once('error', error => finish(null, null, error));
    child.once('close', (exitCode, signal) => finish(exitCode, signal));
  });
}

await mkdir(outputDir, { recursive: true });
const results = [];
const missingTestFiles = [];
for (const command of commands) {
  for (const relative of command.testFiles ?? []) {
    const absolute = path.resolve(root, relative);
    const fromRoot = path.relative(root, absolute);
    if (!fromRoot || fromRoot.startsWith('..') || path.isAbsolute(fromRoot)) {
      missingTestFiles.push(`${relative} (unsafe path)`);
      continue;
    }
    try { await access(absolute); } catch { missingTestFiles.push(relative); }
  }
}
if (missingTestFiles.length) {
  results.push({
    kind: 'preflight', command: [], cwd: root, startedAt: new Date().toISOString(), durationMs: 0,
    exitCode: 2, signal: null, timedOut: false, stdout: '',
    stderr: `Missing declared test file(s): ${missingTestFiles.join(', ')}`,
    stdoutTruncated: false, stderrTruncated: false,
  });
} else {
  for (const command of commands) {
    for (let attempt = 1; attempt <= (command.repeat ?? 1); attempt++) {
      results.push(await run({
        ...command,
        kind: command.repeat ? `${command.kind}-${attempt}` : command.kind,
      }));
    }
  }
}

const record = {
  taskId,
  agent,
  worktree: root,
  completedAt: new Date().toISOString(),
  results,
};
const base = path.join(outputDir, `${taskId}-${agent}`);
await writeFile(`${base}.json`, `${JSON.stringify(record, null, 2)}\n`);

const raw = results.map(result => [
  `===== ${result.kind.toUpperCase()} =====`,
  `$ cd ${result.cwd}`,
  `$ ${result.command.join(' ')}`,
  `started_at: ${result.startedAt}`,
  `duration_ms: ${result.durationMs}`,
  `exit_code: ${result.exitCode}`,
  `signal: ${result.signal ?? ''}`,
  `timed_out: ${result.timedOut}`,
  `accepted_baseline_failure: ${result.acceptedBaselineFailure ?? false}`,
  `stdout_truncated: ${result.stdoutTruncated}`,
  `stderr_truncated: ${result.stderrTruncated}`,
  '----- STDOUT -----',
  result.stdout,
  '----- STDERR -----',
  result.stderr,
].join('\n')).join('\n\n');
await writeFile(`${base}.log`, `${raw}\n`);

console.log(JSON.stringify({
  taskId,
  agent,
  results: results.map(({ kind, exitCode, durationMs, timedOut, acceptedBaselineFailure }) => ({ kind, exitCode, durationMs, timedOut, acceptedBaselineFailure: acceptedBaselineFailure ?? false })),
}));
process.exitCode = results.every(result => (result.exitCode === 0 || result.acceptedBaselineFailure) && !result.timedOut) ? 0 : 1;
