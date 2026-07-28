import { createHash } from "node:crypto";

export const REVIEW_DIMENSIONS = [
  "correctness",
  "coverage",
  "simplicity",
  "maintainability",
  "regressionSafety",
];

const forbiddenIdentity = /(?:codex-capsule|codex|context compiler|verdandi|capsule)/i;

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function assignmentFor(taskId) {
  const capsuleIsX = Number.parseInt(digest(`blind-review-v1:${taskId}`).slice(0, 2), 16) % 2 === 0;
  return capsuleIsX
    ? { X: "codex-capsule", Y: "codex" }
    : { X: "codex", Y: "codex-capsule" };
}

export function anonymizeDiff(diff, taskId, slot) {
  if (forbiddenIdentity.test(diff)) throw new Error(`${taskId}/${slot}: diff leaks solution identity`);
  const sections = diff.split(/(?=^diff --git )/m).filter(Boolean);
  sections.sort((a, b) => digest(`${taskId}:${slot}:${a}`).localeCompare(digest(`${taskId}:${slot}:${b}`)));
  return sections.join("");
}

function isScore(value) {
  return Number.isInteger(value) && value >= 1 && value <= 5;
}

export function validateReview(value, expectedTaskId) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("review must be an object");
  if (value.schemaVersion !== 1 || value.taskId !== expectedTaskId) throw new Error("review identity/schema mismatch");
  if (!["X", "Y", "tie"].includes(value.preference)) throw new Error("invalid preference");
  if (typeof value.confidence !== "number" || value.confidence < 0 || value.confidence > 1) throw new Error("invalid confidence");
  for (const slot of ["X", "Y"]) {
    const solution = value.solutions?.[slot];
    if (!solution || typeof solution !== "object") throw new Error(`missing solution ${slot}`);
    for (const dimension of REVIEW_DIMENSIONS) {
      if (!isScore(solution[dimension])) throw new Error(`invalid ${slot}.${dimension}`);
    }
    for (const field of ["strengths", "fatalFlaws"]) {
      if (!Array.isArray(solution[field]) || solution[field].some(item => typeof item !== "string" || item.length > 500)) {
        throw new Error(`invalid ${slot}.${field}`);
      }
    }
  }
  if (typeof value.rationale !== "string" || value.rationale.length > 2_000) throw new Error("invalid rationale");
  if (!Array.isArray(value.requiredFollowups) || value.requiredFollowups.some(item => typeof item !== "string" || item.length > 500)) {
    throw new Error("invalid requiredFollowups");
  }
  return value;
}

export function totalScore(solution) {
  return REVIEW_DIMENSIONS.reduce((total, dimension) => total + solution[dimension], 0);
}
