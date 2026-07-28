/**
 * LLM Output Parser — JSON edit operations'ları çıkarır
 */

export interface EditOperation {
  file: string;
  symbol?: string;
  operation: "replace_function_body" | "replace_symbol" | "insert_before" | "insert_after" | "delete";
  newCode: string;
  action?: "needs_more_context";
}

export interface ParseResult {
  edits: EditOperation[];
  needsMoreContext: boolean;
  moreContextFile?: string;
  rawOutput: string;
  parseError?: string;
}

const EDIT_OPERATIONS = new Set<EditOperation["operation"]>([
  "replace_function_body",
  "replace_symbol",
  "insert_before",
  "insert_after",
  "delete",
]);
const MAX_MODEL_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_EDIT_COUNT = 100;

function extractJson(text: string): string | null {
  // Step 0: Aggressively strip ALL think tags (can be nested/multiple)
  let cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, " ").replace(/<think>|<\/think>/g, "").trim();

  // Strip code block markers if present
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");

  // Step 1: Find the first [ in cleaned text
  const firstBracket = cleaned.indexOf("[");
  if (firstBracket < 0) return null;

  // Step 2: Try extracting between first [ and last ]
  const lastBracket = cleaned.lastIndexOf("]");
  if (lastBracket > firstBracket) {
    const candidate = cleaned.substring(firstBracket, lastBracket + 1);
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed)) return candidate;
    } catch {}
  }

  // Step 3: Extract from first [ to end and try to parse as JSON array
  const candidateFromFirst = cleaned.substring(firstBracket);
  try {
    const parsed = JSON.parse(candidateFromFirst);
    if (Array.isArray(parsed)) return candidateFromFirst;
  } catch {}

  // Step 4: Try original text (before cleaning). Never repair truncated edit
  // arrays: applying a valid prefix would violate all-or-nothing semantics.
  const origBracket = text.indexOf("[");
  if (origBracket >= 0) {
    const origLast = text.lastIndexOf("]");
    if (origLast > origBracket) {
      const origCandidate = text.substring(origBracket, origLast + 1);
      try {
        const parsed = JSON.parse(origCandidate);
        if (Array.isArray(parsed)) return origCandidate;
      } catch {}
    }
  }

  return null;
}

export function parseLLMOutput(rawOutput: string): ParseResult {
  if (typeof rawOutput !== "string" || Buffer.byteLength(rawOutput) > MAX_MODEL_OUTPUT_BYTES) {
    return {
      edits: [], needsMoreContext: false, rawOutput: typeof rawOutput === "string" ? rawOutput.slice(0, 1_000) : "",
      parseError: `Model output exceeds ${MAX_MODEL_OUTPUT_BYTES} bytes`,
    };
  }
  const json = extractJson(rawOutput);

  if (!json) {
    return {
      edits: [],
      needsMoreContext: false,
      rawOutput,
      parseError: "No JSON array found in output",
    };
  }

  try {
    const parsed = JSON.parse(json);

    if (!Array.isArray(parsed)) {
      return {
        edits: [],
        needsMoreContext: false,
        rawOutput,
        parseError: `Expected array, got ${typeof parsed}`,
      };
    }
    if (parsed.length > MAX_EDIT_COUNT) {
      return { edits: [], needsMoreContext: false, rawOutput, parseError: `Too many edit operations: maximum is ${MAX_EDIT_COUNT}` };
    }

    const edits: EditOperation[] = [];
    let needsMoreContext = false;
    let moreContextFile: string | undefined;

    for (const [index, item] of parsed.entries()) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return {
          edits: [],
          needsMoreContext: false,
          rawOutput,
          parseError: `Invalid edit at index ${index}: expected object`,
        };
      }

      if (item.action === "needs_more_context") {
        if (typeof item.file !== "string" || !item.file.trim()) {
          return {
            edits: [],
            needsMoreContext: false,
            rawOutput,
            parseError: `Invalid context request at index ${index}: file is required`,
          };
        }
        needsMoreContext = true;
        moreContextFile = item.file;
        continue;
      }

      if (typeof item.file !== "string" || !item.file.trim()) {
        return { edits: [], needsMoreContext: false, rawOutput, parseError: `Invalid edit at index ${index}: file is required` };
      }
      if (item.file.length > 4096) {
        return { edits: [], needsMoreContext: false, rawOutput, parseError: `Invalid edit at index ${index}: file is too long` };
      }
      if (typeof item.symbol !== "string" || !item.symbol.trim()) {
        return { edits: [], needsMoreContext: false, rawOutput, parseError: `Invalid edit at index ${index}: symbol is required` };
      }
      if (item.symbol.length > 1024) {
        return { edits: [], needsMoreContext: false, rawOutput, parseError: `Invalid edit at index ${index}: symbol is too long` };
      }
      if (typeof item.operation !== "string" || !EDIT_OPERATIONS.has(item.operation as EditOperation["operation"])) {
        return { edits: [], needsMoreContext: false, rawOutput, parseError: `Invalid edit at index ${index}: unsupported operation '${String(item.operation)}'` };
      }
      if (item.operation !== "delete" && typeof item.newCode !== "string") {
        return { edits: [], needsMoreContext: false, rawOutput, parseError: `Invalid edit at index ${index}: newCode must be a string` };
      }
      if (typeof item.newCode === "string" && Buffer.byteLength(item.newCode) > MAX_MODEL_OUTPUT_BYTES) {
        return { edits: [], needsMoreContext: false, rawOutput, parseError: `Invalid edit at index ${index}: newCode is too large` };
      }

      edits.push({
        file: item.file,
        symbol: item.symbol,
        operation: item.operation as EditOperation["operation"],
        newCode: item.newCode ?? "",
      });
    }

    if (needsMoreContext && edits.length > 0) {
      return {
        edits: [], needsMoreContext: false, rawOutput,
        parseError: "A response cannot mix edit operations with needs_more_context",
      };
    }
    return { edits, needsMoreContext, moreContextFile, rawOutput };
  } catch (e) {
    return {
      edits: [],
      needsMoreContext: false,
      rawOutput,
      parseError: `JSON parse error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
