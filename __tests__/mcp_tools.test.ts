import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mapContextCapsule, type ContextCapsuleOutput, type ContextCapsuleWire } from "../mcp_tools.js";

function makeDomain(overrides: Partial<ContextCapsuleOutput> = {}): ContextCapsuleOutput {
  return {
    schemaVersion: "0.2.0",
    taskId: "abc123",
    modelPayload: {
      goal: "test goal",
      relevantSymbols: [
        { symbol: "foo", file: "src/foo.ts", kind: "function", hopDistance: 0, relation: "direct_match", score: 0.5 },
      ],
      probableFiles: ["src/foo.ts"],
      decisions: [{ summary: "test decision" }],
      successCriteria: ["test passes"],
    },
    _meta: {
      estimatedPayloadTokens: 100,
      retrievalConfidence: 0.85,
      uncertaintyReasons: [],
      selectedBudgetLevel: 1,
      silentEscalation: false,
      escalationAttempt: 0,
      maxEscalationAttempts: 3,
      handoffRequired: false,
    },
    ...overrides,
  };
}

describe("mapContextCapsule", () => {
  describe("serialize (domain -> wire)", () => {
    it("snake_case wire format uretir", () => {
      const domain = makeDomain();
      const wire = mapContextCapsule(domain, "serialize") as ContextCapsuleWire;

      assert.equal(wire.schema_version, "0.2.0");
      assert.equal(wire.task_id, "abc123");
      assert.equal(wire.model_payload.goal, "test goal");
      assert.equal(wire.model_payload.relevant_symbols[0].symbol, "foo");
      assert.equal(wire.model_payload.relevant_symbols[0].hop_distance, 0);
      assert.equal(wire.control.estimated_payload_tokens, 100);
      assert.equal(wire.control.retrieval_confidence, 0.85);
      assert.equal(wire.control.selected_budget_level, 1);
      assert.equal(wire.control.silent_escalation, false);
      assert.equal(wire.control.escalation_attempt, 0);
      assert.equal(wire.control.max_escalation_attempts, 3);
      assert.equal(wire.control.handoff_required, false);
    });

    it("camelCase ozellikleri donusturur", () => {
      const domain = makeDomain();
      const wire = mapContextCapsule(domain, "serialize") as ContextCapsuleWire;

      assert.equal(wire.model_payload.relevant_symbols[0].hop_distance, 0);
      assert.equal(wire.model_payload.relevant_symbols[0].relation, "direct_match");
      assert.ok(!("hopDistance" in wire.model_payload.relevant_symbols[0]));
    });

    it("score optionals korunur", () => {
      const domain = makeDomain();
      const wire = mapContextCapsule(domain, "serialize") as ContextCapsuleWire;

      assert.equal(wire.model_payload.relevant_symbols[0].score, 0.5);
    });

    it("score undefined ise wire'da olmaz", () => {
      const domain = makeDomain();
      domain.modelPayload.relevantSymbols[0].score = undefined;
      const wire = mapContextCapsule(domain, "serialize") as ContextCapsuleWire;

      assert.ok(!("score" in wire.model_payload.relevant_symbols[0]));
    });

    it("handoffReason optionals korunur", () => {
      const domain = makeDomain();
      domain._meta.handoffReason = "limit reached";
      const wire = mapContextCapsule(domain, "serialize") as ContextCapsuleWire;

      assert.equal(wire.control.handoff_reason, "limit reached");
    });

    it("retrievalSnapshot optionals korunur", () => {
      const domain = makeDomain();
      domain._meta.retrievalSnapshot = "hash123";
      const wire = mapContextCapsule(domain, "serialize") as ContextCapsuleWire;

      assert.equal(wire.control.retrieval_snapshot, "hash123");
    });

    it("dusuk confidence'da budget level 3'e zorlanir", () => {
      const domain = makeDomain();
      domain._meta.retrievalConfidence = 0.5;
      domain._meta.selectedBudgetLevel = 1;
      const wire = mapContextCapsule(domain, "serialize") as ContextCapsuleWire;

      assert.equal(wire.control.selected_budget_level, 3);
      assert.equal(wire.control.silent_escalation, true);
    });

    it("handoff gerekliyse budget level 3'e zorlanir", () => {
      const domain = makeDomain();
      domain._meta.handoffRequired = true;
      domain._meta.selectedBudgetLevel = 0;
      const wire = mapContextCapsule(domain, "serialize") as ContextCapsuleWire;

      assert.equal(wire.control.selected_budget_level, 3);
      assert.equal(wire.control.handoff_required, true);
    });

    it("escalation attempt sinirdaysa handoffRequired true", () => {
      const domain = makeDomain();
      domain._meta.escalationAttempt = 3;
      domain._meta.maxEscalationAttempts = 3;
      const wire = mapContextCapsule(domain, "serialize") as ContextCapsuleWire;

      assert.equal(wire.control.handoff_required, true);
    });

    it("negatif escalation attempt ile RangeError firlatir", () => {
      const domain = makeDomain();
      domain._meta.escalationAttempt = -1;
      assert.throws(() => mapContextCapsule(domain, "serialize"), RangeError);
    });

    it("gecersiz maxEscalationAttempts ile RangeError firlatir", () => {
      const domain = makeDomain();
      domain._meta.maxEscalationAttempts = 0;
      assert.throws(() => mapContextCapsule(domain, "serialize"), RangeError);
    });
  });

  describe("deserialize (wire -> domain)", () => {
    it("camelCase domain format uretir", () => {
      const wire: ContextCapsuleWire = {
        schema_version: "0.2.0",
        task_id: "wire123",
        model_payload: {
          goal: "wire goal",
          relevant_symbols: [
            { symbol: "bar", file: "src/bar.ts", kind: "class", hop_distance: 1, relation: "callee", score: 0.3 },
          ],
          probable_files: ["src/bar.ts"],
          decisions: [{ summary: "wire decision" }],
          success_criteria: ["wire passes"],
        },
        control: {
          estimated_payload_tokens: 50,
          retrieval_confidence: 0.9,
          uncertainty_reasons: [],
          selected_budget_level: 2,
          silent_escalation: false,
          escalation_attempt: 1,
          max_escalation_attempts: 3,
          handoff_required: false,
        },
      };

      const domain = mapContextCapsule(wire, "deserialize");

      assert.equal(domain.schemaVersion, "0.2.0");
      assert.equal(domain.taskId, "wire123");
      assert.equal(domain.modelPayload.goal, "wire goal");
      assert.equal(domain.modelPayload.relevantSymbols[0].hopDistance, 1);
      assert.equal(domain._meta.estimatedPayloadTokens, 50);
      assert.equal(domain._meta.selectedBudgetLevel, 2);
    });

    it("gecersiz escalation attempt ile RangeError firlatir", () => {
      const wire: ContextCapsuleWire = {
        schema_version: "0.2.0",
        task_id: "bad",
        model_payload: { goal: "", relevant_symbols: [], probable_files: [], decisions: [], success_criteria: [] },
        control: {
          estimated_payload_tokens: 0,
          retrieval_confidence: 0,
          uncertainty_reasons: [],
          selected_budget_level: 0,
          silent_escalation: false,
          escalation_attempt: -1,
          max_escalation_attempts: 3,
          handoff_required: false,
        },
      };

      assert.throws(() => mapContextCapsule(wire, "deserialize"), RangeError);
    });
  });

  describe("roundtrip (serialize -> deserialize)", () => {
    it("domain -> wire -> domain birebir eslesir", () => {
      const original = makeDomain();
      const wire = mapContextCapsule(original, "serialize");
      const roundtripped = mapContextCapsule(wire, "deserialize");

      assert.equal(roundtripped.schemaVersion, original.schemaVersion);
      assert.equal(roundtripped.taskId, original.taskId);
      assert.equal(roundtripped.modelPayload.goal, original.modelPayload.goal);
      assert.equal(roundtripped.modelPayload.relevantSymbols.length, original.modelPayload.relevantSymbols.length);
      assert.equal(roundtripped._meta.estimatedPayloadTokens, original._meta.estimatedPayloadTokens);
      assert.equal(roundtripped._meta.retrievalConfidence, original._meta.retrievalConfidence);
    });

    it("wire -> domain -> wire birebir eslesir", () => {
      const original: ContextCapsuleWire = {
        schema_version: "0.2.0",
        task_id: "rt123",
        model_payload: {
          goal: "roundtrip goal",
          relevant_symbols: [
            { symbol: "baz", file: "src/baz.ts", kind: "type", hop_distance: 0, relation: "imported" },
          ],
          probable_files: ["src/baz.ts"],
          decisions: [{ summary: "rt decision", urdr_leaf_id: "leaf-1" }],
          success_criteria: ["rt passes"],
        },
        control: {
          estimated_payload_tokens: 75,
          retrieval_confidence: 0.78,
          uncertainty_reasons: ["maybe"],
          selected_budget_level: 1,
          silent_escalation: false,
          escalation_attempt: 2,
          max_escalation_attempts: 3,
          handoff_required: false,
          handoff_reason: undefined,
          retrieval_snapshot: "snap-abc",
        },
      };

      const domain = mapContextCapsule(original, "deserialize");
      const wire = mapContextCapsule(domain, "serialize");

      assert.equal(wire.task_id, original.task_id);
      assert.equal(wire.model_payload.goal, original.model_payload.goal);
      assert.equal(wire.control.estimated_payload_tokens, original.control.estimated_payload_tokens);
      assert.equal(wire.control.retrieval_snapshot, "snap-abc");
    });
  });
});
