#!/usr/bin/env node
/**
 * Verðandi Auto Capsule — Agent'ın başlamasından ÖNCE çalışır.
 *
 * Görev: Herhangi bir agent'a vermeden önce capsule üretir.
 * Çıktı: Doğrudan prompt'a veya system prompt'a enjekte edilebilir JSON.
 *
 * Usage:
 *   node auto_capsule.mjs <projectRoot> <task> [budgetLevel]
 *
 * Çıktı: Model'in direkt göreceği compact prompt.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { startStdioMcpClient } from "./stdio_mcp_client.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.resolve(__dirname, "../dist/src/mcp_server.js");

const projectRoot = path.resolve(process.cwd(), process.argv[2] || ".");
const task = process.argv[3] || "Analyze this codebase";
const budgetLevel = parseInt(process.argv[4] || "1", 10);

if (!Number.isInteger(budgetLevel) || budgetLevel < 0 || budgetLevel > 3) {
  console.error("ERROR: budgetLevel must be an integer from 0 to 3");
  process.exit(2);
}

if (!existsSync(SERVER_PATH)) {
  console.error("ERROR: dist/src/mcp_server.js not built. Run: npm run build");
  process.exit(1);
}

const client = startStdioMcpClient(SERVER_PATH, { cwd: path.dirname(SERVER_PATH) });
const { request } = client;

try {
  // 1. Initialize
  await request("initialize", { protocolVersion: "2024-11-05" });

  // 2. Generate capsule
  const capsuleResponse = await request("tools/call", {
    name: "context_capsule",
    arguments: { projectRoot, task, preferredBudgetLevel: budgetLevel },
  });
  const capsuleResult = capsuleResponse.structuredContent;
  const capsuleControl = capsuleResponse._meta.control;

  const confidence = capsuleControl.retrieval_confidence;
  const budgetLevelActual = capsuleControl.selected_budget_level;
  const escalation = capsuleControl.silent_escalation;
  const handoff = capsuleControl.handoff_required;
  const tokens = capsuleControl.estimated_payload_tokens;

  // 3. For each symbol in capsule, read the source
  const symbols = capsuleResult.relevant_symbols;
  const symbolSources = [];

  for (const sym of symbols.slice(0, 3)) { // bounded: each read adds another model-visible turn
    try {
      const readResult = (await request("tools/call", {
        name: "read_symbol",
        arguments: {
          projectRoot,
          symbol: sym.symbol,
          fileHint: sym.file,
          maxTokens: 400,
          includeBody: true,
          includeCallGraphNeighbors: false,
        },
      })).structuredContent;

      if (readResult.evidence && readResult.evidence.length > 0) {
        const ev = readResult.evidence[0];
        symbolSources.push({
          symbol: sym.symbol,
          file: sym.file,
          kind: sym.kind,
          hopDistance: sym.hop_distance,
          signature: ev.signature || "",
          source: ev.source || "",
          lines: [ev.startLine, ev.endLine],
        });
      }
    } catch {
      // skip failed reads
    }
  }

  // 4. Output the auto-capsule prompt
  const autoCapsule = {
    goal: capsuleResult.goal,
    symbols: symbolSources,
    files: capsuleResult.probable_files,
    decisions: capsuleResult.decisions,
    criteria: capsuleResult.success_criteria,
    meta: { tokens, budgetLevelActual, escalation, handoff },
  };

  // Print as compact JSON for agent consumption
  console.log(JSON.stringify(autoCapsule, null, 2));

} catch (err) {
  console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await client.close();
}
