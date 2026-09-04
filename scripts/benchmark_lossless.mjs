#!/usr/bin/env node
/** Synthetic transport benchmark, not an end-to-end model quality benchmark. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { TypeScriptContextCompiler } from "../dist/src/context_compiler.js";
import { countTokens, TOKEN_ENCODING } from "../dist/src/token_budget.js";
import { applyEvidenceDelta } from "../dist/src/evidence_delta.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "verdandi-transport-benchmark-"));
try {
  const source = Array.from({ length: 6000 }, (_, index) =>
    `export function invoice${index}(amount: number) { return amount * 1.20; }`).join("\n") + "\n";
  const file = path.join(root, "invoice.ts");
  await fs.writeFile(file, source);
  const compiler = new TypeScriptContextCompiler();
  let page = await compiler.read_evidence({ projectRoot: root, file: "invoice.ts", maxTokens: 1000 });
  const ref = page.ref;
  const firstPageTokens = countTokens(page);
  let restored = "", allPagesTokens = 0, pages = 0;
  while (true) {
    const tokens = countTokens(page);
    assert.ok(tokens <= 1000);
    allPagesTokens += tokens;
    pages++;
    restored += page.source;
    if (page.done) break;
    page = await compiler.read_evidence({ projectRoot: root, ref, offset: page.nextOffset, maxTokens: 1000 });
  }
  assert.equal(restored, source);
  const known = await compiler.read_evidence({ projectRoot: root, file: "invoice.ts", knownRef: ref, maxTokens: 1000 });
  assert.equal(known.unchanged, true);
  const updated = source.replace("invoice3000(amount: number) { return amount * 1.20; }", "invoice3000(amount: number) { return amount * 1.18; }");
  assert.notEqual(updated, source);
  await fs.writeFile(file, updated);
  const delta = await compiler.read_evidence({ projectRoot: root, file: "invoice.ts", previousRef: ref, maxTokens: 1000 });
  assert.equal(delta.done, true);
  assert.equal(applyEvidenceDelta(source, JSON.parse(delta.source)), updated);
  console.log(JSON.stringify({
    schemaVersion: 1, kind: "synthetic-transport-only", encoding: TOKEN_ENCODING,
    sourceTokens: countTokens(source), firstPageTokens, unchangedTokens: countTokens(known),
    deltaPageTokens: countTokens(delta), pages, allPagesTokens,
    exactRecovery: true, exactDeltaRecovery: true,
    modelCalls: 0, taskQualityMeasured: false,
    limitation: "Reading every page costs allPagesTokens; first-page reduction does not prove task savings or quality parity.",
  }, null, 2));
} finally { await fs.rm(root, { recursive: true, force: true }); }
