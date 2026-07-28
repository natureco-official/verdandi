#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const capsuleRoot = path.resolve(__dirname, '..');
const worktreeBase = process.env.CAPSULE_WORKTREE_BASE || '/private/tmp/capsule-baseline-worktrees';
const codexModel = process.env.URDR_CODEX_MODEL || 'gpt-5.6';
const runTimeoutMs = Number(process.env.CAPSULE_RUN_TIMEOUT_MS || 30 * 60 * 1000);
const MAX_STDOUT_BYTES = 64 * 1024 * 1024;
const MAX_STDERR_BYTES = 8 * 1024 * 1024;
const runLabel = process.env.CAPSULE_RUN_LABEL;

if (runLabel !== undefined && !/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(runLabel)) {
  console.error('CAPSULE_RUN_LABEL must be 1-32 alphanumeric, underscore, or dash characters');
  process.exit(2);
}

if (!Number.isFinite(runTimeoutMs) || runTimeoutMs < 1_000 || runTimeoutMs > 24 * 60 * 60 * 1000) {
  console.error('CAPSULE_RUN_TIMEOUT_MS must be between 1000 and 86400000');
  process.exit(2);
}

const AGENTS = {
  codex:           { binary: 'codex', needsCapsule: false },
  'codex-capsule': { binary: 'codex', needsCapsule: true },
  claude:          { binary: 'claude', needsCapsule: false },
  'claude-capsule':{ binary: 'claude', needsCapsule: true },
  natureco:        { binary: 'natureco', needsCapsule: false },
  'natureco-capsule': { binary: 'natureco', needsCapsule: true },
  hermes:          { binary: 'hermes', needsCapsule: false },
  'hermes-capsule':{ binary: 'hermes', needsCapsule: true },
  opencode:        { binary: 'opencode', needsCapsule: false },
  'opencode-capsule': { binary: 'opencode', needsCapsule: true },
  kimi:            { binary: 'kimi', needsCapsule: false },
  glm:             { binary: 'glm', needsCapsule: false },
};

const [taskId, agent] = process.argv.slice(2);
if (!/^T(?:0[1-9]|1[0-9]|20)$/.test(taskId ?? '') || !agent || !AGENTS[agent]) {
  console.error(`Usage: node run_one.mjs T01 <agent>`);
  console.error(`Agents: ${Object.keys(AGENTS).join(', ')}`);
  process.exit(2);
}

const agentInfo = AGENTS[agent];
const promptPath = path.join(__dirname, 'prompts', `${taskId}.txt`);
const worktree = `${worktreeBase}/${taskId}-${agent}`;
const rawDir = path.join(__dirname, 'raw');
const taskPrompt = (await readFile(promptPath, 'utf8')).trim();

const capsuleInstruction = `
\n\nContext compiler etkin: goreve baslamadan once urdr-context-compiler MCP sunucusunun context_capsule aracini mevcut worktree projectRoot'u ve gorev metniyle bir kez cagir. probable_files[0] ve kapsulun bildirdigi birincil paket dizininden basla; fakat gorevde adlandirilan diger katmanlari, public tip/API'leri, package/build configlerini, dokumantasyonu, komsu testleri ve cleanup/yasam dongusu yollarini kanit gerektiriyorsa incele. Kapsul bir baslangic siralamasidir, izin verilen dosyalar listesi degildir. read_symbol yalniz terminalden okunmamis hedefli kaynak kaniti icin kullan; dosyayi terminalden okuduysan ayni sembolu tekrar okuma. Uygunsa apply_structured_patch kullan. Sabit arac/terminal cagrisi kotasi yoktur; her cagri yeni bir soruyu yanitlamali ve ayni komut gereksiz yere tekrarlanmamalidir. Genis arama sonuclarini ve makine-okunur lint/typecheck ciktisini baglama dokme; ilgili bolumu sinirla. Gorev acikca git gecmisi istemiyorsa git log/show ile eski commit cozumlerini tarama. Mekanik lint/import gorevinde --fix-dry-run veya --format json kullanma; hedef paket dizininden dogrudan --fix calistirip diff'i incele. Her duzenleme turundan sonra ilgili hedef davranis testini yeniden calistir; son adim olarak birincil paketin package.json dosyasindaki tam lint/typecheck scriptlerini calistir. Son degisiklikten sonra hedef test yeniden gecmeden gorevi tamamlanmis sayma. Birden fazla dogrulama komutunu birlestirirsen set -e ve set -o pipefail kullan; erken test hatasini sonraki basarili komutla maskeleme. validate_delta aracini yalniz proje kokundeki package.json istenen scripti gercekten tanimliyorsa kullan. MCP bulgularini ve kapsul success_criteria maddelerini cozume dahil et.`;

const prompt = agentInfo.needsCapsule ? taskPrompt + capsuleInstruction : taskPrompt;
await mkdir(rawDir, { recursive: true });

// Build agent-specific command and args
let command, args;
const isCodex = agent.startsWith('codex');
const isClaude = agent.startsWith('claude');
const isNatureco = agent.startsWith('natureco');
const isHermes = agent.startsWith('hermes');
const isOpenCode = agent.startsWith('opencode');
const isKimi = agent.startsWith('kimi');
const isGlm = agent.startsWith('glm');

if (isCodex) {
  command = 'codex';
  args = [
    ...(agentInfo.needsCapsule ? ['--dangerously-bypass-approvals-and-sandbox'] : []),
    'exec', '--ephemeral', '--json', '--color', 'never',
    '--sandbox', 'workspace-write',
    '--model', codexModel,
    '-c', 'model_reasoning_effort="medium"',
    '--cd', worktree, prompt,
  ];
} else if (isClaude) {
  command = 'claude';
  args = ['-p', '--output-format', 'json', '--no-session-persistence',
    '--permission-mode', 'auto', '--model', 'sonnet', '--effort', 'medium', prompt];
} else if (isNatureco) {
  command = 'natureco';
  args = ['code', '-p', prompt];
} else if (isHermes) {
  command = 'hermes';
  args = ['chat', '-q', prompt, '--yolo', '--cli'];
} else if (isOpenCode) {
  command = 'opencode';
  args = ['-p', prompt];
} else if (isKimi) {
  command = 'kimi';
  args = ['-p', prompt];
} else if (isGlm) {
  command = 'glm';
  args = ['-q', prompt];
} else {
  console.error(`Unknown agent: ${agent}`);
  process.exit(2);
}

const startedAt = new Date();
const started = performance.now();
const child = spawn(command, args, {
  cwd: worktree,
  env: process.env,
  stdio: ['ignore', 'pipe', 'pipe'],
});

let stdout = '';
let stderr = '';
let stdoutBytes = 0;
let stderrBytes = 0;
let outputLimitExceeded = false;
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', chunk => {
  const bytes = Buffer.byteLength(chunk);
  if (stdoutBytes + bytes > MAX_STDOUT_BYTES) {
    outputLimitExceeded = true;
    child.kill('SIGTERM');
    return;
  }
  stdout += chunk;
  stdoutBytes += bytes;
});
child.stderr.on('data', chunk => {
  const remaining = MAX_STDERR_BYTES - stderrBytes;
  if (remaining > 0) {
    const captured = Buffer.from(chunk).subarray(0, remaining);
    stderr += captured.toString('utf8');
    stderrBytes += captured.length;
  }
});

let timedOut = false;
let forceKillTimer;
const timeout = setTimeout(() => {
  timedOut = true;
  child.kill('SIGTERM');
  forceKillTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
}, runTimeoutMs);

let spawnError = null;
const exitCode = await new Promise(resolve => {
  child.once('error', error => {
    spawnError = error;
    resolve(127);
  });
  child.once('close', code => resolve(code));
});
clearTimeout(timeout);
if (forceKillTimer) clearTimeout(forceKillTimer);
const durationMs = Math.round(performance.now() - started);

let usage = null;
let reportedModel = null;
let parseError = spawnError ? `Failed to start ${command}: ${spawnError.message}` : null;
try {
  if (!spawnError && isCodex) {
    const events = stdout.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    usage = [...events].reverse().find(event => event.type === 'turn.completed')?.usage ?? null;
    reportedModel = codexModel;
  } else if (!spawnError && isClaude) {
    const result = JSON.parse(stdout);
    usage = result.usage ?? null;
    const models = Object.keys(result.modelUsage ?? {});
    reportedModel = models.length === 1 ? models[0] : models.join(',') || null;
  } else if (!spawnError) {
    // Generic: try to parse JSON output
    try {
      const result = JSON.parse(stdout);
      usage = result.usage ?? null;
      reportedModel = result.model ?? null;
    } catch {
      // Plain text output — no structured usage data
      reportedModel = agent;
    }
  }
} catch (error) {
  parseError = error instanceof Error ? error.message : String(error);
}

const base = `${taskId}-${agent}${runLabel ? `-${runLabel}` : ''}`;
await writeFile(path.join(rawDir, `${base}.stdout`), stdout, 'utf8');
await writeFile(path.join(rawDir, `${base}.stderr`), stderr, 'utf8');
await writeFile(
  path.join(rawDir, `${base}.meta.json`),
  `${JSON.stringify({
    taskId,
    agent,
    promptPath: path.relative(capsuleRoot, promptPath),
    promptSha256: await sha256(prompt),
    worktree,
    startCommit: await gitHead(worktree),
    model: reportedModel,
    effort: 'medium',
    startedAt: startedAt.toISOString(),
    durationMs,
    exitCode,
    timedOut,
    outputLimitExceeded,
    usage,
    parseError,
  }, null, 2)}\n`,
  'utf8',
);

console.log(JSON.stringify({ taskId, agent, exitCode, durationMs, timedOut, outputLimitExceeded, usage, reportedModel, parseError }));
process.exit(exitCode === 0 && !timedOut && !outputLimitExceeded ? 0 : 1);

async function sha256(value) {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(value).digest('hex');
}

async function gitHead(cwd) {
  const { execFile } = await import('node:child_process');
  return await new Promise((resolve, reject) => {
    execFile('git', ['rev-parse', 'HEAD'], { cwd }, (error, output) => {
      if (error) reject(error);
      else resolve(output.trim());
    });
  });
}
