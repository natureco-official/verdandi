import { getEncoding } from "js-tiktoken";
import { readFileSync, writeFileSync } from "node:fs";
import { TypeScriptContextCompiler } from "./dist/src/context_compiler.js";

const tokenizer = getEncoding("cl100k_base");
const projectRoot = "/Users/gencay/Downloads/capsule";
const compiler = new TypeScriptContextCompiler();

// ── SENARYO A: rankSymbols BM25 ──────────────────────────────
const taskA = "src/context_compiler.ts içindeki rankSymbols fonksiyonunu incele ve BM25 skorlama mantığında bir hata olup olmadığını kontrol et; varsa düzelt.";

// Baseline: Görevin ilgilendiği tam kaynak dosya (src/context_compiler.ts)
const fileAContent = readFileSync(`${projectRoot}/src/context_compiler.ts`, "utf-8");
const baselineTokensA = tokenizer.encode(fileAContent).length;
const baselineCharsA = fileAContent.length;

// Verðandi Compiler Çağrıları:
const capsuleA = await compiler.context_capsule({ projectRoot, task: taskA });
const readSymA = await compiler.read_symbol({ projectRoot, symbol: "rankSymbols", fileHint: "src/context_compiler.ts" });

const capsulePayloadAStr = JSON.stringify(capsuleA, null, 2);
const readSymPayloadAStr = JSON.stringify(readSymA, null, 2);
const totalCapsuleAStr = capsulePayloadAStr + "\n" + readSymPayloadAStr;

const capsuleTokensA = tokenizer.encode(totalCapsuleAStr).length;
const capsuleCharsA = totalCapsuleAStr.length;

writeFileSync(
  `${projectRoot}/benchmark_runs/manual/real_rankSymbols.log`,
  `=== BASELINE ===\nFile: src/context_compiler.ts\nChars: ${baselineCharsA}\nTokens: ${baselineTokensA}\n\n=== CAPSULE ===\n${capsulePayloadAStr}\n\n=== READ_SYMBOL ===\n${readSymPayloadAStr}\n\nTOTAL CAPSULE CHARS: ${capsuleCharsA}\nTOTAL CAPSULE TOKENS: ${capsuleTokensA}\n`
);

// ── SENARYO B: validateToolArguments ─────────────────────────
const taskB = "src/mcp_server.ts içine eklenen validateToolArguments fonksiyonunun tüm 5 MCP aracı için doğru required-alan kontrolü yaptığını doğrula, eksikse tamamla.";

// Baseline: Görevin ilgilendiği tam kaynak dosyalar (src/mcp_server.ts + mcp_tools.ts)
const fileB1 = readFileSync(`${projectRoot}/src/mcp_server.ts`, "utf-8");
const fileB2 = readFileSync(`${projectRoot}/mcp_tools.ts`, "utf-8");
const baselineTextB = fileB1 + "\n" + fileB2;
const baselineTokensB = tokenizer.encode(baselineTextB).length;
const baselineCharsB = baselineTextB.length;

// Verðandi Compiler Çağrıları:
const capsuleB = await compiler.context_capsule({ projectRoot, task: taskB });
const readSymB = await compiler.read_symbol({ projectRoot, symbol: "validateToolArguments", fileHint: "src/mcp_server.ts" });

const capsulePayloadBStr = JSON.stringify(capsuleB, null, 2);
const readSymPayloadBStr = JSON.stringify(readSymB, null, 2);
const totalCapsuleBStr = capsulePayloadBStr + "\n" + readSymPayloadBStr;

const capsuleTokensB = tokenizer.encode(totalCapsuleBStr).length;
const capsuleCharsB = totalCapsuleBStr.length;

writeFileSync(
  `${projectRoot}/benchmark_runs/manual/real_validateToolArguments.log`,
  `=== BASELINE ===\nFiles: src/mcp_server.ts, mcp_tools.ts\nChars: ${baselineCharsB}\nTokens: ${baselineTokensB}\n\n=== CAPSULE ===\n${capsulePayloadBStr}\n\n=== READ_SYMBOL ===\n${readSymPayloadBStr}\n\nTOTAL CAPSULE CHARS: ${capsuleCharsB}\nTOTAL CAPSULE TOKENS: ${capsuleTokensB}\n`
);

console.log(JSON.stringify({
  scenarioA_rankSymbols: {
    task: taskA,
    baselineTokens: baselineTokensA,
    baselineChars: baselineCharsA,
    capsuleTokens: capsuleTokensA,
    capsuleChars: capsuleCharsA
  },
  scenarioB_validateToolArguments: {
    task: taskB,
    baselineTokens: baselineTokensB,
    baselineChars: baselineCharsB,
    capsuleTokens: capsuleTokensB,
    capsuleChars: capsuleCharsB
  }
}, null, 2));
