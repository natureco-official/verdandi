import { contentHash } from "./safe_files.js";

export interface EvidenceDelta {
  baseRef: string;
  targetRef: string;
  baseHash: string;
  targetHash: string;
  offset: number;
  deleteChars: number;
  insert: string;
}

/** Exact prefix/suffix delta. A large middle remains verbatim and is paged. */
export function createEvidenceDelta(before: string, after: string, baseRef: string, targetRef: string): EvidenceDelta {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  if (start > 0 && /[\uD800-\uDBFF]/.test(before[start - 1])) start--;
  let oldEnd = before.length, newEnd = after.length;
  while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) { oldEnd--; newEnd--; }
  if (oldEnd < before.length && /[\uDC00-\uDFFF]/.test(before[oldEnd])) { oldEnd++; newEnd++; }
  return { baseRef, targetRef, baseHash: contentHash(before), targetHash: contentHash(after),
    offset: start, deleteChars: oldEnd - start, insert: after.slice(start, newEnd) };
}

export function applyEvidenceDelta(before: string, delta: EvidenceDelta): string {
  if (contentHash(before) !== delta.baseHash) throw new Error("Delta base hash mismatch");
  if (!Number.isInteger(delta.offset) || !Number.isInteger(delta.deleteChars) || delta.offset < 0 || delta.deleteChars < 0 ||
      delta.offset + delta.deleteChars > before.length || typeof delta.insert !== "string") throw new RangeError("Invalid delta range");
  const after = before.slice(0, delta.offset) + delta.insert + before.slice(delta.offset + delta.deleteChars);
  if (contentHash(after) !== delta.targetHash) throw new Error("Delta target hash mismatch");
  return after;
}
