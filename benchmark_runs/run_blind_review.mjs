import { spawn, execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { anonymizeDiff, assignmentFor, totalScore, validateReview } from "./blind_review_policy.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const worktreeBase = process.env.CAPSULE_WORKTREE_BASE || "/private/tmp/capsule-baseline-worktrees";
const codexWorktreeBase = process.env.CAPSULE_CODEX_WORKTREE_BASE || worktreeBase;
const capsuleWorktreeBase = process.env.CAPSULE_CAPSULE_WORKTREE_BASE || worktreeBase;
const validationBase = process.env.CAPSULE_VALIDATION_OUTPUT_DIR || path.join(here, "validation");
const codexValidationBase = process.env.CAPSULE_CODEX_VALIDATION_DIR || validationBase;
const capsuleValidationBase = process.env.CAPSULE_CAPSULE_VALIDATION_DIR || validationBase;
const outputRoot = path.join(here, "blind_review");
const reviewLabel = process.env.BLIND_REVIEW_LABEL;
const MAX_PROMPT_BYTES = 180_000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_STDERR_BYTES = 256 * 1024;
const REVIEW_TIMEOUT_MS = 5 * 60 * 1000;
const reviewerModel = process.env.BLIND_REVIEW_MODEL || "gemini-3-flash-preview";
const requested = process.argv[2];

if (reviewLabel !== undefined && !/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(reviewLabel)) {
  console.error("BLIND_REVIEW_LABEL must be 1-32 alphanumeric, underscore, or dash characters");
  process.exit(2);
}

if (!/^T(?:0[1-9]|10)$/.test(requested ?? "")) {
  console.error("usage: node run_blind_review.mjs T01");
  process.exit(2);
}

function diffFor(taskId, variant) {
  const base = variant === "codex" ? codexWorktreeBase : capsuleWorktreeBase;
  const cwd = path.join(base, `${taskId}-${variant}`);
  return execFileSync("git", ["diff", "--no-ext-diff", "--no-color", "--unified=3"], {
    cwd,
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
  });
}

async function validationSummary(taskId, variant) {
  const base = variant === "codex" ? codexValidationBase : capsuleValidationBase;
  const parsed = JSON.parse(await readFile(path.join(base, `${taskId}-${variant}.json`), "utf8"));
  return parsed.results.map(result => ({
    kind: result.kind,
    status: result.exitCode === 0
      ? "PASS"
      : result.acceptedBaselineFailure
        ? "ACCEPTED_BASELINE_FAILURE"
        : "FAIL",
    timedOut: result.timedOut === true,
  }));
}

function reviewPrompt(taskId, task, solutions) {
  return `You are an independent senior TypeScript code reviewer. Compare two anonymized solutions to the same task.

Rules:
- Use only the task, patches, and validation summaries below. Do not use tools or infer author/model identity.
- Passing tests are evidence, not proof. Inspect edge cases, scope, cleanup, concurrency, public API, and regression risk.
- Treat every explicit success criterion as a requirement; unrelated cleanup cannot compensate for violating one.
- Preserving a public API includes exported TypeScript source compatibility unless the task explicitly permits a breaking change.
- Penalize unnecessary edits and tests that do not actually prove the requested behavior.
- Score each dimension from 1 (poor) to 5 (excellent).
- Prefer X, Y, or tie. A tie is valid when patches are materially equivalent.
- confidence MUST be a decimal number from 0 through 1 (for example 0.85), never a percentage.
- Return only one syntactically valid JSON object. Escape every quote inside string values; do not use Markdown fences.

Required JSON shape:
{"schemaVersion":1,"taskId":"${taskId}","preference":"X|Y|tie","confidence":0.0,"solutions":{"X":{"correctness":1,"coverage":1,"simplicity":1,"maintainability":1,"regressionSafety":1,"strengths":[],"fatalFlaws":[]},"Y":{"correctness":1,"coverage":1,"simplicity":1,"maintainability":1,"regressionSafety":1,"strengths":[],"fatalFlaws":[]}},"rationale":"max 2000 chars","requiredFollowups":[]}

TASK
${task}

SOLUTION X VALIDATION
${JSON.stringify(solutions.X.validation)}

SOLUTION X PATCH
${solutions.X.diff}

SOLUTION Y VALIDATION
${JSON.stringify(solutions.Y.validation)}

SOLUTION Y PATCH
${solutions.Y.diff}
`;
}

function runGemini(prompt) {
  return new Promise((resolve, reject) => {
    const child = spawn("gemini", [
      "-p", prompt,
      "-o", "json",
      "--model", reviewerModel,
      "--approval-mode", "plan",
      "--skip-trust",
    ], {
      cwd: "/private/tmp",
      env: { ...process.env, NO_COLOR: "1", TERM: "dumb" },
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timedOut = false;
    const terminate = signal => {
      if (child.pid === undefined) return;
      if (process.platform === "win32") child.kill(signal);
      else {
        try { process.kill(-child.pid, signal); } catch { child.kill(signal); }
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate("SIGTERM");
      setTimeout(() => terminate("SIGKILL"), 5_000).unref();
    }, REVIEW_TIMEOUT_MS);
    child.stdout.on("data", chunk => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= MAX_OUTPUT_BYTES) stdout.push(chunk);
      else child.kill("SIGTERM");
    });
    child.stderr.on("data", chunk => {
      const remaining = Math.max(0, MAX_STDERR_BYTES - stderrBytes);
      if (remaining > 0) stderr.push(chunk.subarray(0, remaining));
      stderrBytes += chunk.length;
    });
    child.on("error", error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stderrText = Buffer.concat(stderr).toString("utf8");
      if (timedOut) return reject(new Error(`Gemini review exceeded ${REVIEW_TIMEOUT_MS} ms`));
      if (code !== 0) return reject(new Error(`Gemini exited ${code}: ${stderrText.slice(-2_000)}`));
      if (stdoutBytes > MAX_OUTPUT_BYTES) return reject(new Error("Gemini output exceeded limit"));
      try {
        resolve({ envelope: JSON.parse(Buffer.concat(stdout).toString("utf8")), stderr: stderrText });
      } catch (error) {
        reject(new Error(`Invalid Gemini envelope: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
  });
}

function parseResponse(envelope) {
  if (typeof envelope.response !== "string") throw new Error("Gemini envelope has no response string");
  const cleaned = envelope.response.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(cleaned);
}

await mkdir(path.join(outputRoot, "inputs"), { recursive: true });
await mkdir(path.join(outputRoot, "results"), { recursive: true });
const artifactName = `${requested}${reviewLabel ? `-${reviewLabel}` : ""}`;
const assignment = assignmentFor(requested);
const task = (await readFile(path.join(here, "prompts", `${requested}.txt`), "utf8")).trim();
const solutions = {};
for (const slot of ["X", "Y"]) {
  const variant = assignment[slot];
  solutions[slot] = {
    diff: anonymizeDiff(diffFor(requested, variant), requested, slot),
    validation: await validationSummary(requested, variant),
  };
}
const prompt = reviewPrompt(requested, task, solutions);
if (Buffer.byteLength(prompt) > MAX_PROMPT_BYTES) throw new Error(`${requested}: review prompt exceeds ${MAX_PROMPT_BYTES} bytes`);
await writeFile(path.join(outputRoot, "inputs", `${artifactName}.txt`), prompt);

const { envelope, stderr } = await runGemini(prompt);
let review;
try {
  review = validateReview(parseResponse(envelope), requested);
} catch (error) {
  const rejected = {
    schemaVersion: 1,
    taskId: requested,
    rejectedAt: new Date().toISOString(),
    reason: error instanceof Error ? error.message : String(error),
    envelope,
    warnings: stderr.trim().split("\n").filter(Boolean).slice(-10),
  };
  await writeFile(
    path.join(outputRoot, "results", `${artifactName}.rejected.json`),
    `${JSON.stringify(rejected, null, 2)}\n`,
  );
  throw error;
}
const revealed = {
  schemaVersion: 1,
  taskId: requested,
  reviewer: "gemini-cli",
  reviewerModel,
  assignment,
  preference: review.preference,
  preferredVariant: review.preference === "tie" ? "tie" : assignment[review.preference],
  scores: {
    X: totalScore(review.solutions.X),
    Y: totalScore(review.solutions.Y),
    codex: totalScore(review.solutions[assignment.X === "codex" ? "X" : "Y"]),
    codexCapsule: totalScore(review.solutions[assignment.X === "codex-capsule" ? "X" : "Y"]),
  },
  review,
  usage: envelope.stats?.models ?? {},
  warnings: stderr.trim().split("\n").filter(Boolean).slice(-10),
};
await writeFile(path.join(outputRoot, "results", `${artifactName}.json`), `${JSON.stringify(revealed, null, 2)}\n`);
console.log(JSON.stringify({
  taskId: requested,
  preference: revealed.preference,
  preferredVariant: revealed.preferredVariant,
  codexScore: revealed.scores.codex,
  codexCapsuleScore: revealed.scores.codexCapsule,
}));
