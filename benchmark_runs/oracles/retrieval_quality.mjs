import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TypeScriptContextCompiler } from "../../src/context_compiler.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const benchmarkRoot = path.resolve(here, "..");
const worktreeBase = process.env.CAPSULE_WORKTREE_BASE || "/private/tmp/capsule-baseline-worktrees";
const groundTruth = JSON.parse(await readFile(path.join(benchmarkRoot, "retrieval_ground_truth.json"), "utf8"));
const compiler = new TypeScriptContextCompiler();
const rows = [];

for (const task of groundTruth.tasks) {
  const projectRoot = path.join(worktreeBase, `${task.id}-codex-capsule`);
  await access(projectRoot);
  const prompt = (await readFile(path.join(benchmarkRoot, "prompts", `${task.id}.txt`), "utf8")).trim();
  const capsule = await compiler.context_capsule({
    task: prompt,
    projectRoot,
    preferredBudgetLevel: 3,
    maxModelPayloadTokens: 1200,
  });
  const files = capsule.modelPayload.probableFiles;
  const symbols = capsule.modelPayload.relevantSymbols.map(symbol => `${symbol.symbol} @ ${symbol.file}`);
  const matchedGroups = task.primaryFileGroups.filter(group => group.some(file => files.includes(file))).length;
  const acceptable = new Set(task.acceptableFiles);
  const acceptableHits = files.filter(file => acceptable.has(file)).length;
  const symbolHits = task.symbolPatterns.filter(pattern => {
    const expression = new RegExp(pattern, "i");
    return symbols.some(symbol => expression.test(symbol));
  }).length;
  rows.push({
    id: task.id,
    topFile: files[0],
    hitAt1: task.primaryFileGroups.some(group => group.includes(files[0])),
    matchedGroups,
    totalGroups: task.primaryFileGroups.length,
    acceptableHits,
    returnedFiles: files.length,
    symbolHits,
    totalSymbolPatterns: task.symbolPatterns.length,
  });
}

const sum = key => rows.reduce((total, row) => total + row[key], 0);
const metrics = {
  hitAt1: rows.filter(row => row.hitAt1).length / rows.length,
  primaryGroupRecall: sum("matchedGroups") / sum("totalGroups"),
  acceptableFilePrecision: sum("acceptableHits") / sum("returnedFiles"),
  symbolGroupRecall: sum("symbolHits") / sum("totalSymbolPatterns"),
};
const thresholds = {
  hitAt1: 0.9,
  primaryGroupRecall: 0.9,
  acceptableFilePrecision: 0.5,
  symbolGroupRecall: 0.85,
};
const failed = Object.entries(thresholds).filter(([name, minimum]) => metrics[name] < minimum);

console.log(JSON.stringify({ schemaVersion: 1, worktreeBase, metrics, thresholds, rows }, null, 2));
if (failed.length > 0) {
  console.error(`retrieval quality threshold failed: ${failed.map(([name]) => name).join(", ")}`);
  process.exitCode = 1;
}
