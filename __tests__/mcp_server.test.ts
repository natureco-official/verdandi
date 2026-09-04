import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";

const SERVER_PATH = path.resolve(import.meta.dirname, "../dist/src/mcp_server.js");
const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

function createClient() {
  const child = spawn(process.execPath, [SERVER_PATH], {
    cwd: PROJECT_ROOT,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const lines = createInterface({ input: child.stdout! });
  const pending = new Map<number, (res: JsonRpcResponse) => void>();
  let nextId = 1;
  let killed = false;

  lines.on("line", (line) => {
    const response = JSON.parse(line) as JsonRpcResponse;
    const resolve = pending.get(response.id);
    if (resolve) {
      pending.delete(response.id);
      resolve(response);
    }
  });

  function request(method: string, params: unknown = {}): Promise<unknown> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, (response) => {
        if (response.error) reject(new Error(response.error.message));
        else resolve(response.result);
      });
      child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  function kill() {
    if (killed) return;
    killed = true;
    lines.close();
    child.stdin!.end();
    child.kill();
  }

  return { request, kill };
}

async function rawExchange(line: string): Promise<JsonRpcResponse> {
  const child = spawn(process.execPath, [SERVER_PATH], { cwd: PROJECT_ROOT, stdio: ["pipe", "pipe", "pipe"] });
  const lines = createInterface({ input: child.stdout! });
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("raw MCP timeout")), 5000);
      lines.once("line", output => {
        clearTimeout(timer);
        resolve(JSON.parse(output));
      });
      child.stdin!.write(`${line}\n`);
    });
  } finally {
    lines.close();
    child.kill();
  }
}

describe("MCP Server (stdio JSON-RPC)", () => {
  it("initialize yanitinda serverInfo doner", async () => {
    const { request, kill } = createClient();
    try {
      const result = (await request("initialize", { protocolVersion: "2024-11-05" })) as any;
      assert.equal(result.serverInfo.name, "verdandi-context-compiler");
      assert.equal(result.serverInfo.version, "0.2.0");
      assert.ok(result.capabilities.tools, "tools capability declared");
    } finally {
      kill();
    }
  });

  it("desteklenmeyen legacy initialize surumunu desteklenen surume indirger", async () => {
    const { request, kill } = createClient();
    try {
      const result = (await request("initialize", { protocolVersion: "2099-01-01" })) as any;
      assert.equal(result.protocolVersion, "2025-11-25");
    } finally {
      kill();
    }
  });

  it("modern discovery ve sonuc zarfi alanlarini dogrudan sunar", async () => {
    const discovery = await rawExchange(JSON.stringify({
      jsonrpc: "2.0", id: 20, method: "server/discover", params: {
        _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
      },
    }));
    assert.deepEqual((discovery.result as any).supportedVersions, ["2026-07-28"]);
    assert.equal((discovery.result as any)._meta["io.modelcontextprotocol/serverInfo"].name, "verdandi-context-compiler");

    const list = await rawExchange(JSON.stringify({
      jsonrpc: "2.0", id: 21, method: "tools/list", params: {
        _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
      },
    }));
    assert.equal((list.result as any).resultType, "complete");
    assert.equal((list.result as any).ttlMs, 60_000);
    assert.equal((list.result as any).cacheScope, "public");
  });

  it("desteklenmeyen modern protokol zarfini -32022 ile reddeder", async () => {
    const response = await rawExchange(JSON.stringify({
      jsonrpc: "2.0", id: 22, method: "tools/list", params: {
        _meta: { "io.modelcontextprotocol/protocolVersion": "2027-01-01" },
      },
    }));
    assert.equal(response.error?.code, -32022);
  });

  it("tools/list 6 arac listeler", async () => {
    const { request, kill } = createClient();
    try {
      await request("initialize", {});
      const result = (await request("tools/list")) as any;
      const names = result.tools.map((t: any) => t.name);
      assert.deepEqual(names, [
        "context_capsule",
        "read_symbol",
        "apply_structured_patch",
        "rollback_patch",
        "validate_delta",
        "read_evidence",
      ]);
      assert.ok(result.tools.every((t: any) => t.inputSchema, "all tools have schemas"));
    } finally {
      kill();
    }
  });

  it("context_capsule calisir", async () => {
    const { request, kill } = createClient();
    try {
      await request("initialize", {});
      const result = (await request("tools/call", {
        name: "context_capsule",
        arguments: { projectRoot: PROJECT_ROOT, task: "context capsule uret", preferredBudgetLevel: 1 },
      })) as any;

      assert.ok(result.structuredContent, "structuredContent present");
      assert.ok(result.structuredContent.goal.length > 0);
      assert.equal(result.structuredContent.control, undefined);
      assert.equal(result._meta.schema_version, "0.2.0");
      assert.ok(result._meta.task_id.length > 0);
      assert.ok(result._meta.control.estimated_payload_tokens > 0);
    } finally {
      kill();
    }
  });

  it("read_symbol calisir", async () => {
    const { request, kill } = createClient();
    try {
      await request("initialize", {});
      const result = (await request("tools/call", {
        name: "read_symbol",
        arguments: { projectRoot: PROJECT_ROOT, symbol: "TypeScriptContextCompiler", fileHint: "context_compiler" },
      })) as any;

      assert.ok(result.structuredContent.evidence.length >= 1);
      assert.equal(result.structuredContent.evidence[0].symbol.symbol, "TypeScriptContextCompiler");
      assert.ok(result.structuredContent.snapshot.length > 0);
    } finally {
      kill();
    }
  });

  it("validate_delta calisir", async () => {
    const { request, kill } = createClient();
    try {
      await request("initialize", {});
      const result = (await request("tools/call", {
        name: "validate_delta",
        arguments: { projectRoot: PROJECT_ROOT, taskId: "server-test-01", kinds: ["build"], commandProfile: "package-scripts" },
      })) as any;

      assert.equal(result.structuredContent.passed, true);
      assert.ok(result.structuredContent.checks.length >= 1);
    } finally {
      kill();
    }
  });

  it("bilinmeyen tool icin hata doner", async () => {
    const { request, kill } = createClient();
    try {
      await request("initialize", {});
      await assert.rejects(() => request("tools/call", { name: "nonexistent", arguments: {} }), /Unknown tool/);
    } finally {
      kill();
    }
  });

  it("bilinmeyen method icin -32601 hatasi doner", async () => {
    const { request, kill } = createClient();
    try {
      await request("initialize", {});
      await assert.rejects(() => request("unknown/method", {}), /Method not found/);
    } finally {
      kill();
    }
  });

  it("gecersiz veya eksik param icin -32602 hatasi doner", async () => {
    const { request, kill } = createClient();
    try {
      await request("initialize", {});
      // Test all 5 tools with missing required parameters
      await assert.rejects(
        () => request("tools/call", { name: "context_capsule", arguments: {} }),
        /Invalid params: Missing required parameter: 'task'/
      );
      await assert.rejects(
        () => request("tools/call", { name: "context_capsule", arguments: { task: "test" } }),
        /Invalid params: Missing required parameter: 'projectRoot'/
      );
      await assert.rejects(
        () => request("tools/call", { name: "read_symbol", arguments: {} }),
        /Invalid params: Missing required parameter: 'projectRoot'/
      );
      await assert.rejects(
        () => request("tools/call", { name: "read_symbol", arguments: { projectRoot: "/test" } }),
        /Invalid params: Missing required parameter: 'symbol'/
      );
      await assert.rejects(
        () => request("tools/call", { name: "apply_structured_patch", arguments: {} }),
        /Invalid params: Missing required parameter: 'projectRoot'/
      );
      await assert.rejects(
        () => request("tools/call", { name: "apply_structured_patch", arguments: { projectRoot: "/test" } }),
        /Invalid params: Missing required parameter: 'taskId'/
      );
      await assert.rejects(
        () => request("tools/call", { name: "rollback_patch", arguments: {} }),
        /Invalid params: Missing required parameter: 'projectRoot'/
      );
      await assert.rejects(
        () => request("tools/call", { name: "rollback_patch", arguments: { projectRoot: "/test" } }),
        /Invalid params: Missing required parameter: 'rollbackToken'/
      );
      await assert.rejects(
        () => request("tools/call", { name: "validate_delta", arguments: {} }),
        /Invalid params: Missing required parameter: 'projectRoot'/
      );
      await assert.rejects(
        () => request("tools/call", { name: "validate_delta", arguments: { projectRoot: "/test" } }),
        /Invalid params: Missing required parameter: 'taskId'/
      );
    } finally {
      kill();
    }
  });

  it("yanlis type icin -32602 hatasi doner", async () => {
    const { request, kill } = createClient();
    try {
      await request("initialize", {});
      // Test type validation for each tool
      await assert.rejects(
        () => request("tools/call", { name: "context_capsule", arguments: { task: 123, projectRoot: "/test" } }),
        /Invalid type for 'task': expected string/
      );
      await assert.rejects(
        () => request("tools/call", { name: "read_symbol", arguments: { projectRoot: "/test", symbol: 123 } }),
        /Invalid type for 'symbol': expected string/
      );
      await assert.rejects(
        () => request("tools/call", { name: "validate_delta", arguments: { projectRoot: "/test", taskId: "x", kinds: "not-array" } }),
        /Invalid type for 'kinds': expected array/
      );
    } finally {
      kill();
    }
  });

  it("notifications/initialized sessizce gecer", async () => {
    const { request, kill } = createClient();
    try {
      await request("initialize", {});
      // notification doesn't produce a response — just verify no crash
      // The server skips notifications (id === undefined) silently
      const child = spawn(process.execPath, [SERVER_PATH], {
        cwd: PROJECT_ROOT,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const lines = createInterface({ input: child.stdout! });

      // Send initialize first
      child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");

      // Wait for response, then send notification
      await new Promise<void>((resolve) => {
        lines.on("line", () => {
          // Got first response, now send notification (no id field)
          child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
          // If server doesn't crash, test passes
          setTimeout(() => {
            lines.close();
            child.kill();
            resolve();
          }, 200);
        });
      });
    } finally {
      kill();
    }
  });

  it("bozuk JSON ve request zarflarina standart JSON-RPC kodlari doner", async () => {
    const parseError = await rawExchange("{not-json");
    assert.equal(parseError.error?.code, -32700);

    const invalidRequest = await rawExchange(JSON.stringify({ jsonrpc: "1.0", id: 7, method: "ping" }));
    assert.equal(invalidRequest.error?.code, -32600);

    const invalidParams = await rawExchange(JSON.stringify({ jsonrpc: "2.0", id: 8, method: "ping", params: "bad" }));
    assert.equal(invalidParams.error?.code, -32602);

    const invalidId = await rawExchange(JSON.stringify({ jsonrpc: "2.0", id: { unsafe: true }, method: "ping" }));
    assert.equal(invalidId.error?.code, -32600);
  });

  it("bilinmeyen tool'u Invalid Params olarak siniflandirir", async () => {
    const response = await rawExchange(JSON.stringify({
      jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "missing", arguments: {} },
    }));
    assert.equal(response.error?.code, -32602);
  });

  it("duplicate validation kind ve asiri read budgetini semada reddeder", async () => {
    const duplicateKinds = await rawExchange(JSON.stringify({
      jsonrpc: "2.0", id: 10, method: "tools/call", params: {
        name: "validate_delta",
        arguments: { projectRoot: PROJECT_ROOT, taskId: "x", kinds: ["test", "test"], commandProfile: "package-scripts" },
      },
    }));
    assert.equal(duplicateKinds.error?.code, -32602);

    const excessiveRead = await rawExchange(JSON.stringify({
      jsonrpc: "2.0", id: 11, method: "tools/call", params: {
        name: "read_symbol", arguments: { projectRoot: PROJECT_ROOT, symbol: "tokenize", maxTokens: 4001 },
      },
    }));
    assert.equal(excessiveRead.error?.code, -32602);

    const excessiveTask = await rawExchange(JSON.stringify({
      jsonrpc: "2.0", id: 12, method: "tools/call", params: {
        name: "context_capsule", arguments: { projectRoot: PROJECT_ROOT, task: "x".repeat(20_001) },
      },
    }));
    assert.equal(excessiveTask.error?.code, -32602);
  });
});
