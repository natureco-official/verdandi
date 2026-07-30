import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { TypeScriptContextCompiler } from "../src/context_compiler.js";
import { mapContextCapsule } from "../mcp_tools.js";

const gecici: string[] = [];
after(async () => {
  for (const d of gecici) await rm(d, { recursive: true, force: true });
});

async function projeKur(): Promise<string> {
  const kok = await mkdtemp(path.join(tmpdir(), "verdandi-belirsizlik-"));
  gecici.push(kok);
  await mkdir(path.join(kok, "src"), { recursive: true });
  await writeFile(path.join(kok, "package.json"), '{"name":"b","version":"1.0.0"}', "utf8");
  await writeFile(
    path.join(kok, "src", "uploader.ts"),
    "export function resolveUploadCeiling(limit: number): number {\n"
    + "  return Math.max(limit, 1024);\n}\n\n"
    + "export function retryUpload(attempt: number): boolean {\n"
    + "  return attempt < 3;\n}\n",
    "utf8",
  );
  return kok;
}

/**
 * Canlı ölçümde bulundu (30 Temmuz 2026, natureco-skuld): doğal dille sorulan
 * bir görev alakasız bir dosyayı **0.851 skorla** döndürdü. Derleyici bunun
 * zayıf olduğunu zaten biliyordu — `uncertaintyReasons` "Sorgu terimlerinin azı
 * sembol/path ile örtüşüyor" diyordu — ama bu yalnızca `_meta`'ya gidiyordu;
 * ajanın karar verirken okuduğu yer `model_payload`.
 *
 * Yüksek skorlu yanlış cevap, düşük skorlu yanlış cevaptan tehlikelidir: geri
 * çekilme sinyali yoktur, ajan yanlış dosyaya güvenle gider.
 *
 * Sözleşme üç yönlü: zayıfken SÖYLENMELİ, güçlüyken kapsül eskisiyle birebir
 * aynı kalmalı, ve uyarı bütçeyi taşırmamalı — payload'ın bayt sınırı ürünün
 * kendisi, uyarı uğruna gerçek sembol atılamaz.
 */
describe("kapsül — geri getirme zayıflığı", () => {
  it("zayıf eşleşmede uyarı payload'a yazılır", async () => {
    const kok = await projeKur();
    const derleyici = new TypeScriptContextCompiler();
    const sonuc = await derleyici.context_capsule({
      projectRoot: kok,
      task: "dosyalar bir türlü yerine gitmiyor, sanırım bir şeyler ters",
    });

    assert.ok(sonuc._meta.uncertaintyReasons.length > 0, "önkoşul: bu sorgu zayıf sayılmalı");
    assert.ok(sonuc.modelPayload.retrievalWeak, "zayıf eşleşmede payload uyarı taşımalı");
    assert.match(sonuc.modelPayload.retrievalWeak!, /doğrula/);
  });

  it("güçlü eşleşmede kapsül hiç uyarı taşımaz", async () => {
    const kok = await projeKur();
    const derleyici = new TypeScriptContextCompiler();
    const sonuc = await derleyici.context_capsule({
      projectRoot: kok,
      task: "resolveUploadCeiling limit handling in src/uploader.ts",
    });

    assert.deepEqual(sonuc._meta.uncertaintyReasons, []);
    assert.equal(
      sonuc.modelPayload.retrievalWeak,
      undefined,
      "güçlü eşleşmede alan hiç bulunmamalı — yoksa uyarı anlamını yitirir",
    );
  });

  /**
   * Uyarı, payload'ın bayt bütçesini taşırmamalı. Bütçe seviyesi 0'da çoğu
   * zaman TEK sembol kalıyor ve kırpılacak yer olmuyor: uzun bir uyarı metni
   * doğrudan sembolün yerine geçer. İlk denemede tam olarak bu oldu ve iki
   * mevcut test bunu yakaladı.
   */
  it("uyarı bütçeyi taşırmaz ve son sembolü dışarı atmaz", async () => {
    // Sembol DÖNEN bir kurgu gerekiyor: hiçbir şey eşleşmezse uyarının bir
    // şeyi dışarı attığını da gösteremeyiz. 20 dosya + tek terimli sorgu,
    // seviye 0'da tam olarak tek sembol bırakıyor — kırpılacak yerin
    // kalmadığı, yani uyarının doğrudan sembolün yerine geçeceği durum.
    const kok = await mkdtemp(path.join(tmpdir(), "verdandi-butce-"));
    gecici.push(kok);
    await mkdir(path.join(kok, "src"), { recursive: true });
    await writeFile(path.join(kok, "package.json"), '{"name":"b","version":"1.0.0"}', "utf8");
    for (let i = 0; i < 20; i++) {
      await writeFile(
        path.join(kok, "src", `widget${i}.ts`),
        `export function widget${i}() { return ${i}; }\n`,
        "utf8",
      );
    }

    const derleyici = new TypeScriptContextCompiler();
    const sonuc = await derleyici.context_capsule({
      projectRoot: kok,
      task: "widget",
      preferredBudgetLevel: 0,
    });

    assert.ok(sonuc.modelPayload.retrievalWeak, "önkoşul: bu sorgu zayıf sayılmalı");
    assert.ok(
      sonuc._meta.estimatedPayloadTokens <= 200,
      `bütçe aşıldı: ${sonuc._meta.estimatedPayloadTokens}`,
    );
    assert.ok(
      sonuc.modelPayload.relevantSymbols.length >= 1,
      "uyarı uğruna son sembol atılamaz",
    );
  });

  it("hiçbir şey eşleşmediğinde de uyarı verir", async () => {
    const kok = await projeKur();
    const derleyici = new TypeScriptContextCompiler();
    const sonuc = await derleyici.context_capsule({
      projectRoot: kok,
      task: "dosyalar bir türlü yerine gitmiyor, sanırım bir şeyler ters",
    });
    // Boş sonuç sessiz kalmamalı: ajan "aradım, bulamadım" ile "aradım,
    // buldum" arasındaki farkı görebilmeli.
    assert.equal(sonuc.modelPayload.relevantSymbols.length, 0);
    assert.ok(sonuc.modelPayload.retrievalWeak, "boş sonuçta da uyarı olmalı");
  });

  /**
   * Gidiş-dönüş simetrik olmalı: kapsülü diskte ya da kuyrukta taşıyan her
   * yol serialize/deserialize'dan geçiyor. Uyarı orada düşerse, tam da uzun
   * yoldan gelen çağrılarda kaybolur.
   */
  it("wire dönüşümünde uyarı kaybolmaz", async () => {
    const kok = await projeKur();
    const derleyici = new TypeScriptContextCompiler();
    const sonuc = await derleyici.context_capsule({
      projectRoot: kok,
      task: "dosyalar bir türlü yerine gitmiyor, sanırım bir şeyler ters",
    });

    const wire = mapContextCapsule(sonuc, "serialize");
    assert.equal(wire.model_payload.retrieval_weak, sonuc.modelPayload.retrievalWeak);
    const geri = mapContextCapsule(wire, "deserialize");
    assert.equal(geri.modelPayload.retrievalWeak, sonuc.modelPayload.retrievalWeak);
  });
});
