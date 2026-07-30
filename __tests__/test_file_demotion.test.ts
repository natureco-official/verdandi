import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { TypeScriptContextCompiler } from "../src/context_compiler.js";

const gecici: string[] = [];
after(async () => {
  for (const d of gecici) await rm(d, { recursive: true, force: true });
});

/**
 * Üretim dosyası ile testi AYNI kavramları taşıyor; ikisi de "rate limit"
 * kelimelerini geçiriyor. Test dosyası daha uzun olduğu için lexical skoru
 * doğal olarak daha yüksek çıkıyor — gerçek projede tam olarak bu oluyordu.
 */
async function projeKur(): Promise<string> {
  const kok = await mkdtemp(path.join(tmpdir(), "verdandi-testceza-"));
  gecici.push(kok);
  await mkdir(path.join(kok, "src", "utils"), { recursive: true });
  await mkdir(path.join(kok, "src", "__tests__"), { recursive: true });
  await writeFile(path.join(kok, "package.json"), '{"name":"t","version":"1.0.0"}', "utf8");
  await writeFile(
    path.join(kok, "src", "utils", "rateLimit.ts"),
    [
      "export function rateLimit(mesaj: string, limit: number): boolean {",
      "  // mesaj rate limit",
      "  return mesaj.length <= limit;",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  // Test dosyası aynı terimleri DAHA ÇOK geçiriyor: lexical skoru doğal olarak
  // daha yüksek. Ceza olmadan bu kurguda test dosyası her tekrar sayısında
  // birinci çıkıyor (ölçüldü), cezayla üretim kodu öne geçiyor. Testin
  // ısırdığı yer tam olarak burası.
  await writeFile(
    path.join(kok, "src", "__tests__", "rateLimit.test.ts"),
    [
      'describe("rate limit", () => {',
      '  it("mesaj rate limit", () => {',
      "    // mesaj rate limit",
      "    // mesaj rate limit",
      "  });",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );
  return kok;
}

/**
 * `pathPrior` test dosyalarına -2.5'lik TOPLAMSAL bir ceza veriyordu, ama aynı
 * toplamda `conceptCoverageBoost` 40 puana kadar çıkabiliyor: ceza gürültüde
 * kayboluyordu.
 *
 * Ölçüldü (30 Temmuz 2026, natureco_improvements): "mesaj gönderme rate limit"
 * görevinde doğru dosya `src/utils/rateLimit.ts` BULUNUYOR ama
 * `memoryLeak.preservation.test.ts` dosyasına ham skorda 126.6'ya 101.9 ile
 * kaybediyordu. Skorlar `score/(score+10)` ile normalize edildiği için bu fark
 * dışarıdan %1.6 gibi görünüyor; gerçekte %24.
 *
 * Sabit ceza, skorların büyüklüğü değiştikçe anlamını yitirir; oransal olan
 * yitirmez. 16 gerçek görevde ilk sırada test dosyası çıkma oranı %44 → %38.
 */
describe("sıralama — test dosyası cezası", () => {
  it("test niyeti YOKKEN üretim dosyasını test dosyasının önüne koyar", async () => {
    const kok = await projeKur();
    const derleyici = new TypeScriptContextCompiler();
    const sonuc = await derleyici.context_capsule({
      projectRoot: kok,
      task: "mesaj gonderme rate limit",
    });

    const ilk = (sonuc.modelPayload.probableFiles[0] ?? "").replace(/\\/g, "/");
    assert.match(ilk, /src\/utils\/rateLimit\.ts$/, `ilk dosya üretim kodu olmalı, gelen: ${ilk}`);
  });

  /**
   * Ceza dosyayı YASAKLAMAZ. Niyet test olduğunda ceza hiç uygulanmaz —
   * "testi nasıl yazılmış" diye soran biri testi görmek ister.
   */
  it("test niyeti VARKEN test dosyası geri itilmez", async () => {
    const kok = await projeKur();
    const derleyici = new TypeScriptContextCompiler();
    const sonuc = await derleyici.context_capsule({
      projectRoot: kok,
      task: "rate limit test dosyasi neyi kontrol ediyor",
    });

    assert.ok(
      sonuc.modelPayload.probableFiles.some(f => /rateLimit\.test\.ts$/.test(f.replace(/\\/g, "/"))),
      "test niyetinde test dosyası kapsülde bulunmalı",
    );
  });
});
