import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { taskLanguage, TypeScriptContextCompiler } from "../src/context_compiler.js";

const gecici: string[] = [];
after(async () => { for (const d of gecici) await rm(d, { recursive: true, force: true }); });
const TR_HARF = /[çğışöüÇĞİŞÖÜ]/;

async function projeKur(uzunBaslik = false): Promise<string> {
  const kok = await mkdtemp(path.join(tmpdir(), "verdandi-dil-"));
  gecici.push(kok);
  await mkdir(path.join(kok, "src"), { recursive: true });
  await mkdir(path.join(kok, "test"), { recursive: true });
  await writeFile(path.join(kok, "package.json"), '{"name":"dil","version":"1.0.0"}', "utf8");
  await writeFile(path.join(kok, "src", "cache.ts"), [
    "export function encodeCacheValue(value: unknown): string { return JSON.stringify(value); }",
    "export function decodeCacheValue(text: string): unknown { return JSON.parse(text); }",
    "export class ResponseCacheCodec { encode = encodeCacheValue; decode = decodeCacheValue; }",
    "",
  ].join("\n"), "utf8");
  if (uzunBaslik) {
    const baslik = "the response cache codec encodes and decodes cache value documents without structuredClone, " +
      "keeps the store-generated stamp, mirrors params, and survives a jest-jsdom runtime where structuredClone is missing";
    await writeFile(path.join(kok, "test", "cache.test.ts"), [
      'import { encodeCacheValue, decodeCacheValue } from "../src/cache.js";',
      'import { it } from "node:test";',
      `it(${JSON.stringify(baslik)}, () => { decodeCacheValue(encodeCacheValue({})); });`,
      "",
    ].join("\n"), "utf8");
  }
  return kok;
}

describe("görevin dili", () => {
  it("diakritikli Türkçe", () => assert.equal(taskLanguage("fatura PDF tutar biçimini düzelt"), "tr"));
  it("diakritiksiz Türkçe", () => assert.equal(taskLanguage("public cache API serialize document davranisini ve geriye uyumlulugu duzelt"), "tr"));
  it("İngilizce", () => assert.equal(taskLanguage("fix the invoice PDF currency amount formatting for English documents"), "en"));
  it("tek Türkçe işlev sözcüğü İngilizceyi çevirmez", () => assert.equal(taskLanguage("add a retry for the upload ve endpoint"), "en"));
});

describe("modele giden metin görevin dilinde", () => {
  it("İngilizce görevde kapsülde Türkçe harf yoktur", async () => {
    const kok = await projeKur();
    const kapsul = await new TypeScriptContextCompiler().context_capsule({
      task: "the cache codec fails on a public API document; verify the error path",
      projectRoot: kok,
      preferredBudgetLevel: 3,
    });
    const metin = JSON.stringify(kapsul.modelPayload);
    assert.ok(!TR_HARF.test(metin), `Türkçe harf sızdı: ${metin.match(/.{0,40}[çğışöüÇĞİŞÖÜ].{0,40}/)?.[0]}`);
    assert.ok(kapsul.modelPayload.successCriteria.some(k => /must pass again/.test(k)));
    assert.ok(!TR_HARF.test(kapsul._meta.uncertaintyReasons.join(" ")));
  });

  it("Türkçe görevde Türkçe kalır", async () => {
    const kok = await projeKur();
    const kapsul = await new TypeScriptContextCompiler().context_capsule({
      task: "cache codec public API belgesinde hata veriyor; hata yolunu doğrula",
      projectRoot: kok,
      preferredBudgetLevel: 3,
    });
    assert.ok(kapsul.modelPayload.successCriteria.some(k => /yeniden geçmeli/.test(k)));
  });
});

describe("score kapsül içi en iyiye orandır", () => {
  it("en iyi sözcüksel eşleşme 1.00, gerisi ona oranla ve sıralı", async () => {
    const kok = await projeKur();
    const kapsul = await new TypeScriptContextCompiler().context_capsule({
      task: "encode cache value",
      projectRoot: kok,
      preferredBudgetLevel: 3,
    });
    const skorlar = kapsul.modelPayload.relevantSymbols.map(s => s.score ?? -1);
    assert.equal(skorlar[0], 1);
    for (let i = 1; i < skorlar.length; i++) assert.ok(skorlar[i] <= skorlar[i - 1] && skorlar[i] >= 0);
    // Eski x/(x+10) formülünde 100+ puanlık her sembol 0.9'un üstünde toplanıyordu.
    assert.ok(new Set(skorlar.map(x => x.toFixed(2))).size > 1 || skorlar.length === 1, "skorlar bilgi taşımalı");
  });
});

describe("bütçe sıkışınca önce başlık kısalır", () => {
  it("seviye 1'de uzun test başlığı listeyi tek sembole indirmez", async () => {
    const kok = await projeKur(true);
    const kapsul = await new TypeScriptContextCompiler().context_capsule({
      task: "encode and decode cache value documents without structuredClone",
      projectRoot: kok,
      preferredBudgetLevel: 1,
    });
    assert.ok(kapsul.modelPayload.relevantSymbols.length >= 2, `yalnız ${kapsul.modelPayload.relevantSymbols.length} sembol`);
    for (const s of kapsul.modelPayload.relevantSymbols) assert.ok(s.symbol.length <= 96, `başlık kısaltılmadı: ${s.symbol.length}`);
    assert.ok(kapsul._meta.estimatedPayloadTokens <= 250, `bütçe aşıldı: ${kapsul._meta.estimatedPayloadTokens}`);
  });
});
