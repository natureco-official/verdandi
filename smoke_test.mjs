import path from "node:path";
import { fileURLToPath } from "node:url";
import { startStdioMcpClient } from "./src/stdio_mcp_client.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const capsuleRoot = path.resolve(__dirname, ".");
const projectRoot = process.argv[2] ?? capsuleRoot;
const client = startStdioMcpClient(path.join(capsuleRoot, "dist/src/mcp_server.js"), { cwd: capsuleRoot });
const { request } = client;

try {
  const initialized = await request("initialize", { protocolVersion: "2024-11-05" });
  const listed = await request("tools/list");

  // 1. context_capsule — kendi projemizde test et
  const capsuleResponse = await request("tools/call", {
    name: "context_capsule",
    arguments: {
      projectRoot,
      task: "TypeScript context compiler'daki sembol indeksleme mantigini incele ve iyilestir",
      preferredBudgetLevel: 1,
    },
  });
  const capsule = capsuleResponse.structuredContent;
  const capsuleMeta = capsuleResponse._meta;

  // 2. read_symbol — projedeki bir sembolü oku
  const read = (await request("tools/call", {
    name: "read_symbol",
    arguments: { projectRoot, symbol: "TypeScriptContextCompiler", fileHint: "context_compiler", maxTokens: 180 },
  })).structuredContent;

  let patchResult = null;
  if (read.evidence && read.evidence.length > 0) {
    const first = read.evidence[0];
    // 3. apply_structured_patch — dryRun ile test et
    patchResult = (await request("tools/call", {
      name: "apply_structured_patch",
      arguments: {
        projectRoot,
        taskId: capsuleMeta.task_id,
        snapshot: read.snapshot,
        language: "typescript",
        dryRun: true,
        operations: [{
          operation: "replace_symbol",
          file: first.symbol.file,
          symbol: first.symbol.symbol,
          replacement: first.source,
          precondition: { file: first.symbol.file, contentHash: first.fileContentHash, symbol: first.symbol.symbol, symbolHash: first.contentHash },
        }],
      },
    })).structuredContent;
  }

  // 4. validate_delta — kendi build'imizi dogrula
  const validation = (await request("tools/call", {
    name: "validate_delta",
    arguments: { projectRoot: capsuleRoot, taskId: "smoke-self-test", kinds: ["build"], commandProfile: "package-scripts" },
  })).structuredContent;

  console.log(JSON.stringify({
    initialize: initialized.serverInfo,
    tools: listed.tools.map(tool => tool.name),
    capsule: {
      taskId: capsuleMeta.task_id,
      files: capsule.probable_files,
      symbols: capsule.relevant_symbols.map(symbol => `${symbol.symbol} @ ${symbol.file}`),
      estimatedPayloadTokens: capsuleMeta.control.estimated_payload_tokens,
      confidence: capsuleMeta.control.retrieval_confidence,
    },
    readSymbol: read.evidence.length > 0 ? {
      symbol: read.evidence[0].symbol,
      lines: [read.evidence[0].startLine, read.evidence[0].endLine],
      contentHash: read.evidence[0].contentHash,
      estimatedTokens: read.estimatedTokens,
    } : { note: "No evidence found" },
    structuredPatchDryRun: patchResult ? {
      applied: patchResult.applied,
      changedFiles: patchResult.changedFiles,
      diagnostics: patchResult.diagnostics,
    } : { note: "Skipped — no evidence to patch" },
    validateDelta: validation,
  }, null, 2));
} finally {
  await client.close();
}
