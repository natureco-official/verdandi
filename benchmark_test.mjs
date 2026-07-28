import { promises as fs } from "node:fs";
import path from "node:path";
import { getEncoding } from "js-tiktoken";
import { TypeScriptContextCompiler } from "./dist/src/context_compiler.js";

// OpenAI / Anthropic / DeepSeek standart BPE Tokenizer (cl100k_base)
const tokenizer = getEncoding("cl100k_base");
const countTokens = (text) => tokenizer.encode(text).length;

const projectRoot = path.resolve(".");
const task = "Import sıralamasını kontrol et ve linter durumunu raporla";

console.log("=================================================");
console.log("   SENTETİK BAĞLAM HACMİ — TIKTOKEN ÖLÇÜMÜ      ");
console.log("=================================================\n");
console.log(`Görev: "${task}"`);
console.log(`Proje: ${projectRoot}\n`);

// ── 1. BASELINE (Kapsülsüz — Tam Dosya Okuma Yaklaşımı) ───────────
const baselineFiles = [
  "src/context_compiler.ts",
  "src/verdandi_agent.ts",
  "src/mcp_server.ts",
  "mcp_tools.ts",
  "package.json",
];

let baselineTotalChars = 0;
let baselineExactTokens = 0;
const baselineFileSizes = [];

for (const file of baselineFiles) {
  const content = await fs.readFile(path.join(projectRoot, file), "utf-8");
  const exactTokens = countTokens(content);
  baselineTotalChars += content.length;
  baselineExactTokens += exactTokens;
  baselineFileSizes.push({ file, chars: content.length, tokens: exactTokens });
}

console.log("1️⃣  BASELINE (Kapsülsüz — Tam Dosya Okuma Yaklaşımı):");
console.log("───────────────────────────────────────────────────");
for (const item of baselineFileSizes) {
  console.log(`  • ${item.file.padEnd(25)}: ${item.chars.toString().padStart(6)} karakter = ${item.tokens.toString().padStart(5)} KESİN TOKEN`);
}
console.log(`  -------------------------------------------------`);
console.log(`  📌 BASELINE KESİN TOPLAM   : ${baselineTotalChars} karakter = ${baselineExactTokens} TOKEN\n`);

// ── 2. CAPSULE (Auto-Inject / URDR Context Compiler) ─────────
const compiler = new TypeScriptContextCompiler();
const capsule = await compiler.context_capsule({
  task,
  projectRoot,
  preferredBudgetLevel: 1,
});

let capsuleTotalChars = 0;
let capsuleExactTokens = 0;
const symbolSources = [];

for (const ref of capsule.modelPayload.relevantSymbols.slice(0, 8)) {
  const readRes = await compiler.read_symbol({
    projectRoot,
    symbol: ref.symbol,
    fileHint: ref.file,
    maxTokens: 600,
    includeBody: true,
  });
  if (readRes.evidence.length > 0) {
    const ev = readRes.evidence[0];
    const codeBlock = ev.source || ev.signature || "";
    const exactTokens = countTokens(codeBlock);
    capsuleTotalChars += codeBlock.length;
    capsuleExactTokens += exactTokens;
    symbolSources.push({
      symbol: ref.symbol,
      file: ref.file,
      lines: `${ev.startLine}-${ev.endLine}`,
      chars: codeBlock.length,
      tokens: exactTokens,
    });
  }
}

const payloadStr = JSON.stringify(capsule.modelPayload);
const payloadChars = payloadStr.length;
const payloadExactTokens = countTokens(payloadStr);

const totalCapsuleChars = capsuleTotalChars + payloadChars;
const totalCapsuleExactTokens = capsuleExactTokens + payloadExactTokens;

console.log("2️⃣  CAPSULE (Kapsüllü — AST + Smart Slice Yaklaşımı):");
console.log("───────────────────────────────────────────────────");
console.log(`  • Kapsül Meta Payload     : ${payloadChars} karakter = ${payloadExactTokens} KESİN TOKEN`);
for (const item of symbolSources) {
  console.log(`  • [Sembol] ${item.symbol} (${item.file}:${item.lines}) : ${item.chars.toString().padStart(4)} karakter = ${item.tokens.toString().padStart(3)} KESİN TOKEN`);
}
console.log(`  -------------------------------------------------`);
console.log(`  📌 CAPSULE KESİN TOPLAM    : ${totalCapsuleChars} karakter = ${totalCapsuleExactTokens} TOKEN\n`);

// ── 3. NET KARŞILAŞTIRMA VE TASARRUF ANALİZİ ──────────────────
const tokenSavings = baselineExactTokens - totalCapsuleExactTokens;
const percentSavings = ((tokenSavings / baselineExactTokens) * 100).toFixed(2);
const charRatio = (baselineTotalChars / totalCapsuleChars).toFixed(2);

console.log("3️⃣  SEÇİLMİŞ DOSYALAR İÇİN HACİM KARŞILAŞTIRMASI:");
console.log("───────────────────────────────────────────────────");
console.log(`  📊 Baseline Kesin Token (Tam Okuma) : ${baselineExactTokens} TOKEN`);
console.log(`  🎯 Capsule Kesin Token (Akıllı Dilim) : ${totalCapsuleExactTokens} TOKEN`);
console.log(`  🔥 Net Kesin Token Tasarrufu        : ${tokenSavings} TOKEN (%${percentSavings} Azalma)`);
console.log(`  ⚡ Kod Hacmi Sıkıştırma Oranı       : ${charRatio}x daha küçük bağlam`);
console.log("  ⚠️  Bu sonuç uçtan uca ajan token maliyeti veya kalite eşdeğerliği değildir.");
console.log("=================================================\n");
