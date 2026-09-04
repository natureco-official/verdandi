#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { compareRuns } from "../dist/src/evaluation.js";

if (process.argv.length < 4) {
  console.error("Usage: node scripts/compare_runs.mjs baseline.json candidate.json [targetTokens]");
  process.exit(2);
}
const baseline = JSON.parse(await readFile(process.argv[2], "utf8"));
const candidate = JSON.parse(await readFile(process.argv[3], "utf8"));
const report = compareRuns(baseline, candidate, Number(process.argv[4] ?? 10000));
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.accepted ? 0 : 1;
