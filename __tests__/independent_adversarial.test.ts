import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, it } from "node:test";
import { promisify } from "node:util";
import { TypeScriptContextCompiler } from "../src/context_compiler.js";
import { parseLLMOutput } from "../src/llm_parser.js";
import { runAgent } from "../src/verdandi_agent.js";
import { startStdioMcpClient } from "../src/stdio_mcp_client.mjs";

/**
 * Windows'ta symlink oluşturmak yönetici hakkı ya da Geliştirici Modu ister;
 * yoksa EPERM gelir. Bu, ürünün değil ortamın sınırı — test BAŞARISIZ değil
 * ATLANDI sayılmalı, aksi hâlde gerçek bir gerileme bu gürültünün içinde
 * kaybolur.
 */
async function symlinkDesteklenmiyor(): Promise<string | null> {
  const { mkdtemp, symlink: baglantiKur, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const dizin = await mkdtemp(path.join(tmpdir(), "verdandi-symlink-probe-"));
  try {
    await baglantiKur(dizin, path.join(dizin, "probe-link"), "dir");
    return null;
  } catch (hata) {
    const kod = (hata as NodeJS.ErrnoException).code ?? "bilinmiyor";
    return `bu ortamda symlink oluşturulamıyor (${kod}); Windows'ta Geliştirici Modu veya yönetici hakkı gerekir`;
  } finally {
    await rm(dizin, { recursive: true, force: true }).catch(() => {});
  }
}


const temporaryRoots: string[] = [];
const repositoryRoot = path.resolve(import.meta.dirname, "..");
const serverPath = path.join(repositoryRoot, "dist/src/mcp_server.js");
const execFileAsync = promisify(execFile);

async function temporaryProject(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "verdandi-adversarial-"));
  temporaryRoots.push(root);
  await mkdir(path.join(root, "src"), { recursive: true });
  return root;
}

afterEach(async () => {
  while (temporaryRoots.length) await rm(temporaryRoots.pop()!, { recursive: true, force: true });
});

async function mcpRequest(method: string, params: unknown): Promise<any> {
  const child = spawn(process.execPath, [serverPath], { cwd: repositoryRoot, stdio: ["pipe", "pipe", "pipe"] });
  const lines = createInterface({ input: child.stdout });
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("MCP timeout")), 10_000);
      lines.once("line", line => {
        clearTimeout(timer);
        const response = JSON.parse(line);
        response.error ? reject(Object.assign(new Error(response.error.message), { response })) : resolve(response.result);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })}\n`);
    });
  } finally {
    lines.close();
    child.kill();
  }
}

function fakeLlm(output: unknown) {
  return async () => ({ content: JSON.stringify(output), tokens: { prompt: 10, output: 10 } });
}

describe("independent adversarial audit", () => {
  it("rejects unknown, malformed, and truncated model edits without a valid prefix", () => {
    for (const raw of [
      `[{"file":"src/a.ts","symbol":"a","operation":"explode","newCode":"x"}]`,
      `[{"file":"src/a.ts","operation":"replace_symbol","newCode":"x"}]`,
      `[{"file":"src/a.ts","symbol":"a","operation":"replace_symbol","newCode":7}]`,
      `[{"file":"src/a.ts","symbol":"a","operation":"delete"},{`,
      `[{"action":"needs_more_context","file":"src/a.ts"},{"file":"src/a.ts","symbol":"a","operation":"delete"}]`,
    ]) {
      const parsed = parseLLMOutput(raw);
      assert.ok(parsed.parseError, raw);
      assert.deepEqual(parsed.edits, []);
    }
  });

  it("enforces capsule input bounds, normalizes scores, indexes enums, and honors payload budgets", async () => {
    const root = await temporaryProject();
    await writeFile(path.join(root, "src/main.ts"), `export enum Mode { Safe, Fast }\nexport function chooseMode(mode: Mode) { return mode; }\n`);
    const compiler = new TypeScriptContextCompiler();
    await assert.rejects(() => compiler.context_capsule({ projectRoot: root, task: "" }), /non-empty/);
    await assert.rejects(() => compiler.context_capsule({ projectRoot: root, task: "mode", preferredBudgetLevel: 9 as never }), /preferredBudgetLevel/);
    const capsule = await compiler.context_capsule({ projectRoot: root, task: "choose safe mode", maxModelPayloadTokens: 200 });
    assert.ok(capsule._meta.estimatedPayloadTokens <= 200);
    assert.ok(capsule.modelPayload.relevantSymbols.every(symbol => symbol.score === undefined || (symbol.score >= 0 && symbol.score <= 1)));
    const enumRead = await compiler.read_symbol({ projectRoot: root, symbol: "Mode" });
    assert.equal(enumRead.evidence[0]?.symbol.kind, "enum");
  });

  it("resolves tsconfig paths relative to baseUrl", async () => {
    const root = await temporaryProject();
    await mkdir(path.join(root, "src/lib"), { recursive: true });
    await writeFile(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { baseUrl: "src", paths: { "@lib/*": ["lib/*"] } } }));
    await writeFile(path.join(root, "src/lib/helper.ts"), `export function deeplyObscureCallee() { return 1; }\n`);
    await writeFile(path.join(root, "src/main.ts"), `import { deeplyObscureCallee as renamed } from "@lib/helper";\nexport function uniqueEntrypoint() { return renamed(); }\n`);
    const capsule = await new TypeScriptContextCompiler().context_capsule({ projectRoot: root, task: "unique entrypoint" });
    assert.ok(capsule.modelPayload.relevantSymbols.some(symbol => symbol.symbol === "deeplyObscureCallee" && symbol.hopDistance === 1));
  });

  it("uses materially larger retrieval sets at higher budget levels", async () => {
    const root = await temporaryProject();
    for (let index = 0; index < 20; index++) {
      await writeFile(path.join(root, `src/widget${index}.ts`), `export function widget${index}() { return ${index}; }\n`);
    }
    const compiler = new TypeScriptContextCompiler();
    const level0 = await compiler.context_capsule({ projectRoot: root, task: "widget", preferredBudgetLevel: 0 });
    const level3 = await compiler.context_capsule({ projectRoot: root, task: "widget", preferredBudgetLevel: 3 });
    assert.equal(level0._meta.selectedBudgetLevel, 0);
    assert.equal(level3._meta.selectedBudgetLevel, 3);
    assert.ok(level3.modelPayload.relevantSymbols.length > level0.modelPayload.relevantSymbols.length);
    assert.ok(level0._meta.estimatedPayloadTokens <= 200);
    assert.ok(level3._meta.estimatedPayloadTokens <= 900);
  });

  it("retrieves package configuration for lint and import-ordering tasks", async () => {
    const root = await temporaryProject();
    await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { lint: "eslint src && prettier --check ." } }));
    await writeFile(path.join(root, "src/unrelated.ts"), `export function unrelatedBusinessValue() { return 1; }\n`);
    const capsule = await new TypeScriptContextCompiler().context_capsule({
      projectRoot: root,
      task: "Import ordering and linter status",
      preferredBudgetLevel: 1,
    });
    assert.equal(capsule.modelPayload.relevantSymbols[0]?.file, "package.json");
    const read = await new TypeScriptContextCompiler().read_symbol({ projectRoot: root, symbol: "package.json" });
    assert.match(read.evidence[0]?.source ?? "", /eslint src/);
  });

  it("never serves stale evidence from cache and rejects an explicit stale snapshot", async () => {
    const root = await temporaryProject();
    const file = path.join(root, "src/a.ts");
    await writeFile(file, `export function value() { return 1; }\n`);
    const compiler = new TypeScriptContextCompiler();
    const first = await compiler.read_symbol({ projectRoot: root, symbol: "value" });
    await writeFile(file, `export function value() { return 2; }\n`);
    const stale = await compiler.read_symbol({ projectRoot: root, symbol: "value", snapshot: first.snapshot });
    assert.equal(stale.evidence.length, 0);
    assert.equal(stale.requiresEscalation, true);
    const fresh = await compiler.read_symbol({ projectRoot: root, symbol: "value" });
    assert.match(fresh.evidence[0].source ?? "", /return 2/);
  });

  it("preflights every rollback target before reverting any file", async () => {
    const root = await temporaryProject();
    const a = path.join(root, "src/a.ts");
    const b = path.join(root, "src/b.ts");
    await writeFile(a, `export function alpha() { return 1; }\n`);
    await writeFile(b, `export function beta() { return 2; }\n`);
    const compiler = new TypeScriptContextCompiler();
    const alpha = await compiler.read_symbol({ projectRoot: root, symbol: "alpha", includeCallGraphNeighbors: false });
    const beta = await compiler.read_symbol({ projectRoot: root, symbol: "beta", includeCallGraphNeighbors: false });
    const operation = (read: typeof alpha, symbol: string, replacement: string) => ({
      operation: "replace_symbol" as const, file: read.evidence[0].symbol.file, symbol, replacement,
      precondition: { file: read.evidence[0].symbol.file, contentHash: read.evidence[0].fileContentHash!, symbol, symbolHash: read.evidence[0].contentHash },
    });
    const patched = await compiler.apply_structured_patch({
      projectRoot: root, taskId: "atomic-rollback", snapshot: alpha.snapshot, language: "typescript",
      operations: [operation(alpha, "alpha", `export function alpha() { return 10; }`), operation(beta, "beta", `export function beta() { return 20; }`)],
    });
    assert.equal(patched.applied, true);
    await writeFile(b, `// user changed after patch\n`);
    const rollback = await compiler.rollback_patch({ projectRoot: root, rollbackToken: patched.rollbackToken! });
    assert.equal(rollback.reverted, false);
    assert.deepEqual(rollback.revertedFiles, []);
    assert.match(await readFile(a, "utf8"), /return 10/);
  });

  it("rejects syntactically invalid structured patches before writing", async () => {
    const root = await temporaryProject();
    const file = path.join(root, "src/a.ts");
    const original = `export function alpha() { return 1; }\n`;
    await writeFile(file, original);
    const compiler = new TypeScriptContextCompiler();
    const read = await compiler.read_symbol({ projectRoot: root, symbol: "alpha", includeCallGraphNeighbors: false });
    const evidence = read.evidence[0];
    const result = await compiler.apply_structured_patch({
      projectRoot: root, taskId: "invalid-syntax", snapshot: read.snapshot, language: "typescript",
      operations: [{ operation: "replace_symbol", file: evidence.symbol.file, symbol: "alpha", replacement: "export function alpha( {", precondition: { file: evidence.symbol.file, contentHash: evidence.fileContentHash!, symbol: "alpha", symbolHash: evidence.contentHash } }],
    });
    assert.equal(result.applied, false);
    assert.equal(result.diagnostics[0]?.code, "PARSE_FAILED");
    assert.equal(await readFile(file, "utf8"), original);
  });

  it("refuses a patch when its crash-safe journal would escape through a symlink", async (t) => {
    const atlaSebebi = await symlinkDesteklenmiyor();
    if (atlaSebebi) return t.skip(atlaSebebi);

    const root = await temporaryProject();
    const outside = await mkdtemp(path.join(tmpdir(), "verdandi-outside-"));
    temporaryRoots.push(outside);
    await symlink(outside, path.join(root, ".verdandi"));
    await writeFile(path.join(root, "src/a.ts"), `export function alpha() { return 1; }\n`);
    const compiler = new TypeScriptContextCompiler();
    const read = await compiler.read_symbol({ projectRoot: root, symbol: "alpha", includeCallGraphNeighbors: false });
    const evidence = read.evidence[0];
    const patch = await compiler.apply_structured_patch({
      projectRoot: root, taskId: "symlink", snapshot: read.snapshot, language: "typescript",
      operations: [{ operation: "replace_symbol", file: evidence.symbol.file, symbol: "alpha", replacement: `export function alpha() { return 2; }`, precondition: { file: evidence.symbol.file, contentHash: evidence.fileContentHash!, symbol: "alpha", symbolHash: evidence.contentHash } }],
    });
    assert.equal(patch.applied, false);
    assert.equal(patch.diagnostics[0]?.code, "WRITE_FAILED");
    assert.deepEqual(await readdir(outside), []);
    assert.match(await readFile(path.join(root, "src/a.ts"), "utf8"), /return 1/);
  });

  it("keeps capsule control metadata out of model-visible MCP content", async () => {
    const result = await mcpRequest("tools/call", { name: "context_capsule", arguments: { projectRoot: repositoryRoot, task: "read symbol safely" } });
    assert.ok(result.structuredContent.goal);
    assert.equal(result.structuredContent.control, undefined);
    assert.ok(result._meta.control.retrieval_confidence >= 0);
    assert.doesNotMatch(result.content[0].text, /retrieval_confidence|selected_budget_level|control/);
  });

  it("rejects invalid nested MCP arguments before tool execution", async () => {
    await assert.rejects(
      () => mcpRequest("tools/call", { name: "validate_delta", arguments: { projectRoot: repositoryRoot, taskId: "x", kinds: ["shell"] } }),
      /Invalid value/,
    );
    await assert.rejects(
      () => mcpRequest("tools/call", { name: "context_capsule", arguments: { projectRoot: repositoryRoot, task: "x", surprise: true } }),
      /Unknown parameter/,
    );
    await assert.rejects(
      () => mcpRequest("tools/call", { name: "apply_structured_patch", arguments: {
        projectRoot: repositoryRoot, taskId: "x", snapshot: "x", language: "typescript",
        operations: [{ operation: "explode", file: "src/a.ts", symbol: "a", precondition: { file: "src/a.ts", contentHash: "x" } }],
      } }),
      /Invalid value/,
    );
  });

  it("resolves relative auto-capsule project roots against the caller directory", async () => {
    const { stdout } = await execFileAsync(process.execPath, ["src/auto_capsule.mjs", ".", "TypeScriptContextCompiler"], {
      cwd: repositoryRoot, timeout: 15_000, maxBuffer: 4 * 1024 * 1024,
    });
    const capsule = JSON.parse(stdout);
    assert.ok(capsule.files.includes("src/context_compiler.ts"));
    assert.ok(capsule.symbols.every((symbol: { file: string }) => !symbol.file.endsWith(".js")));
    assert.equal(capsule.meta.confidence, undefined);
  });

  it("rolls back the complete agent patch when validation fails", async () => {
    const root = await temporaryProject();
    const a = path.join(root, "src/a.ts");
    const b = path.join(root, "src/b.ts");
    await writeFile(a, `export function alpha() { return 1; }\n`);
    await writeFile(b, `export function beta() { return 2; }\n`);
    await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: {
      test: `node -e "process.exit(1)"`, lint: `node -e "process.exit(0)"`, typecheck: `node -e "process.exit(0)"`,
    } }));
    const llmCaller = fakeLlm([
      { file: "src/a.ts", symbol: "alpha", operation: "replace_symbol", newCode: `export function alpha() { return 10; }` },
      { file: "src/b.ts", symbol: "beta", operation: "replace_symbol", newCode: `export function beta() { return 20; }` },
    ]);
    const result = await runAgent("change alpha and beta", root, { apiKey: "test", maxRetries: 1, llmCaller });
    assert.equal(result.success, false);
    assert.deepEqual(result.edits, []);
    assert.match(await readFile(a, "utf8"), /return 1/);
    assert.match(await readFile(b, "utf8"), /return 2/);
  });

  it("applies a successful multi-file agent patch atomically and exposes a usable rollback token", async () => {
    const root = await temporaryProject();
    const a = path.join(root, "src/a.ts");
    const b = path.join(root, "src/b.ts");
    await writeFile(a, `export function alpha() { return 1; }\n`);
    await writeFile(b, `export function beta() { return 2; }\n`);
    await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: {
      test: `node -e "process.exit(0)"`, lint: `node -e "process.exit(0)"`, typecheck: `node -e "process.exit(0)"`,
    } }));
    const result = await runAgent("change alpha and beta", root, {
      apiKey: "test", maxRetries: 1, llmCaller: fakeLlm([
        { file: "src/a.ts", symbol: "alpha", operation: "replace_symbol", newCode: `export function alpha() { return 10; }` },
        { file: "src/b.ts", symbol: "beta", operation: "replace_symbol", newCode: `export function beta() { return 20; }` },
      ]),
    });
    assert.equal(result.success, true);
    assert.ok(result.rollbackToken);
    assert.match(await readFile(a, "utf8"), /return 10/);
    assert.match(await readFile(b, "utf8"), /return 20/);
    const rollback = await new TypeScriptContextCompiler().rollback_patch({ projectRoot: root, rollbackToken: result.rollbackToken! });
    assert.equal(rollback.reverted, true);
    assert.match(await readFile(a, "utf8"), /return 1/);
    assert.match(await readFile(b, "utf8"), /return 2/);
  });

  it("writes nothing when one edit in a proposed batch cannot be resolved", async () => {
    const root = await temporaryProject();
    const file = path.join(root, "src/a.ts");
    const original = `export function alpha() { return 1; }\n`;
    await writeFile(file, original);
    await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "true", lint: "true", typecheck: "true" } }));
    const llmCaller = fakeLlm([
      { file: "src/a.ts", symbol: "alpha", operation: "replace_symbol", newCode: `export function alpha() { return 10; }` },
      { file: "src/a.ts", symbol: "missing", operation: "delete" },
    ]);
    const result = await runAgent("change two symbols", root, { apiKey: "test", maxRetries: 1, llmCaller });
    assert.equal(result.success, false);
    assert.equal(await readFile(file, "utf8"), original);
  });

  it("does not disclose an out-of-project symlink requested as more context", async (t) => {
    const atlaSebebi = await symlinkDesteklenmiyor();
    if (atlaSebebi) return t.skip(atlaSebebi);

    const root = await temporaryProject();
    const outside = path.join(await mkdtemp(path.join(tmpdir(), "verdandi-secret-")), "secret.ts");
    temporaryRoots.push(path.dirname(outside));
    await writeFile(outside, "TOP_SECRET_CONTEXT_SHOULD_NEVER_APPEAR\n");
    await symlink(outside, path.join(root, "src/secret-link.ts"));
    await writeFile(path.join(root, "src/a.ts"), `export function alpha() { return 1; }\n`);
    await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { typecheck: `node -e "process.exit(0)"` } }));
    const prompts: string[] = [];
    let call = 0;
    const outputs = [[{ action: "needs_more_context", file: "src/secret-link.ts" }], []];
    const result = await runAgent("inspect alpha", root, {
      apiKey: "test", maxRetries: 2,
      llmCaller: async messages => {
        prompts.push(JSON.stringify(messages));
        return { content: JSON.stringify(outputs[call++]), tokens: { prompt: 1, output: 1 } };
      },
    });
    assert.equal(result.success, true);
    assert.doesNotMatch(prompts.join("\n"), /TOP_SECRET_CONTEXT_SHOULD_NEVER_APPEAR/);
  });

  it("fails pending stdio requests immediately when the server exits or corrupts the protocol", async () => {
    const root = await temporaryProject();
    const closedServer = path.join(root, "closed.mjs");
    await writeFile(closedServer, `process.exit(7);\n`);
    const closed = startStdioMcpClient(closedServer, { cwd: root, timeoutMs: 10_000 });
    const closedAt = Date.now();
    await assert.rejects(() => closed.request("ping"), /closed|EPIPE/);
    assert.ok(Date.now() - closedAt < 2_000, "early exit must not wait for the request timeout");
    await closed.close();

    const corruptServer = path.join(root, "corrupt.mjs");
    await writeFile(corruptServer, `process.stdin.once("data", () => process.stdout.write("not-json\\n"));\n`);
    const corrupt = startStdioMcpClient(corruptServer, { cwd: root, timeoutMs: 10_000 });
    await assert.rejects(() => corrupt.request("ping"), /malformed JSON/);
    await corrupt.close();
  });
});
