/**
 * Verðandi Context Compiler MCP contracts — v0.2.0
 *
 * MCP traffic uses the snake_case wire contracts in this file. Application
 * code uses camelCase domain contracts. `mapContextCapsule` is the single
 * serialization/deserialization boundary between them. An adapter may map
 * `modelPayload` to model-visible content and MUST keep `_meta` adapter-only.
 */

export type BudgetLevel = 0 | 1 | 2 | 3;
export type SymbolKind =
  | "function"
  | "method"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "variable"
  | "module"
  | "test"
  | "unknown";

export type SymbolRelation =
  | "direct_match"
  | "caller"
  | "callee"
  | "importer"
  | "imported"
  | "test_target"
  | "tested_by"
  | "type_dependency";

export interface SymbolReference {
  symbol: string;
  file: string;
  kind: SymbolKind;
  /** Direct matches are 0; required call-graph neighbors are 1. */
  hopDistance: 0 | 1;
  relation: SymbolRelation;
  score?: number;
}

export interface CapsuleDecision {
  summary: string;
  urdrLeafId?: string;
}

export interface ModelTaskCapsule {
  goal: string;
  /** Must contain direct matches and relevant 1-hop call-graph neighbors. */
  relevantSymbols: SymbolReference[];
  probableFiles: string[];
  decisions: CapsuleDecision[];
  successCriteria: string[];
  /**
   * Seçimin zayıf olduğu, YALNIZCA zayıfken bildirilir.
   *
   * Derleyici belirsizliği zaten hesaplıyordu ama sonucu `_meta`'ya
   * koyuyordu — ajanın karar verirken okuduğu yer `model_payload`. Ölçüldü
   * (30 Temmuz 2026, natureco-skuld): doğal dille sorulan bir görevde alakasız
   * bir dosya 0.851 skorla döndü, `uncertaintyReasons` "Sorgu terimlerinin azı
   * sembol/path ile örtüşüyor" diyordu ve bu ajana hiç ulaşmadı. Yüksek skorlu
   * yanlış cevap, düşük skorlu yanlış cevaptan tehlikelidir: geri çekilme
   * sinyali yoktur.
   *
   * Alan yokken kapsül eskisiyle birebir aynı — belirsizlik yoksa token da
   * harcanmaz, ve alanın VARLIĞI tek başına bir uyarıdır.
   */
  retrievalWeak?: string;
}

export interface ContextCompilerMeta {
  estimatedPayloadTokens: number;
  /** Kırpmaya rağmen bütçe tutmadıysa bulunur; sessiz aşım olmasın diye. */
  payloadBudgetExceeded?: boolean;
  retrievalConfidence: number;
  uncertaintyReasons: string[];
  selectedBudgetLevel: BudgetLevel;
  silentEscalation: boolean;
  /** Attempts already consumed. Reaching the maximum forbids another retry. */
  escalationAttempt: number;
  /** Defaults to 3 and must be at least 1. */
  maxEscalationAttempts: number;
  handoffRequired: boolean;
  handoffReason?: string;
  retrievalSnapshot?: string;
}

export interface ContextCapsuleInput {
  task: string;
  projectRoot: string;
  preferredBudgetLevel?: BudgetLevel;
  maxModelPayloadTokens?: number;
  escalationAttempt?: number;
  maxEscalationAttempts?: number;
}

export interface ContextCapsuleOutput {
  schemaVersion: "0.2.0";
  taskId: string;
  /** The only portion that may be rendered into model context. */
  modelPayload: ModelTaskCapsule;
  /**
   * Adapter-only control data. Never serialize this into model-visible text.
   * confidence < 0.72 MUST silently force level 3 before model invocation.
   */
  _meta: ContextCompilerMeta;
}

/** Exact JSON/MCP wire representation; intentionally snake_case. */
export interface ContextCapsuleWire {
  schema_version: "0.2.0";
  task_id: string;
  model_payload: {
    goal: string;
    relevant_symbols: Array<{
      symbol: string;
      file: string;
      kind: SymbolKind;
      hop_distance: 0 | 1;
      relation: SymbolRelation;
      score?: number;
    }>;
    probable_files: string[];
    decisions: Array<{
      summary: string;
      urdr_leaf_id?: string;
    }>;
    success_criteria: string[];
    /** Yalnızca seçim zayıfken bulunur; varlığı tek başına uyarıdır. */
    retrieval_weak?: string;
  };
  control: {
    estimated_payload_tokens: number;
    retrieval_confidence: number;
    uncertainty_reasons: string[];
    selected_budget_level: BudgetLevel;
    silent_escalation: boolean;
    escalation_attempt: number;
    max_escalation_attempts: number;
    handoff_required: boolean;
    handoff_reason?: string;
    retrieval_snapshot?: string;
  };
}

export function mapContextCapsule(
  value: ContextCapsuleOutput,
  direction: "serialize",
): ContextCapsuleWire;
export function mapContextCapsule(
  value: ContextCapsuleWire,
  direction: "deserialize",
): ContextCapsuleOutput;
export function mapContextCapsule(
  value: ContextCapsuleOutput | ContextCapsuleWire,
  direction: "serialize" | "deserialize",
): ContextCapsuleOutput | ContextCapsuleWire {
  if (direction === "serialize") {
    const domain = value as ContextCapsuleOutput;
    const attempt = domain._meta.escalationAttempt ?? 0;
    const maximum = domain._meta.maxEscalationAttempts ?? 3;
    if (attempt < 0 || maximum < 1) {
      throw new RangeError("Invalid escalation attempt bounds");
    }
    if (!Number.isInteger(attempt) || !Number.isInteger(maximum) || attempt > 10 || maximum > 10) {
      throw new RangeError("Escalation attempt bounds must be integers between 0 and 10");
    }
    if (domain._meta.retrievalConfidence < 0 || domain._meta.retrievalConfidence > 1) {
      throw new RangeError("retrievalConfidence must be between 0 and 1");
    }
    for (const symbol of domain.modelPayload.relevantSymbols) {
      if (symbol.score !== undefined && (symbol.score < 0 || symbol.score > 1 || !Number.isFinite(symbol.score))) {
        throw new RangeError("Public symbol scores must be normalized between 0 and 1");
      }
    }
    const handoffRequired = domain._meta.handoffRequired || attempt >= maximum;
    const selectedBudgetLevel =
      handoffRequired || domain._meta.retrievalConfidence < 0.72
        ? 3
        : domain._meta.selectedBudgetLevel;

    return {
      schema_version: "0.2.0",
      task_id: domain.taskId,
      model_payload: {
        goal: domain.modelPayload.goal,
        relevant_symbols: domain.modelPayload.relevantSymbols.map(symbol => ({
          symbol: symbol.symbol,
          file: symbol.file,
          kind: symbol.kind,
          hop_distance: symbol.hopDistance,
          relation: symbol.relation,
          ...(symbol.score === undefined ? {} : { score: symbol.score }),
        })),
        probable_files: domain.modelPayload.probableFiles,
        decisions: domain.modelPayload.decisions.map(decision => ({
          summary: decision.summary,
          ...(decision.urdrLeafId === undefined
            ? {}
            : { urdr_leaf_id: decision.urdrLeafId }),
        })),
        success_criteria: domain.modelPayload.successCriteria,
        ...(domain.modelPayload.retrievalWeak === undefined
          ? {}
          : { retrieval_weak: domain.modelPayload.retrievalWeak }),
      },
      control: {
        estimated_payload_tokens: domain._meta.estimatedPayloadTokens,
        retrieval_confidence: domain._meta.retrievalConfidence,
        uncertainty_reasons: domain._meta.uncertaintyReasons,
        selected_budget_level: selectedBudgetLevel,
        silent_escalation:
          domain._meta.silentEscalation ||
          domain._meta.retrievalConfidence < 0.72,
        escalation_attempt: attempt,
        max_escalation_attempts: maximum,
        handoff_required: handoffRequired,
        ...(domain._meta.handoffReason === undefined
          ? {}
          : { handoff_reason: domain._meta.handoffReason }),
        ...(domain._meta.retrievalSnapshot === undefined
          ? {}
          : { retrieval_snapshot: domain._meta.retrievalSnapshot }),
      },
    };
  }

  const wire = value as ContextCapsuleWire;
  const attempt = wire.control?.escalation_attempt ?? 0;
  const maximum = wire.control?.max_escalation_attempts ?? 3;
  if (attempt < 0 || maximum < 1) {
    throw new RangeError("Invalid escalation attempt bounds");
  }
  if (!Number.isInteger(attempt) || !Number.isInteger(maximum) || attempt > 10 || maximum > 10) {
    throw new RangeError("Escalation attempt bounds must be integers between 0 and 10");
  }
  if (wire.control.retrieval_confidence < 0 || wire.control.retrieval_confidence > 1) {
    throw new RangeError("retrieval_confidence must be between 0 and 1");
  }
  for (const symbol of wire.model_payload.relevant_symbols) {
    if (symbol.score !== undefined && (symbol.score < 0 || symbol.score > 1 || !Number.isFinite(symbol.score))) {
      throw new RangeError("Public symbol scores must be normalized between 0 and 1");
    }
  }
  const handoffRequired = wire.control.handoff_required || attempt >= maximum;
  const selectedBudgetLevel =
    handoffRequired || wire.control.retrieval_confidence < 0.72
      ? 3
      : wire.control.selected_budget_level;

  return {
    schemaVersion: "0.2.0",
    taskId: wire.task_id,
    modelPayload: {
      goal: wire.model_payload.goal,
      relevantSymbols: wire.model_payload.relevant_symbols.map(symbol => ({
        symbol: symbol.symbol,
        file: symbol.file,
        kind: symbol.kind,
        hopDistance: symbol.hop_distance,
        relation: symbol.relation,
        ...(symbol.score === undefined ? {} : { score: symbol.score }),
      })),
      probableFiles: wire.model_payload.probable_files,
      decisions: wire.model_payload.decisions.map(decision => ({
        summary: decision.summary,
        ...(decision.urdr_leaf_id === undefined
          ? {}
          : { urdrLeafId: decision.urdr_leaf_id }),
      })),
      successCriteria: wire.model_payload.success_criteria,
      // Gidiş-dönüş simetrik olmalı: serialize edip deserialize edince uyarı
      // kaybolursa, kapsülü diskte/kuyrukta taşıyan her yol onu sessizce
      // düşürür.
      ...(wire.model_payload.retrieval_weak === undefined
        ? {}
        : { retrievalWeak: wire.model_payload.retrieval_weak }),
    },
    _meta: {
      estimatedPayloadTokens: wire.control.estimated_payload_tokens,
      retrievalConfidence: wire.control.retrieval_confidence,
      uncertaintyReasons: wire.control.uncertainty_reasons,
      selectedBudgetLevel,
      silentEscalation:
        wire.control.silent_escalation ||
        wire.control.retrieval_confidence < 0.72,
      escalationAttempt: attempt,
      maxEscalationAttempts: maximum,
      handoffRequired,
      ...(wire.control.handoff_reason === undefined
        ? {}
        : { handoffReason: wire.control.handoff_reason }),
      ...(wire.control.retrieval_snapshot === undefined
        ? {}
        : { retrievalSnapshot: wire.control.retrieval_snapshot }),
    },
  };
}

export interface ReadSymbolInput {
  projectRoot: string;
  symbol: string;
  fileHint?: string;
  snapshot?: string;
  includeSignature?: boolean;
  includeBody?: boolean;
  includeCallGraphNeighbors?: boolean;
  maxTokens?: number;
}

export interface EvidenceWindow {
  symbol: SymbolReference;
  signature?: string;
  source?: string;
  startLine: number;
  endLine: number;
  contentHash: string;
  /** Hash of the complete source file, used by structured patch preconditions. */
  fileContentHash?: string;
  truncated: boolean;
}

export interface ReadSymbolOutput {
  evidence: EvidenceWindow[];
  estimatedTokens: number;
  snapshot: string;
  confidence: number;
  ambiguity: string[];
  requiresEscalation: boolean;
}

export interface PatchPrecondition {
  file: string;
  contentHash: string;
  symbol?: string;
  symbolHash?: string;
}

export type StructuredPatchOperation =
  | {
      operation: "replace_function_body";
      file: string;
      symbol: string;
      newBody: string;
      precondition: PatchPrecondition;
    }
  | {
      operation: "replace_symbol";
      file: string;
      symbol: string;
      replacement: string;
      precondition: PatchPrecondition;
    }
  | {
      operation: "insert_before_symbol" | "insert_after_symbol";
      file: string;
      symbol: string;
      content: string;
      precondition: PatchPrecondition;
    }
  | {
      operation: "delete_symbol";
      file: string;
      symbol: string;
      precondition: PatchPrecondition;
    };

export interface ApplyStructuredPatchInput {
  projectRoot: string;
  taskId: string;
  snapshot: string;
  language: "typescript";
  operations: StructuredPatchOperation[];
  dryRun?: boolean;
}

export interface PatchDiagnostic {
  operationIndex: number;
  code:
    | "STALE_SNAPSHOT"
    | "PRECONDITION_FAILED"
    | "SYMBOL_NOT_FOUND"
    | "AMBIGUOUS_SYMBOL"
    | "PARSE_FAILED"
    | "UNSUPPORTED_OPERATION"
    | "WRITE_FAILED";
  message: string;
}

export interface ApplyStructuredPatchOutput {
  applied: boolean;
  changedFiles: string[];
  unifiedDiffSummary: string;
  diagnostics: PatchDiagnostic[];
  rollbackToken?: string;
  requiresEscalation: boolean;
}

export type ValidationKind = "test" | "lint" | "typecheck" | "build";

export interface ValidateDeltaInput {
  projectRoot: string;
  taskId: string;
  kinds: ValidationKind[];
  /** Explicitly authorize the project's package scripts ("package-scripts"). */
  commandProfile?: string;
  maxDiagnostics?: number;
  maxOutputTokens?: number;
}

export interface CompactValidationDiagnostic {
  kind: ValidationKind;
  file?: string;
  line?: number;
  column?: number;
  code?: string;
  expected?: string;
  actual?: string;
  message: string;
}

export interface ValidateDeltaOutput {
  passed: boolean;
  summary: string;
  checks: Array<{
    kind: ValidationKind;
    passed: boolean;
    total?: number;
    failed?: number;
    durationMs: number;
  }>;
  diagnostics: CompactValidationDiagnostic[];
  omittedDiagnosticCount: number;
  estimatedOutputTokens: number;
  requiresEscalation: boolean;
}

export interface RollbackPatchInput {
  projectRoot: string;
  rollbackToken: string;
}

export interface RollbackPatchOutput {
  reverted: boolean;
  revertedFiles: string[];
  message: string;
}

export interface ContextCompilerTools {
  context_capsule(input: ContextCapsuleInput): Promise<ContextCapsuleOutput>;
  read_symbol(input: ReadSymbolInput): Promise<ReadSymbolOutput>;
  apply_structured_patch(
    input: ApplyStructuredPatchInput,
  ): Promise<ApplyStructuredPatchOutput>;
  rollback_patch(input: RollbackPatchInput): Promise<RollbackPatchOutput>;
  validate_delta(input: ValidateDeltaInput): Promise<ValidateDeltaOutput>;
}

/** MCP registration names shared by the stdio server and Codex adapter. */
export const MCP_TOOL_NAMES = [
  "context_capsule",
  "read_symbol",
  "apply_structured_patch",
  "rollback_patch",
  "validate_delta",
] as const;

export type McpToolName = (typeof MCP_TOOL_NAMES)[number];
