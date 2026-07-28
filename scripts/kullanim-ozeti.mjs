#!/usr/bin/env node
// Kullanım kaydını okunur bir özete çevirir.
//
// Kayıt tek başına işe yaramaz: kimse binlerce satır JSONL okumaz. Bu betik
// "gerçek kullanımda ne bozuluyor" sorusunun cevabını üste çıkarır — hatalar,
// devredilen görevler, düşük güvenli çağrılar ve tekrarlayan belirsizlik
// gerekçeleri.
//
// Kullanım: node scripts/kullanim-ozeti.mjs [kayit-yolu]

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const KOK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const YOL = process.argv[2] ?? process.env.VERDANDI_USAGE_LOG_PATH ?? path.join(KOK, ".verdandi", "usage.jsonl");

if (!existsSync(YOL)) {
  console.log(`Kayıt yok: ${YOL}`);
  console.log("Sunucu hiç çağrılmamış ya da kayıt VERDANDI_USAGE_LOG=0 ile kapalı.");
  process.exit(0);
}

const kayitlar = readFileSync(YOL, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((s) => {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  })
  .filter(Boolean);

if (kayitlar.length === 0) {
  console.log("Kayıt dosyası boş.");
  process.exit(0);
}

const sayi = (liste) => liste.length;
const ortanca = (liste) => {
  if (liste.length === 0) return null;
  const s = [...liste].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const yuzde = (a, b) => (b === 0 ? "—" : `%${((a / b) * 100).toFixed(1)}`);

const ilk = kayitlar[0].t;
const son = kayitlar[kayitlar.length - 1].t;

console.log(`\nVerðandi kullanım özeti — ${kayitlar.length} çağrı`);
console.log(`${ilk} → ${son}`);
console.log(`Kaynak: ${YOL}\n`);

// Araç bazında
const araclar = {};
for (const k of kayitlar) (araclar[k.arac] ??= []).push(k);

console.log("Araç bazında");
console.log("─".repeat(64));
for (const [ad, liste] of Object.entries(araclar).sort((a, b) => b[1].length - a[1].length)) {
  const sureler = liste.map((k) => k.sureMs).filter((n) => typeof n === "number");
  const hatalar = liste.filter((k) => k.hata);
  console.log(
    `  ${ad.padEnd(24)} ${String(liste.length).padStart(4)} çağrı  ` +
      `ortanca ${String(ortanca(sureler) ?? "—").padStart(5)} ms  ` +
      `hata ${String(hatalar.length).padStart(3)} (${yuzde(hatalar.length, liste.length)})`,
  );
}

// Sorun sinyalleri
const hatali = kayitlar.filter((k) => k.hata);
const devredilen = kayitlar.filter((k) => k.devredildi === true);
const guvenler = kayitlar.map((k) => k.guven).filter((n) => typeof n === "number");
const dusukGuven = guvenler.filter((g) => g < 0.72);

console.log("\nSorun sinyalleri");
console.log("─".repeat(64));
console.log(`  hata dönen çağrı        ${sayi(hatali)} (${yuzde(sayi(hatali), kayitlar.length)})`);
console.log(`  devredilen / eskalasyon ${sayi(devredilen)} (${yuzde(sayi(devredilen), kayitlar.length)})`);
console.log(
  `  güven eşiğin altında    ${sayi(dusukGuven)} / ${guvenler.length}` +
    ` (${yuzde(sayi(dusukGuven), guvenler.length)})   ortanca güven: ${ortanca(guvenler) ?? "—"}`,
);

// Tekrarlayan belirsizlik gerekçeleri — düzeltilecek şeyin adresi burasıdır.
const gerekceler = {};
for (const k of kayitlar) for (const g of k.belirsizlik ?? []) gerekceler[g] = (gerekceler[g] ?? 0) + 1;
const sirali = Object.entries(gerekceler).sort((a, b) => b[1] - a[1]).slice(0, 8);

if (sirali.length > 0) {
  console.log("\nEn sık belirsizlik gerekçeleri");
  console.log("─".repeat(64));
  for (const [gerekce, adet] of sirali) {
    console.log(`  ${String(adet).padStart(4)}×  ${gerekce.slice(0, 56)}`);
  }
}

if (hatali.length > 0) {
  console.log("\nSon hatalar");
  console.log("─".repeat(64));
  for (const k of hatali.slice(-5)) {
    console.log(`  ${k.t}  ${k.arac}`);
    console.log(`         ${String(k.hata).slice(0, 70)}`);
  }
}

// Kapsül verimi: asıl iddiamız burada ölçülüyor.
const kapsuller = kayitlar.filter((k) => k.arac === "context_capsule" && typeof k.kapsulToken === "number");
if (kapsuller.length > 0) {
  const tokenlar = kapsuller.map((k) => k.kapsulToken);
  const semboller = kapsuller.map((k) => k.sembolSayisi).filter((n) => typeof n === "number");
  console.log("\nKapsül verimi");
  console.log("─".repeat(64));
  console.log(`  kapsül sayısı           ${kapsuller.length}`);
  console.log(`  ortanca kapsül token    ${ortanca(tokenlar)}`);
  console.log(`  en büyük kapsül         ${Math.max(...tokenlar)} token`);
  console.log(`  ortanca sembol sayısı   ${ortanca(semboller) ?? "—"}`);
}

console.log("");
