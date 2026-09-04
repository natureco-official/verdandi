import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { countTokens } from "../src/token_budget.js";
import { Client, ProtocolError } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const SERVER_PATH = path.resolve(import.meta.dirname, "../dist/src/mcp_server.js");
const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");
const SERVER_INFO_META_KEY = "io.modelcontextprotocol/serverInfo";

function createOfficialClient(modern = false) {
  const client = new Client(
    { name: "verdandi-official-client-conformance", version: "1.0.0" },
    modern
      ? { versionNegotiation: { mode: "auto", probe: { timeoutMs: 2_000, maxRetries: 0 } } }
      : undefined,
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_PATH],
    cwd: PROJECT_ROOT,
    stderr: "pipe",
    // StdioClientTransport ana süreç ortamını olduğu gibi geçirmez; güvenli bir
    // alt küme aktarır. Bu yüzden test koşucusunun VERDANDI_USAGE_LOG=0 ayarı
    // buraya ulaşmıyor ve bu testler depo içindeki kullanım kaydına yazıyordu.
    // Kayıt "gerçek kullanımda ne bozuluyor" sorusu için tutuluyor; test
    // gürültüsü onu işe yaramaz hale getirir.
    env: { ...process.env, VERDANDI_USAGE_LOG: "0" },
  });
  return { client, transport };
}

describe("official @modelcontextprotocol/client stdio compatibility", () => {
  it("completes the legacy initialize, ping, list, and call flow", { timeout: 15_000 }, async () => {
    const { client, transport } = createOfficialClient();
    try {
      await client.connect(transport);
      assert.equal(client.getProtocolEra(), "legacy");
      assert.equal(client.getServerVersion()?.name, "verdandi-context-compiler");
      assert.equal(client.getServerVersion()?.version, "0.2.0");
      const ping = await client.ping();
      assert.deepEqual(ping._meta?.[SERVER_INFO_META_KEY], { name: "verdandi-context-compiler", version: "0.2.0" });

      const { tools } = await client.listTools();
      assert.deepEqual(tools.map(tool => tool.name), [
        "context_capsule",
        "read_symbol",
        "apply_structured_patch",
        "rollback_patch",
        "validate_delta",
        "read_evidence",
      ]);

      const result = await client.callTool({
        name: "context_capsule",
        arguments: { projectRoot: PROJECT_ROOT, task: "official client compatibility", preferredBudgetLevel: 1 },
      });
      assert.equal(result.isError, undefined);
      assert.ok(result.structuredContent && typeof result.structuredContent === "object");
      const evidence = await client.callTool({ name: "read_evidence", arguments: {
        projectRoot: PROJECT_ROOT, file: "src/llm_prompt.ts", maxTokens: 800,
      } });
      const page = evidence.structuredContent as any;
      assert.ok(countTokens(page) <= 800);
      assert.ok(page.ref.startsWith("ev_"));
      const continuation = await client.callTool({ name: "read_evidence", arguments: {
        projectRoot: PROJECT_ROOT, ref: page.ref, offset: page.nextOffset, maxTokens: 800,
      } });
      assert.equal((continuation.structuredContent as any).offset, page.nextOffset);
      assert.equal(result.content[0]?.type, "text");
    } finally {
      await client.close();
      assert.equal(transport.pid, null);
    }
  });

  it("negotiates the 2026-07-28 protocol through server/discover", { timeout: 15_000 }, async () => {
    const { client, transport } = createOfficialClient(true);
    try {
      await client.connect(transport);
      assert.equal(client.getProtocolEra(), "modern");
      assert.equal(client.getNegotiatedProtocolVersion(), "2026-07-28");
      assert.deepEqual(client.getDiscoverResult()?.supportedVersions, ["2026-07-28"]);
      assert.equal(client.getServerVersion()?.name, "verdandi-context-compiler");

      const listed = await client.listTools();
      assert.equal(listed.tools.length, 6);
      assert.deepEqual(listed._meta?.[SERVER_INFO_META_KEY], { name: "verdandi-context-compiler", version: "0.2.0" });

      const result = await client.callTool({
        name: "context_capsule",
        arguments: { projectRoot: PROJECT_ROOT, task: "modern protocol compatibility", preferredBudgetLevel: 1 },
      });
      assert.ok(result.structuredContent && typeof result.structuredContent === "object");
      assert.deepEqual(result._meta?.[SERVER_INFO_META_KEY], { name: "verdandi-context-compiler", version: "0.2.0" });
    } finally {
      await client.close();
      assert.equal(transport.pid, null);
    }
  });

  it("preserves typed JSON-RPC errors in both protocol eras", { timeout: 20_000 }, async () => {
    for (const modern of [false, true]) {
      const { client, transport } = createOfficialClient(modern);
      try {
        await client.connect(transport);
        await assert.rejects(
          client.callTool({ name: "missing-tool", arguments: {} }),
          (error: unknown) => error instanceof ProtocolError && error.code === -32602 && /Unknown tool/.test(error.message),
        );
      } finally {
        await client.close();
        assert.equal(transport.pid, null);
      }
    }
  });
});
