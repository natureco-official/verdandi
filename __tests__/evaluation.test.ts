import assert from "node:assert/strict";
import { it } from "node:test";
import { compareRuns, totalUsage, type EvaluationRun } from "../src/evaluation.js";

const run = (): EvaluationRun => ({ taskId: "invoice", repetition: 1, model: "fixed-model", baseCommit: "fixed-commit", oracleId: "behavior-v1",
  passed: true, protectedInputsUnchanged: true, requests: [{ input: 1000, output: 100, cacheRead: 900, cacheWrite: 0, inputIncludesCache: true }] });

it("counts inclusive cache once and refuses to manufacture missing usage", () => {
  const sample = run();
  assert.equal(totalUsage(sample), 1100);
  sample.requests[0].inputIncludesCache = false;
  assert.equal(totalUsage(sample), 2000);
  sample.requests[0].cacheRead = null;
  assert.equal(totalUsage(sample), null);
});

it("keeps a cheap quality regression visible and rejects mismatched experiments", () => {
  const before = run(), after = run();
  after.passed = false;
  after.requests[0].input = 10;
  const report = compareRuns([before], [after]);
  assert.equal(report.accepted, false);
  assert.equal(report.qualityRegressions, 1);
  after.model = "another-model";
  assert.throws(() => compareRuns([before], [after]), /Incomparable/);
  assert.throws(() => compareRuns([before], []), /coverage/);
});

it("does not accept changed evaluation inputs or unmeasured candidates", () => {
  const after = run();
  after.protectedInputsUnchanged = false;
  assert.equal(compareRuns([run()], [after]).accepted, false);
  after.protectedInputsUnchanged = true;
  after.requests[0].input = null;
  assert.equal(compareRuns([run()], [after]).unmeasuredCases, 1);
  assert.equal(compareRuns([run()], [after]).accepted, false);
});
