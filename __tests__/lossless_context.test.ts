import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { TypeScriptContextCompiler } from "../src/context_compiler.js";
import { contentHash, replaceFileSafely, withProjectMutation } from "../src/safe_files.js";
import { countTokens } from "../src/token_budget.js";
import { runAgent } from "../src/verdandi_agent.js";

async function fixture(action: (root: string) => Promise<void>, source = "export function alpha() { return 1; }\n") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "verdandi-lossless-"));
  try {
    await fs.writeFile(path.join(root, "a.ts"), source);
    await action(root);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

async function patch(compiler: TypeScriptContextCompiler, root: string) {
  const read = await compiler.read_symbol({ projectRoot: root, fileHint: "a.ts", symbol: "alpha" });
  return compiler.apply_structured_patch({
    projectRoot: root, taskId: "test", language: "typescript", snapshot: read.snapshot,
    operations: [{ operation: "replace_function_body", file: "a.ts", symbol: "alpha", newBody: "{ return 2; }", precondition: {
      file: "a.ts", contentHash: read.evidence[0].fileContentHash!, symbolHash: read.evidence[0].contentHash,
    } }],
  });
}

describe("lossless context and mutation safety", () => {
  it("reconstructs Unicode and escaped single-line code within the COMPLETE response budget", async () => {
    const source = `export const text = ${JSON.stringify('Türkçe 😄 漢字 \\"\n'.repeat(600))};\n`;
    await fixture(async root => {
      const compiler = new TypeScriptContextCompiler();
      let page = await compiler.read_evidence({ projectRoot: root, file: "a.ts", maxTokens: 350 });
      let restored = "";
      let pages = 0;
      while (true) {
        assert.ok(countTokens(page) <= 350);
        assert.ok(page.nextOffset > page.offset || page.done);
        restored += page.source;
        if (page.done) break;
        assert.ok(++pages < 1000);
        page = await compiler.read_evidence({ projectRoot: root, ref: page.ref, offset: page.nextOffset, maxTokens: 350 });
      }
      assert.equal(restored, source);
    }, source);
  });

  it("preserves old evidence after source changes and server restart", async () => {
    await fixture(async root => {
      const compiler = new TypeScriptContextCompiler();
      const first = await compiler.read_evidence({ projectRoot: root, file: "a.ts" });
      await fs.writeFile(path.join(root, "a.ts"), "export const changed = true;\n");
      const restarted = new TypeScriptContextCompiler();
      const recovered = await restarted.read_evidence({ projectRoot: root, ref: first.ref });
      assert.equal(recovered.source, first.source);
      const fresh = await restarted.read_evidence({ projectRoot: root, file: "a.ts", knownRef: first.ref });
      assert.notEqual(fresh.ref, first.ref);
      assert.notEqual(fresh.unchanged, true);
      const known = await restarted.read_evidence({ projectRoot: root, file: "a.ts", knownRef: fresh.ref });
      assert.equal(known.unchanged, true);
      const afterCompaction = await restarted.read_evidence({ projectRoot: root, ref: fresh.ref });
      assert.equal(afterCompaction.source, fresh.source, "absence of caller acknowledgement must rehydrate");
    });
  });

  it("rejects tampered artifacts, foreign projects and invalid continuation", async () => {
    await fixture(async root => {
      const compiler = new TypeScriptContextCompiler();
      const page = await compiler.read_evidence({ projectRoot: root, file: "a.ts" });
      await assert.rejects(() => compiler.read_evidence({ projectRoot: root, ref: page.ref, offset: 99999 }), /offset/);
      await assert.rejects(() => compiler.read_evidence({ projectRoot: root, file: "../a.ts" }), /indexed/);
      await fixture(async other => {
        await fs.mkdir(path.join(other, ".verdandi/evidence"), { recursive: true });
        await fs.copyFile(path.join(root, ".verdandi/evidence", `${page.ref}.json`), path.join(other, ".verdandi/evidence", `${page.ref}.json`));
        await assert.rejects(() => compiler.read_evidence({ projectRoot: other, ref: page.ref }), /another project/);
      });
      await fs.appendFile(path.join(root, ".verdandi/evidence", `${page.ref}.json`), " ");
      await assert.rejects(() => compiler.read_evidence({ projectRoot: root, ref: page.ref }), /integrity/);
    });
  });

  it("does not truncate the source on a failed temporary write", async t => {
    await fixture(async root => {
      const file = path.join(root, "a.ts");
      const before = await fs.readFile(file, "utf8");
      const open = fs.open.bind(fs);
      const stub = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
        const handle = await open(...args);
        const write = handle.writeFile.bind(handle);
        handle.writeFile = async () => {
          await write("PARTIAL");
          throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
        };
        return handle;
      });
      try { await assert.rejects(() => replaceFileSafely(file, "changed", contentHash(before)), /disk full/); }
      finally { stub.mock.restore(); }
      assert.equal(await fs.readFile(file, "utf8"), before);
      assert.deepEqual(await fs.readdir(root), ["a.ts"]);
    });
  });

  it("retains recovery journal on a failed publish and rejects a foreign rollback", async t => {
    await fixture(async root => {
      const compiler = new TypeScriptContextCompiler();
      const rename = fs.rename.bind(fs);
      const stub = t.mock.method(fs, "rename", async (from: any, to: any) => {
        if (to === path.join(root, "a.ts")) throw new Error("publish failed");
        return rename(from, to);
      });
      let result;
      try { result = await patch(compiler, root); } finally { stub.mock.restore(); }
      assert.equal(result.applied, false);
      assert.ok(result.rollbackToken);
      assert.equal((await fs.readdir(path.join(root, ".verdandi/rollbacks"))).length, 1);
      assert.equal((await compiler.rollback_patch({ projectRoot: root, rollbackToken: result.rollbackToken! })).reverted, true);
      const applied = await patch(compiler, root);
      await fixture(async other => {
        await fs.writeFile(path.join(other, "a.ts"), await fs.readFile(path.join(root, "a.ts")));
        const foreign = await compiler.rollback_patch({ projectRoot: other, rollbackToken: applied.rollbackToken! });
        assert.equal(foreign.reverted, false);
        assert.match(await fs.readFile(path.join(other, "a.ts"), "utf8"), /return 2/);
      });
      assert.equal((await new TypeScriptContextCompiler().rollback_patch({ projectRoot: root, rollbackToken: applied.rollbackToken! })).reverted, true);
    });
  });

  it("serializes independent mutation owners without stealing their lock", async () => {
    await fixture(async root => {
      await withProjectMutation(root, async () => {
        await assert.rejects(() => withProjectMutation(root, async () => {}), /locked/);
      });
      await withProjectMutation(root, async () => {});
    });
  });

  it("does not claim completion for an unverified empty edit list", async () => {
    await fixture(async root => {
      const result = await runAgent("alpha must return 2", root, {
        apiKey: "test", maxRetries: 1,
        llmCaller: async () => ({ content: "[]", tokens: { prompt: 1, output: 1 } }),
      });
      assert.equal(result.success, false);
      assert.match(result.error!, /unverified/);
      assert.match(await fs.readFile(path.join(root, "a.ts"), "utf8"), /return 1/);
    });
  });

  it("expands an already seen file, and checks every retry prompt budget", async () => {
    const source = `export function alpha() {\n${'// unrelated filler text\n'.repeat(150)}return 1;\n}\n`;
    await fixture(async root => {
      const prompts: string[] = [];
      const result = await runAgent("inspect alpha", root, {
        apiKey: "test", maxRetries: 2, maxPromptTokens: 2600,
        taskVerifier: async () => ({ passed: true }),
        llmCaller: async messages => {
          prompts.push(JSON.stringify(messages));
          return { content: prompts.length === 1 ? '[{"action":"needs_more_context","file":"a.ts"}]' : '[]', tokens: { prompt: 1, output: 1 } };
        },
      });
      assert.equal(result.success, true);
      assert.equal(prompts.length, 2);
      assert.ok(prompts.every(prompt => countTokens(prompt) <= 2600));
      assert.doesNotMatch(result.diagnostics.join(" "), /Repeated context request refused/);
      assert.notEqual(prompts[0], prompts[1]);
    }, source);
  });
});

it("keeps the API timeout active while reading a stalled response body", async () => {
  const { createServer } = await import("node:http");
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.flushHeaders();
    response.write('{"choices":');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const previous = process.env.VERDANDI_REQUEST_TIMEOUT_MS;
  process.env.VERDANDI_REQUEST_TIMEOUT_MS = "1000";
  try {
    await fixture(async root => {
      const address = server.address() as { port: number };
      const start = Date.now();
      const result = await runAgent("inspect alpha", root, { apiKey: "local-test", maxRetries: 1, baseUrl: `http://127.0.0.1:${address.port}` });
      assert.equal(result.success, false);
      assert.ok(Date.now() - start < 5000);
      assert.equal(result.usage?.requests[0].status, "failed");
    });
  } finally {
    if (previous === undefined) delete process.env.VERDANDI_REQUEST_TIMEOUT_MS;
    else process.env.VERDANDI_REQUEST_TIMEOUT_MS = previous;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

it("stops before another request when the total token allowance is exhausted", async () => {
  await fixture(async root => {
    let calls = 0;
    const result = await runAgent("inspect alpha", root, {
      apiKey: "test", maxRetries: 5, maxTotalTokens: 900, maxOutputTokens: 300,
      llmCaller: async () => { calls++; return { content: "not json", tokens: { prompt: 0, output: 0 } }; },
    });
    assert.equal(result.success, false);
    assert.ok(calls < 5);
    assert.match(result.diagnostics.join(" "), /budget exhausted/);
  });
});

it("reconstructs exact changes from a paged delta and rejects stale bases", async () => {
  const { applyEvidenceDelta } = await import("../src/evidence_delta.js");
  await fixture(async root => {
    const compiler = new TypeScriptContextCompiler();
    const first = await compiler.read_evidence({ projectRoot: root, file: "a.ts" });
    const before = first.source;
    const after = `export const emoji = "😳${'Türkçe '.repeat(200)}";\n`;
    await fs.writeFile(path.join(root, "a.ts"), after);
    let delta = await compiler.read_evidence({ projectRoot: root, file: "a.ts", previousRef: first.ref, maxTokens: 350 });
    assert.equal(delta.kind, "delta");
    let text = "";
    while (true) {
      assert.ok(countTokens(delta) <= 350);
      assert.equal(countTokens(delta), delta.tokenCount);
      text += delta.source;
      if (delta.done) break;
      delta = await compiler.read_evidence({ projectRoot: root, ref: delta.ref, offset: delta.nextOffset, maxTokens: 350 });
    }
    const change = JSON.parse(text);
    assert.equal(applyEvidenceDelta(before, change), after);
    assert.throws(() => applyEvidenceDelta("stale", change), /base hash/);
    assert.throws(() => applyEvidenceDelta(before, { ...change, insert: "tampered" }), /target hash/);
  });
});

it("does not apply a model edit over source changed after its prompt", async () => {
  await fixture(async root => {
    const result = await runAgent("make alpha return 2", root, {
      apiKey: "test", maxRetries: 1,
      llmCaller: async () => {
        await fs.writeFile(path.join(root, "a.ts"), "export function alpha() { return 99; }\n");
        return { content: '[{"file":"a.ts","symbol":"alpha","operation":"replace_symbol","newCode":"export function alpha() { return 2; }"}]', tokens: { prompt: 1, output: 1 } };
      },
    });
    assert.equal(result.success, false);
    assert.match(result.diagnostics.join(" "), /Project changed since model evidence/);
    assert.match(await fs.readFile(path.join(root, "a.ts"), "utf8"), /return 99/);
  });
});

it("requires the hidden tail before replacing a long symbol, then accepts complete pages", async () => {
  const source = `export function alpha() {\n${'// filler preserved in a full replacement\n'.repeat(120)}return 1;\n}\n`;
  await fixture(async root => {
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: {
      test: 'node -e "process.exit(0)"', lint: 'node -e "process.exit(0)"', typecheck: 'node -e "process.exit(0)"',
    } }));
    const premature = await runAgent("make alpha return 2", root, {
      apiKey: "test", maxRetries: 1,
      llmCaller: async () => ({ content: '[{"file":"a.ts","symbol":"alpha","operation":"replace_symbol","newCode":"export function alpha() { return 2; }"}]', tokens: { prompt: 1, output: 1 } }),
    });
    assert.equal(premature.success, false);
    assert.equal(await fs.readFile(path.join(root, "a.ts"), "utf8"), source);
    let call = 0;
    const complete = await runAgent("make alpha return 2", root, {
      apiKey: "test", maxRetries: 2, maxPromptTokens: 5000,
      llmCaller: async () => ({
        content: ++call === 1 ? '[{"action":"needs_more_context","file":"a.ts","symbol":"alpha"}]'
          : JSON.stringify([{ file: "a.ts", symbol: "alpha", operation: "replace_symbol", newCode: source.replace("return 1", "return 2").trimEnd() }]),
        tokens: { prompt: 1, output: 1 },
      }),
    });
    assert.equal(complete.success, true, JSON.stringify(complete));
    assert.equal(await fs.readFile(path.join(root, "a.ts"), "utf8"), source.replace("return 1", "return 2"));
  }, source);
});

it("reports and retains partially published files when automatic restoration also fails", async t => {
  await fixture(async root => {
    await fs.writeFile(path.join(root, "b.ts"), "export function beta() { return 1; }\n");
    const compiler = new TypeScriptContextCompiler();
    const a = await compiler.read_symbol({ projectRoot: root, fileHint: "a.ts", symbol: "alpha" });
    const b = await compiler.read_symbol({ projectRoot: root, fileHint: "b.ts", symbol: "beta" });
    let firstPublished = false;
    const rename = fs.rename.bind(fs);
    const stub = t.mock.method(fs, "rename", async (from: any, to: any) => {
      if (to === path.join(root, "b.ts") || (to === path.join(root, "a.ts") && firstPublished)) throw new Error("filesystem unavailable");
      if (to === path.join(root, "a.ts")) firstPublished = true;
      return rename(from, to);
    });
    let result;
    try {
      result = await compiler.apply_structured_patch({ projectRoot: root, taskId: "partial", snapshot: a.snapshot, language: "typescript",
        operations: [["a.ts", "alpha", a], ["b.ts", "beta", b]].map(([file, symbol, read]: any) => ({
          operation: "replace_function_body", file, symbol, newBody: "{ return 2; }",
          precondition: { file, contentHash: read.evidence[0].fileContentHash },
        })),
      });
    } finally { stub.mock.restore(); }
    assert.equal(result.applied, false);
    assert.deepEqual(result.changedFiles, ["a.ts"]);
    assert.ok(result.rollbackToken);
    assert.match(await fs.readFile(path.join(root, "a.ts"), "utf8"), /return 2/);
    const recovered = await new TypeScriptContextCompiler().rollback_patch({ projectRoot: root, rollbackToken: result.rollbackToken! });
    assert.equal(recovered.reverted, true);
    assert.match(await fs.readFile(path.join(root, "a.ts"), "utf8"), /return 1/);
  });
});
