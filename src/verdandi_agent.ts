/**
 * Verðandi Agent Loop — Token-efficient Task Context Agent
 *
 * Flow: capsule → read symbols → LLM call → parse edits → patch → validate → retry
 */
import { TypeScriptContextCompiler } from "./context_compiler.js";
import { buildMessages, estimatePromptTokens, type PromptInput } from "./llm_prompt.js";
import { parseLLMOutput, type EditOperation } from "./llm_parser.js";
import { countTokens } from "./token_budget.js";
import type { MemoryProvider } from "./urdr_bridge.js";
import type { EvidencePage } from "./evidence_store.js";
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
  memoryProvider?: MemoryProvider;
  maxOutputTokens: number;
  maxTotalTokens: number;
  /** Host-owned behavioral verification; required for accepting an empty edit list. */
  taskVerifier?: (projectRoot: string, task: string) => Promise<{ passed: boolean; diagnostics?: string[] }>;
}

export interface RequestUsage {
  attempt: number;
  localInputTokens: number;
  outputAllowance: number;
  status: "failed" | "completed";
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  source: "provider" | "local-estimate";
}

export interface AgentResult {
  completionEvidence?: "unverified" | "proposal" | "project-checks" | "task-verifier";
  usage?: { encoding: "cl100k_base"; reservedTotalTokens: number; requests: RequestUsage[] };
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
  maxOutputTokens: 2000,
  maxTotalTokens: 16000,
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
): Promise<{ content: string; tokens: { prompt: number; output: number; cachedInput?: number }; usageKnown?: boolean }> {
  const controller = new AbortController();
  const configuredTimeout = Number(process.env.VERDANDI_REQUEST_TIMEOUT_MS ?? process.env.URDR_REQUEST_TIMEOUT_MS ?? 180000);
  if (!Number.isFinite(configuredTimeout) || configuredTimeout < 1_000 || configuredTimeout > 30 * 60 * 1_000) {
    throw new RangeError("VERDANDI_REQUEST_TIMEOUT_MS must be between 1000 and 1800000");
  }
  const timeoutMs = configuredTimeout;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  let responseText: string;
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
        max_tokens: config.maxOutputTokens,
        ...(config.model.toLowerCase().includes("minimax") ? { thinking: { type: "adaptive" } } : {}),
      }),
      signal: controller.signal,
    });
    responseText = await readResponseText(response);
  } finally {
    clearTimeout(timeoutId);
  }

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
    usageKnown: Number.isFinite(data.usage?.prompt_tokens) && Number.isFinite(data.usage?.completion_tokens),
    tokens: {
      prompt: data.usage?.prompt_tokens ?? 0,
      output: data.usage?.completion_tokens ?? 0,
      cachedInput: data.usage?.prompt_tokens_details?.cached_tokens,
    },
  };
}

function log(verbose: boolean, ...args: unknown[]) {
  if (verbose) console.error("[verdandi]", ...args);
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
  let consumedTokens = 0;
  const requests: RequestUsage[] = [];

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
    if (!Number.isInteger(config.maxOutputTokens) || config.maxOutputTokens < 64 || config.maxOutputTokens > 16384 ||
        !Number.isInteger(config.maxTotalTokens) || config.maxTotalTokens < 512 || config.maxTotalTokens > 1_000_000) {
      throw new RangeError("Invalid output or total token budget");
    }
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
  const filePages = new Map<string, EvidencePage>();
  const pageKey = (file: string, symbol?: string) => `${file}\0${symbol ?? ""}`;
  const addPage = (page: EvidencePage, symbol = page.file) => {
    symbolSources.push({
      symbol, file: page.file, kind: "module", source: page.source,
      startLine: 1, endLine: 1, hopDistance: 0,
      offset: page.offset, nextOffset: page.nextOffset, done: page.done, ref: page.ref,
    });
  };
  for (const file of capsule.modelPayload.probableFiles.slice(0, 4)) {
    const page = await compiler.read_evidence({ projectRoot, file, maxTokens: 800 });
    filePages.set(pageKey(file), page);
    addPage(page);
    // Prefix alone can miss the target deep inside a large file.
    for (const symbol of symbols.filter(item => item.file === file).slice(0, 1)) {
      const target = await compiler.read_evidence({ projectRoot, file, symbol: symbol.symbol, maxTokens: 800 });
      filePages.set(pageKey(file, symbol.symbol), target);
      if (!page.source.includes(target.source) || !target.done) addPage(target, symbol.symbol);
    }
  }

  // Check token budget
  const memory = config.memoryProvider ? await config.memoryProvider(task, projectRoot) : undefined;
  if (memory?.status === "unavailable") diagnostics.push(`Memory unavailable: ${memory.reason}`);
  const promptInput: PromptInput = {
    memory,
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
    let messages = buildMessages(promptInput, lastError ? {
      error: lastError,
      output: lastOutput,
      attempt,
    } : undefined);

    while (countTokens(JSON.stringify(messages)) > config.maxPromptTokens && promptInput.symbols.length > 1) {
      promptInput.symbols.shift();
      messages = buildMessages(promptInput, lastError ? { error: lastError, output: lastOutput, attempt } : undefined);
    }
    const requestTokens = countTokens(JSON.stringify(messages));
    if (requestTokens > config.maxPromptTokens) {
      lastError = "Complete request exceeds prompt budget";
      diagnostics.push(lastError);
      break;
    }
    const remainingOutput = Math.min(config.maxOutputTokens, config.maxTotalTokens - consumedTokens - requestTokens);
    if (remainingOutput < 64) {
      lastError = "Total token budget exhausted; task requires more evidence or a larger budget";
      diagnostics.push(lastError);
      break;
    }
    // Failed network requests may already have consumed input; reserve before sending.
    consumedTokens += requestTokens;
    const requestUsage: RequestUsage = { attempt, localInputTokens: requestTokens, outputAllowance: remainingOutput, status: "failed", source: "local-estimate" };
    requests.push(requestUsage);
    // Call LLM
    let llmResult;
    try {
      llmResult = await (config.llmCaller ?? callLLM)(messages, { ...config, maxOutputTokens: remainingOutput });
    } catch (e) {
      lastError = `LLM call failed: ${e instanceof Error ? e.message : String(e)}`;
      diagnostics.push(lastError);
      log(config.verbose, `  ✗ ${lastError}`);
      if (lastError.includes("401") || lastError.includes("403") || lastError.includes("404")) {
        log(config.verbose, "  Fatal API error encountered, stopping retries.");
        break;
      }
      consumedTokens += remainingOutput; // a lost response has unknown billed output
      continue;
    }

    if (!llmResult || typeof llmResult.content !== "string" || Buffer.byteLength(llmResult.content) > MAX_LLM_RESPONSE_BYTES) {
      lastError = "LLM returned an invalid or oversized content payload";
      diagnostics.push(lastError);
      continue;
    }

    const actualPrompt = Number.isFinite(llmResult.tokens?.prompt) && llmResult.tokens.prompt > 0 ? llmResult.tokens.prompt : requestTokens;
    const actualOutput = Number.isFinite(llmResult.tokens?.output) && llmResult.tokens.output > 0 ? llmResult.tokens.output : countTokens(llmResult.content);
    requestUsage.status = "completed";
    const providerKnown = llmResult.usageKnown !== false && Number.isFinite(llmResult.tokens?.prompt) && Number.isFinite(llmResult.tokens?.output);
    requestUsage.source = providerKnown ? "provider" : "local-estimate";
    if (providerKnown) {
      requestUsage.inputTokens = llmResult.tokens.prompt;
      requestUsage.outputTokens = llmResult.tokens.output;
      if (Number.isFinite(llmResult.tokens.cachedInput)) requestUsage.cachedInputTokens = llmResult.tokens.cachedInput;
    }
    totalPromptTokens += actualPrompt;
    totalOutputTokens += actualOutput;
    consumedTokens += Math.max(0, actualPrompt - requestTokens) + Math.max(actualOutput, countTokens(llmResult.content));
    if (consumedTokens > config.maxTotalTokens) {
      lastError = "Provider response exceeded remaining total token budget; edits not applied";
      diagnostics.push(lastError);
      break;
    }
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

      if (parsed.moreContextFile) {
        try {
          const file = parsed.moreContextFile;
          const symbol = parsed.moreContextSymbol;
          const key = pageKey(file, symbol);
          let previous = filePages.get(key);
          if (!previous && parsed.moreContextOffset) {
            previous = await compiler.read_evidence({ projectRoot, file, symbol, maxTokens: 300 });
          }
          const offset = parsed.moreContextOffset ?? previous?.nextOffset ?? 0;
          if (previous && offset === previous.totalChars) throw new Error("End of file reached; request a specific offset to reread");
          const page = await compiler.read_evidence({
            projectRoot, ...(previous ? { ref: previous.ref, offset } : { file, symbol }),
            maxTokens: Math.max(300, Math.min(2000, config.maxPromptTokens - 600)),
          });
          filePages.set(key, page);
          // Keep distinct pages while budget permits; replace only identical ranges.
          const existing = promptInput.symbols.findIndex(item => item.ref === page.ref && item.offset === page.offset);
          if (existing >= 0) promptInput.symbols.splice(existing, 1);
          addPage(page, symbol ?? file);
        } catch (error) {
          lastError = `Context read failed: ${error instanceof Error ? error.message : String(error)}`;
          diagnostics.push(lastError);
        }
      }
      continue;
    }

    if (parsed.edits.length === 0) {
      if (config.dryRun) {
        appliedEdits = [];
        succeeded = true;
        break;
      }
      if (!config.taskVerifier) {
        lastError = "No edits proposed; task completion is unverified (taskVerifier required)";
        diagnostics.push(lastError);
        break;
      }
      const proof = await config.taskVerifier(projectRoot, task);
      validated = true;
      validationPassed = proof.passed;
      diagnostics.push(...(proof.diagnostics ?? []));
      if (proof.passed) { succeeded = true; break; }
      lastError = "Task verification failed for empty edit list";
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

        if (readResult.snapshot !== capsule._meta.retrievalSnapshot) {
          throw new Error("Project changed since model evidence was collected; regenerate task context before editing");
        }
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
        if (edit.operation === "replace_symbol" || edit.operation === "replace_function_body") {
          // A full replacement must not discard a tail the model never saw.
          const artifact = filePages.get(pageKey(edit.file, edit.symbol));
          const windows = artifact ? promptInput.symbols.filter(item => item.ref === artifact.ref).sort((a, b) => (a.offset ?? 0) - (b.offset ?? 0)) : [];
          let covered = 0;
          for (const window of windows) {
            if ((window.offset ?? 0) > covered) break;
            covered = Math.max(covered, window.nextOffset ?? 0);
          }
          const completeArtifact = !!artifact && covered === artifact.totalChars;
          const sourceInPrompt = !ev.truncated && ev.source !== undefined && promptInput.symbols.some(item => item.file === edit.file && item.source.includes(ev.source!));
          if (!completeArtifact && !sourceInPrompt) {
            diagnostics.push(`Full source for ${edit.file}:${edit.symbol} is not in the active context; request the symbol pages before replacing it`);
            preparationFailed = true;
            continue;
          }
        }
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
      lastError = diagnostics.slice(-3).join("; ") || "One or more edits could not be prepared atomically";
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
    if (!patchResult.applied && patchResult.rollbackToken) {
      finalRollbackToken = patchResult.rollbackToken;
      throw new Error("Patch failed with retained recovery journal; inspect rollback before retrying");
    }
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
      if (validation.passed && config.taskVerifier) {
        const proof = await config.taskVerifier(projectRoot, task);
        if (!proof.passed) {
          validation.passed = false;
          validation.diagnostics.push({ kind: "test", message: (proof.diagnostics ?? ["Task behavior verification failed"]).join("; ") });
        }
      }
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
      completionEvidence: "unverified",
      usage: { encoding: "cl100k_base", reservedTotalTokens: consumedTokens, requests },
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
    completionEvidence: !succeeded ? "unverified" : config.dryRun ? "proposal" : config.taskVerifier ? "task-verifier" : "project-checks",
    usage: { encoding: "cl100k_base", reservedTotalTokens: consumedTokens, requests },
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
