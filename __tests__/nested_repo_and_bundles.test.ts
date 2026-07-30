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

async function kokKur(): Promise<string> {
  const kok = await mkdtemp(path.join(tmpdir(), "verdandi-icdepo-"));
  gecici.push(kok);
  await mkdir(path.join(kok, "src"), { recursive: true });
  await writeFile(path.join(kok, "package.json"), '{"name":"k","version":"1.0.0"}', "utf8");
  await writeFile(
    path.join(kok, "src", "widget.ts"),
    "export function widgetHandler(): string {\n  return \"widget\";\n}\n",
    "utf8",
  );
  return kok;
}

/**
 * Ölçüldü (30 Temmuz 2026, natureco_improvements — 293 dosyalık en büyük
 * proje): kök içinde AYRI BİR DEPO olarak duran `natureco-cli/` indeksleniyor
 * ve aday dosyaların %29'unu dolduruyordu. "websocket yeniden bağlanma"
 * görevine dönen ilk dosya `natureco-cli/test/utils/memory-lint.test.js` —
 * başka bir ürünün test dosyası — oluyordu.
 *
 * Üst depo onun içeriğini zaten takip etmez; tek bir gitlink girdisi görür.
 * Aynı kural submodule'leri ve elle klonlanmış bağımlılıkları da kapsar.
 */
describe("indeksleme — iç içe depo", () => {
  it("kendi .git'i olan alt dizini indekslemez", async () => {
    const kok = await kokKur();
    const ic = path.join(kok, "vendored");
    await mkdir(path.join(ic, ".git"), { recursive: true });
    await mkdir(path.join(ic, "src"), { recursive: true });
    await writeFile(path.join(ic, "package.json"), '{"name":"ic","version":"1.0.0"}', "utf8");
    await writeFile(
      path.join(ic, "src", "widget.ts"),
      "export function widgetHandler(): string {\n  return \"baska urun\";\n}\n",
      "utf8",
    );

    const derleyici = new TypeScriptContextCompiler();
    const sonuc = await derleyici.context_capsule({ projectRoot: kok, task: "widgetHandler" });

    assert.ok(sonuc.modelPayload.probableFiles.length > 0, "kökün kendi dosyası bulunmalı");
    assert.equal(
      sonuc.modelPayload.probableFiles.some(f => f.replace(/\\/g, "/").startsWith("vendored/")),
      false,
      "ayrı depodan dosya sızmamalı",
    );
  });

  it("kökün KENDİ .git'i indekslemeyi engellemez", async () => {
    const kok = await kokKur();
    await mkdir(path.join(kok, ".git"), { recursive: true });

    const derleyici = new TypeScriptContextCompiler();
    const sonuc = await derleyici.context_capsule({ projectRoot: kok, task: "widgetHandler" });
    assert.ok(
      sonuc.modelPayload.probableFiles.some(f => f.replace(/\\/g, "/").includes("src/widget.ts")),
      "bir depoyu indekslemek istiyoruz; kökün .git'i olması normaldir",
    );
  });
});

/**
 * Paket dedektörü dosyanın YALNIZCA BAŞINI örnekliyordu ve paketleyiciler tam
 * oraya lisans başlığı koyuyor: kısa satırlardan oluşan blok ortalamayı
 * düşürüp dedektörü kör ediyordu.
 *
 * Gerçek örnek (natureco_improvements): `ios/App/App/public/assets/ui-*.js` —
 * baş örneğinde ortalama satır 81, ortasında 2521. Bir paketin en temsili yeri
 * ortasıdır.
 */
describe("indeksleme — lisans başlıklı paketler", () => {
  it("başı lisans metni olan paketi kaynak sanmaz", async () => {
    const kok = await kokKur();
    const lisans = "/**\n * @license\n * Copyright 2017\n *\n"
      + " * Licensed under the Apache License, Version 2.0\n".repeat(60)
      + " */\n";
    const paketGovdesi = `const a=${"x".repeat(3000)};`.repeat(40);
    await writeFile(path.join(kok, "src", "bundle.js"), lisans + paketGovdesi, "utf8");

    const derleyici = new TypeScriptContextCompiler();
    const sonuc = await derleyici.context_capsule({ projectRoot: kok, task: "widgetHandler" });

    assert.equal(
      sonuc.modelPayload.probableFiles.some(f => f.replace(/\\/g, "/").includes("bundle.js")),
      false,
      "lisans başlığı paketi kaynak gibi göstermemeli",
    );
    assert.ok(
      sonuc.modelPayload.probableFiles.some(f => f.replace(/\\/g, "/").includes("src/widget.ts")),
      "gerçek kaynak indekste kalmalı",
    );
  });
});
