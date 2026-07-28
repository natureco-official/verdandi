import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { promisify } from "node:util";
import { classifyAcceptedBaselineFailure, diagnosticContentSignature } from "../benchmark_runs/validation_policy.mjs";

/**
 * Benchmark koşucusu paket yöneticisi (varsayılan pnpm) ve harici bir depo
 * worktree'si bekler. İkisi de yoksa test ürünü değil eksik kurulumu ölçer;
 * BAŞARISIZ değil ATLANDI olmalı.
 */
async function benchmarkOnkosuluEksik(): Promise<string | null> {
  const { execFile } = await import("node:child_process");
  const komut = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const bulundu = await new Promise<boolean>(cozumle => {
    execFile(komut, ["--version"], { shell: process.platform === "win32" }, hata => cozumle(!hata));
  });
  return bulundu ? null : "pnpm kurulu değil; benchmark koşucusu onu çağırıyor";
}


const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "..");
const validator = path.join(repositoryRoot, "benchmark_runs/validate_one.mjs");
const runner = path.join(repositoryRoot, "benchmark_runs/run_one.mjs");
const temporaryRoots: string[] = [];

async function worktree(withTest: boolean, task = "T01"): Promise<{ base: string; output: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "verdandi-validator-"));
  temporaryRoots.push(root);
  const base = path.join(root, "worktrees");
  const output = path.join(root, "results");
  const packageRoot = path.join(base, `${task}-a`, "packages/client");
  await mkdir(path.join(packageRoot, "test/client"), { recursive: true });
  await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({
    scripts: {
      test: `node -e "process.exit(0)"`,
      lint: `node -e "process.exit(0)"`,
      typecheck: `node -e "process.exit(0)"`,
    },
  }));
  if (withTest) {
    await writeFile(path.join(packageRoot, "test/client/auth.test.ts"), "// validator fixture\n");
    if (task === "T04") await writeFile(path.join(packageRoot, "test/client/streamableHttp.test.ts"), "// validator fixture\n");
  }
  return { base, output };
}

afterEach(async () => {
  while (temporaryRoots.length) await rm(temporaryRoots.pop()!, { recursive: true, force: true });
});

describe("benchmark validator hardening", () => {
  it("capsule runner kaliteyi sabit arac kotasiyla kesmez ve son edit sonrasi testi zorunlu tutar", async () => {
    const source = await readFile(runner, "utf8");
    assert.doesNotMatch(source, /Toplam terminal cagirilarini/);
    assert.match(source, /Sabit arac\/terminal cagrisi kotasi yoktur/);
    assert.match(source, /Son degisiklikten sonra hedef test yeniden gecmeden/);
    assert.match(source, /public tip\/API'leri/);
    assert.match(source, /CAPSULE_RUN_LABEL/);
  });
  it("yalniz allowlist'teki taban typecheck diagnostiklerini ayirir", () => {
    const base = { exitCode: 2, timedOut: false, stderr: "", stdout: "test/standardSchema.test.ts(1,2): error TS2532: Object is possibly undefined.\n" };
    const command = { expectedDiagnosticSha256: "4c9376b5c2c6d46bf16c8317e8ecefd0118b2ae71a34e8182c2040df35e02cae" };
    assert.equal(classifyAcceptedBaselineFailure(command, base), true);
    assert.equal(classifyAcceptedBaselineFailure(command, { ...base, stdout: "test/cloudflareWorkers.test.ts(1,2): error TS2532: regression\n" }), false);
    assert.equal(classifyAcceptedBaselineFailure(command, { ...base, stdout: "test/standardSchema.test.ts(1,2): error TS9999: new failure\n" }), false);
    assert.equal(classifyAcceptedBaselineFailure(command, { ...base, timedOut: true }), false);
  });
  it("baseline tanisini satir kaymasindan bagimsiz ama mesaj ve kod icin tam eslestirir", () => {
    const original = "test/example.ts(10,2): error TS2322: Type 'number' is not assignable to type 'string'.\n";
    const command = { expectedDiagnosticContentSha256: diagnosticContentSignature(original) };
    const result = { exitCode: 2, timedOut: false, stderr: "", stdout: original };
    assert.equal(classifyAcceptedBaselineFailure(command, { ...result, stdout: original.replace("(10,2)", "(40,9)") }), true);
    assert.equal(classifyAcceptedBaselineFailure(command, { ...result, stdout: original.replace("TS2322", "TS2345") }), false);
    assert.equal(classifyAcceptedBaselineFailure(command, { ...result, stdout: original.replace("number", "boolean") }), false);
  });
  it("declared test file eksikse komut calistirmadan non-zero cikar", async () => {
    const fixture = await worktree(false);
    await assert.rejects(
      () => execFileAsync(process.execPath, [validator, "T01", "a"], {
        cwd: repositoryRoot,
        env: { ...process.env, CAPSULE_WORKTREE_BASE: fixture.base, CAPSULE_VALIDATION_OUTPUT_DIR: fixture.output },
      }),
      (error: unknown) => {
        const result = error as { code?: number; stdout?: string };
        assert.equal(result.code, 1);
        assert.match(result.stdout ?? "", /"kind":"preflight"/);
        return true;
      },
    );
  });

  it("tum validator komutlari basariliysa zero cikar", async (t) => {
    const atlaSebebi = await benchmarkOnkosuluEksik();
    if (atlaSebebi) return t.skip(atlaSebebi);

    const fixture = await worktree(true);
    const { stdout } = await execFileAsync(process.execPath, [validator, "T01", "a"], {
      cwd: repositoryRoot,
      env: { ...process.env, CAPSULE_WORKTREE_BASE: fixture.base, CAPSULE_VALIDATION_OUTPUT_DIR: fixture.output },
    });
    assert.match(stdout, /"exitCode":0/);
  });

  it("T04 retry oracle'ini uc yalitilmis tekrar olarak zorunlu tutar", async (t) => {
    const atlaSebebi = await benchmarkOnkosuluEksik();
    if (atlaSebebi) return t.skip(atlaSebebi);

    const fixture = await worktree(true, "T04");
    await execFileAsync(process.execPath, [validator, "T04", "a"], {
      cwd: repositoryRoot,
      env: { ...process.env, CAPSULE_WORKTREE_BASE: fixture.base, CAPSULE_VALIDATION_OUTPUT_DIR: fixture.output },
    });
    const record = JSON.parse(await readFile(path.join(fixture.output, "T04-a.json"), "utf8"));
    assert.deepEqual(record.results.map((result: { kind: string }) => result.kind), [
      "oracle-1", "oracle-2", "oracle-3", "test", "lint", "typecheck",
    ]);
    assert.ok(record.results.slice(0, 3).every((result: { command: string[] }) =>
      result.command.includes("refresh.*retr")));
  });
});
