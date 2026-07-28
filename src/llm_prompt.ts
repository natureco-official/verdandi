/**
 * LLM Prompt Builder — Capsule + kodları tek prompt'a dönüştürür
 */

export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface PromptInput {
  task: string;
  goal: string;
  symbols: Array<{
    symbol: string;
    file: string;
    kind: string;
    source: string;
    startLine: number;
    endLine: number;
    hopDistance: number;
  }>;
  probableFiles: string[];
  decisions: string[];
  criteria: string[];
}

const SYSTEM_PROMPT = `You are a coding agent. Analyze the code and return ONLY a JSON array of edits.

Rules:
- Output ONLY a JSON array. No text, no markdown, no explanations.
- Each edit: {"file":"path","symbol":"name","operation":"replace_function_body","newCode":"..."}
- Operations: replace_function_body, replace_symbol, insert_before, insert_after, delete
- If no changes needed: []
- If you need more code: [{"action":"needs_more_context","file":"path"}]

IMPORTANT: Start your response with [ and end with ]. ONLY output the JSON array.`;

function buildUserPrompt(input: PromptInput): string {
  const symbolContent = input.symbols
    .map(s => {
      return `// File: ${s.file} (lines ${s.startLine}-${s.endLine})
// Symbol: ${s.symbol} (Kind: ${s.kind}, Hop Distance: ${s.hopDistance})
\`\`\`typescript
${s.source}
\`\`\``;
    })
    .join("\n\n");

  return `# Task: ${input.task}

# Goal: ${input.goal}

# Probable Files:
${input.probableFiles.map(f => `- ${f}`).join("\n")}

# Decisions:
${input.decisions.map(d => `- ${d}`).join("\n")}

# Success Criteria:
${input.criteria.map(c => `- ${c}`).join("\n")}

# Relevant Code:
${symbolContent}

Based on the task and context, provide a JSON array of edits.`;
}

function buildRetryPrompt(
  input: PromptInput,
  previousError: string,
  previousOutput: string,
  attempt: number,
): string {
  const base = buildUserPrompt(input);
  const safeError = String(previousError ?? "");
  const safeOutput = String(previousOutput ?? "");
  const clipped = safeOutput.length > 1500
    ? `${safeOutput.slice(0, 1500)}\n…(truncated)`
    : safeOutput;
  return `${base}\n\n# ⚠️ Previous attempt failed (attempt ${attempt}/3)\nError: ${safeError}\n\nPrevious output was invalid. Fix the error and try again.\nOutput ONLY valid JSON.\n\n# Previous output:\n${clipped}`;
}

export function buildMessages(
  input: PromptInput,
  retry?: { error: string; output: string; attempt: number },
): LLMMessage[] {
  const messages: LLMMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
  ];

  if (retry) {
    messages.push({
      role: "user",
      content: buildRetryPrompt(input, retry.error, retry.output, retry.attempt),
    });
  } else {
    messages.push({
      role: "user",
      content: buildUserPrompt(input),
    });
  }

  return messages;
}

export function estimatePromptTokens(input: PromptInput): number {
  const text = buildUserPrompt(input);
  return Math.ceil(text.length / 3.5);
}

/** Exposed for tests — builds the user-facing prompt body. */
export function buildUserPromptForTest(input: PromptInput): string {
  return buildUserPrompt(input);
}
