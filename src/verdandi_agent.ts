/**
 * Verðandi Agent Loop — Token-efficient Task Context Agent
 *
 * Flow: capsule → read symbols → LLM call → parse edits → patch → validate → retry
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { TypeScriptContextCompiler } from "./context_compiler.js";
import { buildMessages, estimatePromptTokens, type PromptInput } from "./llm_prompt.js";
import { parseLLMOutput, type EditOperation } from "./llm_parser.js";
import type { StructuredPatchOperation } from "../mcp_tools.js";

export interface AgentConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
  maxRetries: number;
  maxPromptTokens: number;
  verbose: boolean;
  dryRun: boolean;
  llmCaller?: typeof callLLM;
}

export interface AgentResult {
  success: boolean;
  task: string;
  attempts: number;
  edits: EditOperation[];
  validated: boolean;
  validationPassed: boolean;
  diagnostics: string[];
  durationMs: number;
  tokenEstimate: {
    prompt: number;
    output: number;
    total: number;
  };
  handoffRequired: boolean;
  rollbackToken?: string;
  error?: string;
}

const DEFAULT_CONFIG: AgentConfig = {
  apiKey: "",
  model: "gpt-4o",
  baseUrl: "https://api.openai.com/v1",
  maxRetries: 3,
  maxPromptTokens: 8000,
  verbose: false,
  dryRun: false,
};
const MAX_LLM_RESPONSE_BYTES = 8 * 1024 * 1024;

async function readResponseText(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_LLM_RESPONSE_BYTES) {
    throw new Error(`LLM response exceeds ${MAX_LLM_RESPONSE_BYTES} bytes`);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_LLM_RESPONSE_BYTES) {
      await reader.cancel("response too large");
      throw new Error(`LLM response exceeds ${MAX_LLM_RESPONSE_BYTES} bytes`);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

async function callLLM(
  messages: Array<{ role: string; content: string }>,
  config: AgentConfig,
): Promise<{ content: string; tokens: { prompt: number; output: number } }> {
  const controller = new AbortController();
  const configuredTimeout = Number(process.env.VERDANDI_REQUEST_TIMEOUT_MS ?? process.env.URDR_REQUEST_TIMEOUT_MS ?? 180000);
  if (!Number.isFinite(configuredTimeout) || configuredTimeout < 1_000 || configuredTimeout > 30 * 60 * 1_000) {
    throw new RangeError("VERDANDI_REQUEST_TIMEOUT_MS must be between 1000 and 1800000");
  }
  const timeoutMs = configuredTimeout;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + config.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        temperature: 0.1,
        max_tokens: 16384,
        ...(config.model.toLowerCase().includes("minimax") ? { thinking: { type: "adaptive" } } : {}),
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }

  const responseText = await readResponseText(response);
  if (!response.ok) {
    const text = responseText;
    throw new Error(`LLM API error ${response.status}: ${text.substring(0, 200)}`);
  }

  let data: any;
  try {
    data = JSON.parse(responseText);
  } catch {
    throw new Error("LLM returned invalid JSON");
  }
  const choice = data.choices?.[0];
  if (!choice?.message) {
    throw new Error("LLM returned empty response");
  }

  // Handle reasoning models (DeepSeek etc.) — content may be in reasoning_content
  // Reasoning models output thinking in reasoning_content and final answer in content
  // If content is empty but reasoning has JSON, use it
  let content = choice.message.content || "";
  const reasoning = choice.message.reasoning_content || "";

  if (!content && reasoning) {
    // Pass full reasoning to parser — it has multiple extraction strategies
    content = reasoning;
  }
  if (!content) {
    throw new Error("LLM returned empty response (no content or reasoning)");
  }

  return {
    content,
    tokens: {
      prompt: data.usage?.prompt_tokens ?? 0,
      output: data.usage?.completion_tokens ?? 0,
    },
  };
}

function log(verbose: boolean, ...args: unknown[]) {
  if (verbose) console.error("[verdandi]", ...args);
}

async function resolveProjectPath(projectRoot: string, file: string): Promise<string> {
  const root = path.resolve(projectRoot);
  const absolute = path.resolve(root, file);
  const relative = path.relative(root, absolute);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to access file outside project root: ${file}`);
  }
  const [realRoot, realFile] = await Promise.all([fs.realpath(root), fs.realpath(absolute)]);
  const realRelative = path.relative(realRoot, realFile);
  if (!realRelative || realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
    throw new Error(`Refusing to access symlink outside project root: ${file}`);
  }
  return absolute;
}

export async function runAgent(
  task: string,
  projectRoot: string,
  configOverride: Partial<AgentConfig> = {},
): Promise<AgentResult> {
  const config = { ...DEFAULT_CONFIG, ...configOverride };
  const startTime = Date.now();
  const compiler = new TypeScriptContextCompiler();
  const diagnostics: string[] = [];
  // Global run state (declared outside try so catch can access)
  let lastError = "";
  let lastOutput = "";
  let totalPromptTokens = 0;
  let totalOutputTokens = 0;
  let succeeded = false;
  let appliedEdits: EditOperation[] = [];
  let validated = false;
  let validationPassed = false;
  let attemptsUsed = 0;
  let finalRollbackToken: string | undefined;

  if (typeof task !== "string" || !task.trim() || task.length > 20_000) {
    return {
      success: false, task, attempts: 0, edits: [], validated: false,
      validationPassed: false, diagnostics: ["Task must not be empty."],
      durationMs: Date.now() - startTime,
      tokenEstimate: { prompt: 0, output: 0, total: 0 },
      handoffRequired: true, error: "Invalid task",
    };
  }
  if (!Number.isInteger(config.maxRetries) || config.maxRetries < 1 || config.maxRetries > 10) {
    return {
      success: false, task, attempts: 0, edits: [], validated: false,
      validationPassed: false, diagnostics: ["maxRetries must be an integer between 1 and 10"],
      durationMs: Date.now() - startTime, tokenEstimate: { prompt: 0, output: 0, total: 0 },
      handoffRequired: true, error: "Invalid maxRetries",
    };
  }
  if (!Number.isFinite(config.maxPromptTokens) || config.maxPromptTokens < 256 || config.maxPromptTokens > 100_000) {
    return {
      success: false, task, attempts: 0, edits: [], validated: false,
      validationPassed: false, diagnostics: ["maxPromptTokens must be between 256 and 100000"],
      durationMs: Date.now() - startTime, tokenEstimate: { prompt: 0, output: 0, total: 0 },
      handoffRequired: true, error: "Invalid maxPromptTokens",
    };
  }

  if (!config.apiKey) {
    return {
      success: false,
      task,
      attempts: 0,
      edits: [],
      validated: false,
      validationPassed: false,
      diagnostics: ["No API key provided. Set VERDANDI_API_KEY or --api-key."],
      durationMs: Date.now() - startTime,
      tokenEstimate: { prompt: 0, output: 0, total: 0 },
      handoffRequired: true,
      error: "No API key",
    };
  }

  try {
    log(config.verbose, "Starting agent for task:", task.substring(0, 60));

  // ── Step 1: Generate capsule ────────────────────────────────────
  log(config.verbose, "Step 1: Generating capsule...");
  const capsule = await compiler.context_capsule({
    task,
    projectRoot,
    preferredBudgetLevel: 1,
  });

  const confidence = capsule._meta.retrievalConfidence;
  const symbols = capsule.modelPayload.relevantSymbols;
  log(config.verbose, `  Capsule: ${symbols.length} symbols, confidence ${confidence.toFixed(2)}`);

  // ── Step 2: Read each symbol ────────────────────────────────────
  log(config.verbose, "Step 2: Reading symbols...");
  const symbolSources: PromptInput["symbols"] = [];
  let totalSourceLength = 0;

  // Read smart slices from probableFiles
  // Import sorting → first 100 lines; symbol edits → specific regions
  const filesRead = new Set<string>();
  for (const file of capsule.modelPayload.probableFiles.slice(0, 4)) {
    const absPath = await resolveProjectPath(projectRoot, file);
    if (filesRead.has(absPath)) continue;
    filesRead.add(absPath);
    try {
      const fullSource = await fs.readFile(absPath, "utf-8");
      const lines = fullSource.split("\n");

      // Smart slice: take imports (first 80 lines) + relevant symbol regions
      const importLines = lines.slice(0, 50).join("\n");
      let symbolRegions = "";

      for (const sym of symbols.filter(s => s.file === file).slice(0, 2)) {
        try {
          const readResult = await compiler.read_symbol({
            projectRoot,
            symbol: sym.symbol,
            fileHint: file,
            maxTokens: 350,
            includeBody: true,
            includeCallGraphNeighbors: false,
          });
          if (readResult.evidence.length > 0) {
            const ev = readResult.evidence[0];
            if (ev.source) {
              symbolRegions += `\n// ── ${sym.symbol} (lines ${ev.startLine}-${ev.endLine}) ──\n${ev.source}\n`;
            }
          }
        } catch {}
      }

      const source = symbolRegions
        ? `${importLines}\n\n// ... (truncated) ...\n${symbolRegions}`
        : importLines;

      totalSourceLength += source.length;
      symbolSources.push({
        symbol: file.split("/").pop()?.replace(/\.\w+$/, "") || file,
        file,
        kind: "module",
        source,
        startLine: 1,
        endLine: 50,
        hopDistance: 0,
      });
      log(config.verbose, `  ✓ ${file} (${source.length} chars, smart-sliced)`);
    } catch (e) {
      log(config.verbose, `  ✗ ${file}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Check token budget
  const promptInput: PromptInput = {
    task,
    goal: capsule.modelPayload.goal,
    symbols: symbolSources,
    probableFiles: capsule.modelPayload.probableFiles,
    decisions: capsule.modelPayload.decisions.map(d => d.summary || String(d)),
    criteria: capsule.modelPayload.successCriteria,
  };

  const estimatedTokens = estimatePromptTokens(promptInput);
  log(config.verbose, `  Estimated prompt: ${estimatedTokens} tokens`);

  // If too large, trim symbols
  if (estimatedTokens > config.maxPromptTokens) {
    log(config.verbose, `  ⚠ Prompt too large (${estimatedTokens} > ${config.maxPromptTokens}), trimming...`);
    while (symbolSources.length > 1 && estimatePromptTokens(promptInput) > config.maxPromptTokens) {
      symbolSources.pop();
      promptInput.symbols = symbolSources;
    }
    if (estimatePromptTokens(promptInput) > config.maxPromptTokens) {
      throw new Error(`Prompt remains above token budget after trimming (${estimatePromptTokens(promptInput)} > ${config.maxPromptTokens})`);
    }
  }

  // ── Step 3: Agent loop (mutates outer run-state; do NOT redeclare) ──
  for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
    attemptsUsed = attempt;
    log(config.verbose, `Step 3: LLM call (attempt ${attempt}/${config.maxRetries})...`);

    // Build messages
    const messages = buildMessages(promptInput, lastError ? {
      error: lastError,
      output: lastOutput,
      attempt,
    } : undefined);

    // Call LLM
    let llmResult;
    try {
      llmResult = await (config.llmCaller ?? callLLM)(messages, config);
    } catch (e) {
      lastError = `LLM call failed: ${e instanceof Error ? e.message : String(e)}`;
      diagnostics.push(lastError);
      log(config.verbose, `  ✗ ${lastError}`);
      if (lastError.includes("401") || lastError.includes("403") || lastError.includes("404")) {
        log(config.verbose, "  Fatal API error encountered, stopping retries.");
        break;
      }
      continue;
    }

    if (!llmResult || typeof llmResult.content !== "string" || Buffer.byteLength(llmResult.content) > MAX_LLM_RESPONSE_BYTES) {
      lastError = "LLM returned an invalid or oversized content payload";
      diagnostics.push(lastError);
      continue;
    }

    totalPromptTokens += llmResult.tokens.prompt;
    totalOutputTokens += llmResult.tokens.output;
    lastOutput = llmResult.content;
    log(config.verbose, `  LLM response: ${llmResult.tokens.prompt}+${llmResult.tokens.output} tokens`);

    // Parse output
    const parsed = parseLLMOutput(llmResult.content);

    if (parsed.parseError) {
      lastError = parsed.parseError;
      diagnostics.push(`Attempt ${attempt}: ${lastError}`);
      log(config.verbose, `  ✗ Parse error: ${lastError}`);
      continue;
    }

    if (parsed.needsMoreContext) {
      lastError = `Needs more context: ${parsed.moreContextFile}`;
      diagnostics.push(lastError);
      log(config.verbose, `  ⚠ ${lastError}`);

      // Read the FULL requested file and add to context
      if (parsed.moreContextFile) {
        try {
          const absMorePath = await resolveProjectPath(projectRoot, parsed.moreContextFile);
          const moreSource = await fs.readFile(absMorePath, "utf-8");
          // Truncate to first 200 lines if too large
          const lines = moreSource.split("\n");
          const truncated = lines.slice(0, 200).join("\n");
          const requestedFile = parsed.moreContextFile;
          if (promptInput.symbols.some(item => item.file === requestedFile)) {
            lastError = `Repeated context request refused: ${requestedFile}`;
            diagnostics.push(lastError);
            continue;
          }
          promptInput.symbols.push({
            symbol: parsed.moreContextFile.split("/").pop()?.replace(/\.\w+$/, "") || "",
            file: parsed.moreContextFile,
            kind: "module",
            source: truncated,
            startLine: 1,
            endLine: Math.min(lines.length, 200),
            hopDistance: 0,
          });
          if (estimatePromptTokens(promptInput) > config.maxPromptTokens) {
            promptInput.symbols.pop();
            lastError = `Requested context exceeds prompt budget: ${requestedFile}`;
            diagnostics.push(lastError);
          }
          log(config.verbose, `  📖 Read full file: ${parsed.moreContextFile} (${truncated.length} chars)`);
        } catch (e) {
          log(config.verbose, `  ✗ Could not read: ${parsed.moreContextFile}`);
        }
      }
      continue;
    }

    if (parsed.edits.length === 0) {
      log(config.verbose, "  Verifying that no edits are needed...");
      const validation = await compiler.validate_delta({
        projectRoot,
        taskId: `verdandi-agent-${Date.now()}`,
        kinds: ["typecheck"],
        commandProfile: "package-scripts",
      });
      validated = true;
      validationPassed = validation.passed;
      if (validation.passed) {
        succeeded = true;
        break;
      }
      lastError = validation.diagnostics.map(diagnostic => diagnostic.message).join("; ");
      diagnostics.push(`No-edit verification failed: ${lastError}`);
      continue;
    }

    log(config.verbose, `  📝 ${parsed.edits.length} edit(s) proposed`);

    // ── Step 4: Apply edits ────────────────────────────────────
    if (config.dryRun) {
      log(config.verbose, "  🔍 Dry run — edits not applied");
      appliedEdits = parsed.edits;
      succeeded = true;
      break;
    }

    const patchOperations: StructuredPatchOperation[] = [];
    let patchSnapshot: string | undefined;
    let preparationFailed = false;
    for (const edit of parsed.edits) {
      try {
        const readResult = await compiler.read_symbol({
          projectRoot,
          symbol: edit.symbol!,
          fileHint: edit.file,
          maxTokens: 1200,
          includeCallGraphNeighbors: false,
        });

        if (readResult.evidence.length !== 1 || readResult.requiresEscalation) {
          const errMsg = `Symbol '${edit.symbol}' not found in ${edit.file}; patch aborted`;
          diagnostics.push(errMsg);
          preparationFailed = true;
          continue;
        }
        if (patchSnapshot && patchSnapshot !== readResult.snapshot) {
          diagnostics.push("Project changed while edits were being prepared; patch aborted");
          preparationFailed = true;
          continue;
        }
        patchSnapshot = readResult.snapshot;
        const ev = readResult.evidence[0];
        const precondition = {
          file: ev.symbol.file,
          contentHash: ev.fileContentHash || "",
          symbol: ev.symbol.symbol,
          symbolHash: ev.contentHash,
        };
        const operation: StructuredPatchOperation = edit.operation === "replace_function_body"
          ? { operation: "replace_function_body", file: ev.symbol.file, symbol: ev.symbol.symbol, newBody: edit.newCode, precondition }
          : edit.operation === "insert_before"
            ? { operation: "insert_before_symbol", file: ev.symbol.file, symbol: ev.symbol.symbol, content: edit.newCode, precondition }
            : edit.operation === "insert_after"
              ? { operation: "insert_after_symbol", file: ev.symbol.file, symbol: ev.symbol.symbol, content: edit.newCode, precondition }
              : edit.operation === "delete"
                ? { operation: "delete_symbol", file: ev.symbol.file, symbol: ev.symbol.symbol, precondition }
                : { operation: "replace_symbol", file: ev.symbol.file, symbol: ev.symbol.symbol, replacement: edit.newCode, precondition };
        patchOperations.push(operation);
      } catch (e) {
        diagnostics.push(`Edit error (${edit.symbol}): ${e instanceof Error ? e.message : String(e)}`);
        preparationFailed = true;
      }
    }

    if (preparationFailed || !patchSnapshot || patchOperations.length !== parsed.edits.length) {
      lastError = "One or more edits could not be prepared atomically";
      continue;
    }

    const patchResult = await compiler.apply_structured_patch({
      projectRoot,
      taskId: `verdandi-agent-${Date.now()}`,
      snapshot: patchSnapshot,
      language: "typescript",
      dryRun: false,
      operations: patchOperations,
    });
    if (!patchResult.applied || !patchResult.rollbackToken) {
      lastError = patchResult.diagnostics.map(item => item.message).join("; ") || "Atomic patch failed";
      diagnostics.push(lastError);
      continue;
    }
    finalRollbackToken = patchResult.rollbackToken;

    appliedEdits = parsed.edits;

    // ── Step 5: Validate ────────────────────────────────────────
    log(config.verbose, "Step 5: Validating...");
    let validation;
    try {
      validation = await compiler.validate_delta({
        projectRoot,
        taskId: `verdandi-agent-${Date.now()}`,
        kinds: ["test", "lint", "typecheck"],
        commandProfile: "package-scripts",
      });
    } catch (error) {
      const rollback = await compiler.rollback_patch({ projectRoot, rollbackToken: patchResult.rollbackToken });
      if (rollback.reverted) {
        appliedEdits = [];
        finalRollbackToken = undefined;
      }
      throw error;
    }

    validated = true;
    validationPassed = validation.passed;

    if (validation.passed) {
      log(config.verbose, "  ✅ Validation passed");
      succeeded = true;
      finalRollbackToken = patchResult.rollbackToken;
      break;
    } else {
      lastError = validation.diagnostics.map(d => d.message).join("; ");
      diagnostics.push(`Validation failed: ${lastError}`);
      log(config.verbose, `  ❌ Validation failed: ${lastError}`);
      const rollback = await compiler.rollback_patch({
        projectRoot,
        rollbackToken: patchResult.rollbackToken,
      });
      if (!rollback.reverted) {
        throw new Error(`Validation failed and rollback could not complete: ${rollback.message}`);
      }
      appliedEdits = [];
      finalRollbackToken = undefined;
    }
  }

  } catch (e) {
    const durationMs = Date.now() - startTime;
    return {
      success: false,
      task,
      attempts: attemptsUsed,
      edits: appliedEdits,
      validated,
      validationPassed,
      diagnostics: [...diagnostics, e instanceof Error ? e.message : String(e)],
      durationMs,
      tokenEstimate: { prompt: totalPromptTokens || 0, output: totalOutputTokens || 0, total: (totalPromptTokens || 0) + (totalOutputTokens || 0) },
      handoffRequired: true,
      ...(finalRollbackToken ? { rollbackToken: finalRollbackToken } : {}),
      error: e instanceof Error ? e.message : String(e),
    };
  }

  const durationMs = Date.now() - startTime;

  return {
    success: succeeded,
    task,
    attempts: attemptsUsed,
    edits: appliedEdits,
    validated,
    validationPassed,
    diagnostics,
    durationMs,
    tokenEstimate: {
      prompt: totalPromptTokens,
      output: totalOutputTokens,
      total: totalPromptTokens + totalOutputTokens,
    },
    handoffRequired: !succeeded,
    ...(finalRollbackToken ? { rollbackToken: finalRollbackToken } : {}),
    error: succeeded ? undefined : lastError || "Max retries exceeded",
  };
}
