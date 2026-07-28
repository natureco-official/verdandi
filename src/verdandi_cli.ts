#!/usr/bin/env node
/**
 * Verðandi Agent CLI
 *
 * Usage:
 *   verdandi-agent "Import sıralamasını düzelt" --project /path --model gpt-4o
 */
import { runAgent } from "./verdandi_agent.js";

const args = process.argv.slice(2);
const flags: Record<string, string> = {};
let task = "";

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--project" || args[i] === "-p") {
    flags.project = args[++i];
  } else if (args[i] === "--model" || args[i] === "-m") {
    flags.model = args[++i];
  } else if (args[i] === "--api-key") {
    flags.apiKey = args[++i];
  } else if (args[i] === "--base-url") {
    flags.baseUrl = args[++i];
  } else if (args[i] === "--max-retries") {
    flags.maxRetries = args[++i];
  } else if (args[i] === "--verbose" || args[i] === "-v") {
    flags.verbose = "true";
  } else if (args[i] === "--dry-run") {
    flags.dryRun = "true";
  } else if (args[i] === "--help" || args[i] === "-h") {
    console.log(`
Verðandi Agent — Token-efficient task context agent

Usage:
  verdandi-agent <task> [options]

Options:
  --project, -p <path>     Project root (default: cwd)
  --model, -m <model>      LLM model (default: gpt-4o)
  --api-key <key>          API key (or VERDANDI_API_KEY env)
  --base-url <url>         API base URL (default: OpenAI)
  --max-retries <n>        Max retries (default: 3)
  --verbose, -v            Verbose output
  --dry-run                Show edits without applying
  --help, -h               Show this help

Environment:
  VERDANDI_API_KEY / URDR_API_KEY   API key
  VERDANDI_MODEL / URDR_MODEL       Model name
  VERDANDI_BASE_URL                 API base URL

Examples:
  verdandi-agent "Fix import sorting" --project ./my-app
  verdandi-agent "Add error handling" -m claude-sonnet-4-20250514 --verbose
`);
    process.exit(0);
  } else if (!args[i].startsWith("-")) {
    task = args[i];
  }
}

if (!task) {
  console.error("Error: No task specified. Run with --help for usage.");
  process.exit(1);
}

const config = {
  apiKey: flags.apiKey || process.env.VERDANDI_API_KEY || process.env.URDR_API_KEY || "",
  model: flags.model || process.env.VERDANDI_MODEL || process.env.URDR_MODEL || "gpt-4o",
  baseUrl: flags.baseUrl || process.env.VERDANDI_BASE_URL || process.env.URDR_BASE_URL || "https://api.openai.com/v1",
  maxRetries: parseInt(flags.maxRetries || "3", 10),
  verbose: flags.verbose === "true" || process.env.VERDANDI_VERBOSE === "1" || process.env.URDR_VERBOSE === "1",
  dryRun: flags.dryRun === "true",
};

const projectRoot = flags.project || process.cwd();

console.error(`🌿 Verðandi Agent v0.2.0 (Present Task Context)`);
console.error(`   Task:     ${task.substring(0, 60)}${task.length > 60 ? "..." : ""}`);
console.error(`   Project:  ${projectRoot}`);
console.error(`   Model:    ${config.model}`);
console.error(`   Dry run:  ${config.dryRun}`);
console.error(``);

const result = await runAgent(task, projectRoot, config);

console.error(`\n${"─".repeat(60)}`);

if (result.success) {
  console.error(`✅ Success (${Math.round(result.durationMs / 1000)}s)`);
  console.error(`   Edits: ${result.edits.length}`);
  if (result.validated) {
    console.error(`   Validation: ${result.validationPassed ? "PASSED ✅" : "FAILED ❌"}`);
  }
} else {
  console.error(`❌ Failed (${Math.round(result.durationMs / 1000)}s)`);
  console.error(`   Error: ${result.error}`);
  if (result.handoffRequired) {
    console.error(`   ⚠️  Handoff required — manual intervention needed`);
  }
}

console.error(`   Tokens: ${result.tokenEstimate.prompt} prompt + ${result.tokenEstimate.output} output = ${result.tokenEstimate.total} total`);
console.error(`   Diagnostics: ${result.diagnostics.length}`);

// Output result as JSON to stdout
console.log(JSON.stringify(result, null, 2));

process.exit(result.success ? 0 : 1);
