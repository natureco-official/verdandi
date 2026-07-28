#!/usr/bin/env node
// README'lerdeki ajan tablosunu tek doğruluk kaynağıyla karşılaştırır.
//
// Neden var: antigravity bir kez MCP kaydına eklenip README'de unutuldu ve
// kimse fark etmedi. Tablo elle tutulduğu sürece yine kayacak. Bu kontrol,
// kaydı değiştirip tabloyu güncellemeyeni CI'da durdurur.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const KOK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const oku = (p) => readFileSync(path.join(KOK, p), "utf8");

let hata = 0;
const bildir = (ok, mesaj) => {
  if (!ok) hata++;
  console.log(`  ${ok ? "✓" : "✗"} ${mesaj}`);
};

// 1) MCP kaydı: bin/verdandi-context-compiler içindeki AGENTS anahtarları.
const bin = oku("bin/verdandi-context-compiler");
const govde = bin.slice(bin.indexOf("const AGENTS = {"));
const mcp = new Set();
for (const [, ad] of govde.matchAll(/^ {2}([a-z][a-z0-9-]*): \{$/gm)) mcp.add(ad);

// 2) Prompt enjeksiyonu: run_with_capsule.sh case dalları.
const kabuk = oku("run_with_capsule.sh");
const secim = kabuk.slice(kabuk.indexOf('case "$AGENT" in'), kabuk.indexOf("esac"));
const enjekte = new Set();
for (const [, ad] of secim.matchAll(/^ {2}([a-z][a-z0-9-]*)\)$/gm)) enjekte.add(ad);

console.log(`Kaynak: MCP ${mcp.size} ajan, enjeksiyon ${enjekte.size} ajan`);
bildir(mcp.size > 0, "AGENTS kaydı ayrıştırıldı");
bildir(enjekte.size > 0, "case blokları ayrıştırıldı");

// 3) README tabloları aynı ajanları ve aynı işaretleri taşıyor mu.
// Satır biçimi: | **Ad** | ✅ | ❌ | ... |
const ETIKET = {
  codex: "Codex CLI",
  claude: "Claude Code",
  opencode: "OpenCode",
  natureco: "NatureCo CLI",
  hermes: "Hermes",
  openclaw: "OpenClaw",
  kimi: "Kimi CLI",
  glm: "GLM CLI",
  antigravity: "Antigravity",
};

for (const ad of mcp) {
  bildir(ETIKET[ad] !== undefined, `${ad}: tabloda görünen adı tanımlı`);
}

for (const dosya of ["README.md", "README.tr.md"]) {
  console.log(`\n${dosya}`);
  const metin = oku(dosya);
  const satirlar = new Map();
  for (const [, etiket, a, b] of metin.matchAll(
    /^\|\s*\*\*(.+?)\*\*\s*\|\s*(✅|❌|⚠️)\s*\|\s*(✅|❌|⚠️)\s*\|/gm,
  )) {
    satirlar.set(etiket, { mcp: a, enjekte: b });
  }

  bildir(satirlar.size === mcp.size, `tablo ${satirlar.size} satır, kayıt ${mcp.size} ajan`);

  for (const ad of mcp) {
    const etiket = ETIKET[ad];
    const satir = satirlar.get(etiket);
    if (!satir) {
      bildir(false, `${etiket}: kayıtta var, tabloda YOK`);
      continue;
    }
    // MCP sütunu: kayıtta olan her ajan ✅ ya da ⚠️ olmalı, ❌ olamaz.
    bildir(satir.mcp !== "❌", `${etiket}: MCP sütunu kayıtla tutarlı (${satir.mcp})`);

    // Enjeksiyon sütunu case bloğuyla birebir eşleşmeli.
    const beklenen = enjekte.has(ad) ? "✅" : "❌";
    bildir(
      satir.enjekte === beklenen,
      `${etiket}: enjeksiyon sütunu ${satir.enjekte}, kabukta ${enjekte.has(ad) ? "var" : "yok"}`,
    );
  }

  // Tabloda olup kayıtta olmayan uydurma satır var mı.
  const bilinen = new Set([...mcp].map((a) => ETIKET[a]));
  for (const etiket of satirlar.keys()) {
    if (!bilinen.has(etiket)) bildir(false, `${etiket}: tabloda var, kayıtta YOK`);
  }
}

console.log(hata === 0 ? "\nAjan tablosu kaynakla uyumlu." : `\n${hata} uyumsuzluk.`);
process.exitCode = hata === 0 ? 0 : 1;
