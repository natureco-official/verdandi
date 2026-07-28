import { promises as fs } from "node:fs";
import path from "node:path";
import { getEncoding } from "js-tiktoken";
import { TypeScriptContextCompiler } from "./dist/src/context_compiler.js";

const tokenizer = getEncoding("cl100k_base");
const countTokens = (text) => tokenizer.encode(text).length;

const projectRoot = path.resolve(".");
const task = "Antigravity ajanı için: Kapsül derleyicisi ile bağlam sıkıştırma ve sembol arama";

console.log("=================================================");
console.log("   ANTİGRAVİTY AI AJANI KAPSÜL ENTEGRASYON BENCHMARK  ");
console.log("=================================================\n");
console.log(`Ajan: Antigravity CLI Pair Programmer`);
console.log(`Görev: "${task}"`);
console.log(`Proje Kökü: ${projectRoot}\n`);

// ── 1. ANTIGRAVITY BASELINE (Araçsız - Tam Dosya Okuma) ─────────
const filesToRead = [
  "src/context_compiler.ts",
  "src/verdandi_agent.ts",
  "src/mcp_server.ts",
  "mcp_tools.ts",
  "package.json",
];

let baselineTotalChars = 0;
let baselineExactTokens = 0;
const baselineDetails = [];

for (const file of filesToRead) {
  const content = await fs.readFile(path.join(projectRoot, file), "utf-8");
  const exactTokens = countTokens(content);
  baselineTotalChars += content.length;
  baselineExactTokens += exactTokens;
  baselineDetails.push({ file, chars: content.length, tokens: exactTokens });
}

console.log("1️⃣  ANTİGRAVİTY BASELINE (Kapsülsüz — view_file ile Tam Dosya Yükleme):");
console.log("────────────────────────────────────────────────────────────────────────");
for (const item of baselineDetails) {
  console.log(`  • [view_file] ${item.file.padEnd(25)}: ${item.chars.toString().padStart(6)} karakter = ${item.tokens.toString().padStart(5)} KESİN BPE TOKEN`);
}
console.log(`  ----------------------------------------------------------------------`);
console.log(`  📌 BASELINE SOHBET GEÇMİŞİ YÜKÜ : ${baselineTotalChars} karakter = ${baselineExactTokens} BPE TOKEN\n`);

// ── 2. ANTIGRAVITY + CAPSULE (Araçlı - MCP Kapsül Sembol Yükleme) ─
const compiler = new TypeScriptContextCompiler();
const capsule = await compiler.context_capsule({
  task,
  projectRoot,
  preferredBudgetLevel: 1,
});

let capsuleTotalChars = 0;
let capsuleExactTokens = 0;
const capsuleDetails = [];

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
    capsuleDetails.push({
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

console.log("2️⃣  ANTİGRAVİTY + CAPSULE (Kapsüllü — MCP context_capsule & read_symbol):");
console.log("────────────────────────────────────────────────────────────────────────");
console.log(`  • [context_capsule] Meta Payload   : ${payloadChars} karakter = ${payloadExactTokens} KESİN BPE TOKEN`);
for (const item of capsuleDetails) {
  console.log(`  • [read_symbol] ${item.symbol} (${item.file}:${item.lines}) : ${item.chars.toString().padStart(4)} karakter = ${item.tokens.toString().padStart(3)} KESİN BPE TOKEN`);
}
console.log(`  ----------------------------------------------------------------------`);
console.log(`  📌 CAPSULE SOHBET GEÇMİŞİ YÜKÜ  : ${totalCapsuleChars} karakter = ${totalCapsuleExactTokens} BPE TOKEN\n`);

// ── 3. ANTIGRAVITY KARŞILAŞTIRMA ÖZETİ ─────────────────────────
const tokenSavings = baselineExactTokens - totalCapsuleExactTokens;
const percentSavings = ((tokenSavings / baselineExactTokens) * 100).toFixed(2);
const charRatio = (baselineTotalChars / totalCapsuleChars).toFixed(2);

console.log("3️⃣  ANTİGRAVİTY SOHBET HAFIZASI KESİN TOKEN FARK TABLOSU:");
console.log("────────────────────────────────────────────────────────────────────────");
console.log(`  📊 Antigravity Baseline (Kapsülsüz) : ${baselineExactTokens} BPE TOKEN`);
console.log(`  🎯 Antigravity + Capsule (Kapsüllü)  : ${totalCapsuleExactTokens} BPE TOKEN`);
console.log(`  🔥 Sohbet Hafızası Token Tasarrufu   : ${tokenSavings} BPE TOKEN (%${percentSavings} Azalma)`);
console.log(`  ⚡ İletilen Kod Hacmi Sıkıştırması   : ${charRatio}x daha küçük bağlam`);
console.log("========================================================================\n");
