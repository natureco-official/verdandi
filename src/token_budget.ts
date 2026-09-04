import { getEncoding } from "js-tiktoken";

export const TOKEN_ENCODING = "cl100k_base" as const;
let encoding: ReturnType<typeof getEncoding> | undefined;

/** Exact for this named encoding; API usage remains the billing authority. */
export function countTokens(value: unknown): number {
  encoding ??= getEncoding(TOKEN_ENCODING);
  return encoding.encode(typeof value === "string" ? value : JSON.stringify(value), [], []).length;
}

/** Clip only at Unicode code-point boundaries, always recheck the final value. */
export function boundedPrefix(text: string, fits: (prefix: string) => boolean): string {
  let low = 0;
  // Grow from a small window rather than repeatedly tokenizing half a megabyte.
  let high = Math.min(text.length, 1024);
  const boundary = (n: number) => n > 0 && n < text.length && /[\uD800-\uDBFF]/.test(text[n - 1]) ? n - 1 : n;
  while (high < text.length && fits(text.slice(0, boundary(high)))) {
    low = high;
    high = Math.min(text.length, high * 2);
  }
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(text.slice(0, boundary(middle)))) low = middle;
    else high = middle - 1;
  }
  const result = text.slice(0, boundary(low));
  if (!fits(result)) throw new RangeError("Reply metadata alone exceeds token budget");
  return result;
}
