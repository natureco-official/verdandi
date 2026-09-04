/** Provider-neutral task accounting. Cache inclusion must be explicit. */
export interface EvaluationRun {
  taskId: string;
  repetition: number;
  baseCommit: string;
  model: string;
  oracleId: string;
  passed: boolean;
  protectedInputsUnchanged: boolean;
  requests: Array<{
    input: number | null;
    output: number | null;
    cacheRead: number | null;
    cacheWrite: number | null;
    inputIncludesCache: boolean;
  }>;
}

export function totalUsage(run: EvaluationRun): number | null {
  if (!run.requests.length) return null;
  let total = 0;
  for (const request of run.requests) {
    if (typeof request.inputIncludesCache !== "boolean") return null;
    const fields = request.inputIncludesCache
      ? [request.input, request.output]
      : [request.input, request.output, request.cacheRead, request.cacheWrite];
    if (fields.some(value => typeof value !== "number" || !Number.isFinite(value) || value < 0)) return null;
    total += (fields as number[]).reduce((a, b) => a + b, 0);
  }
  return total;
}

/** Every baseline case must have a candidate; failure cases are never discarded. */
export function compareRuns(baseline: EvaluationRun[], candidate: EvaluationRun[], targetTokens = 10_000) {
  if (!Number.isFinite(targetTokens) || targetTokens <= 0) throw new RangeError("Positive token target required");
  const key = (run: EvaluationRun) => `${run.taskId}:${run.repetition}`;
  if (!baseline.length || new Set(baseline.map(key)).size !== baseline.length || new Set(candidate.map(key)).size !== candidate.length) {
    throw new Error("Non-empty, uniquely keyed evaluation runs required");
  }
  const byKey = new Map(candidate.map(run => [key(run), run]));
  if (candidate.length !== baseline.length) throw new Error("Unequal evaluation coverage");
  const cases = baseline.map(before => {
    const after = byKey.get(key(before));
    if (!after) throw new Error(`Missing candidate: ${key(before)}`);
    if (["baseCommit", "model", "oracleId"].some(field => before[field as keyof EvaluationRun] !== after[field as keyof EvaluationRun])) {
      throw new Error(`Incomparable run: ${key(before)}`);
    }
    if (!before.baseCommit || !before.model || !before.oracleId) throw new Error("Commit, model and independent oracle identity are required");
    const beforeTokens = totalUsage(before), afterTokens = totalUsage(after);
    const passed = after.passed === true && after.protectedInputsUnchanged === true;
    return { taskId: before.taskId, repetition: before.repetition, beforeTokens, afterTokens, passed,
      regression: before.passed === true && before.protectedInputsUnchanged === true && !passed,
      withinTarget: afterTokens !== null && afterTokens <= targetTokens,
      reduction: beforeTokens !== null && beforeTokens > 0 && afterTokens !== null ? 1 - afterTokens / beforeTokens : null };
  });
  const measured = cases.map(item => item.afterTokens).filter((value): value is number => value !== null).sort((a, b) => a - b);
  const percentile = (fraction: number) => measured.length ? measured[Math.max(0, Math.ceil(fraction * measured.length) - 1)] : null;
  return {
    targetTokens, cases,
    qualityRegressions: cases.filter(item => item.regression).length,
    unmeasuredCases: cases.filter(item => item.beforeTokens === null || item.afterTokens === null).length,
    medianCandidateTokens: measured.length ? (measured[Math.floor((measured.length - 1) / 2)] + measured[Math.floor(measured.length / 2)]) / 2 : null, p95CandidateTokens: percentile(0.95),
    accepted: cases.every(item => item.passed && item.withinTarget && item.beforeTokens !== null),
    limitation: "Acceptance applies only to the supplied independently evaluated runs, not all future tasks.",
  };
}
