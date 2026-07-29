import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { TypeScriptContextCompiler } from "../src/context_compiler.js";

/**
 * Regresyon: SKIP_DIRS yalnızca TAM ad eşleşmesi yapıyordu, bu yüzden bir Tauri
 * projesinin `dist-tauri/` dizini kaynakmış gibi indeksleniyordu. Ölçüm
 * (mac-terminal-win, 29 Temmuz 2026): indekslenen 32 dosyanın 7'si ve
 * baytların %77'si küçültülmüş paketti; altı örnek sorgunun beşinde ajana
 * kaynağın kendisi yerine ondan derlenmiş paket veriliyordu.
 *
 * Test iki yönü birden tutuyor, çünkü aşırı geniş bir desen daha kötü olurdu:
 * derleme çıktısı dışarıda kalmalı, ADI BENZEYEN gerçek kaynak dizinleri
 * (distributed/, outbox/) içeride kalmalı.
 */

const gecici: string[] = [];
after(async () => {
  for (const d of gecici) await rm(d, { recursive: true, force: true });
});

async function projeKur(): Promise<string> {
  const kok = await mkdtemp(path.join(tmpdir(), "verdandi-derleme-"));
  gecici.push(kok);

  const yaz = async (goreli: string, icerik: string) => {
    const tam = path.join(kok, goreli);
    await mkdir(path.dirname(tam), { recursive: true });
    await writeFile(tam, icerik, "utf8");
  };

  await yaz("package.json", JSON.stringify({ name: "fixture", version: "1.0.0" }));

  // Gerçek kaynak.
  await yaz("src/terminalTemasi.ts", "export function terminalTemasiUygula(ad: string) { return ad; }\n");

  // Adı benzeyen ama gerçek kaynak olan dizinler — bunlar KALMALI.
  await yaz("distributed/terminalTemasiDugum.ts", "export function terminalTemasiDugum() { return 1; }\n");
  await yaz("outbox/terminalTemasiKuyruk.ts", "export function terminalTemasiKuyruk() { return 2; }\n");

  // Derleme çıktısı — hepsi ELENMELİ.
  await yaz("dist/terminalTemasi.js", "export function terminalTemasiUygula(a){return a}\n");
  // Bu sembol SADECE derleme çıktısında var. İndekste görünüyorsa gezici
  // dist-tauri'ye girmiş demektir; testin dayanağı bu.
  await yaz(
    "dist-tauri/assets/terminalTemasi-A1b2C3.js",
    "export function terminalTemasiUygula(a){return a}\n" +
      "export function yalnizcaPaketteVarOlanSembol(){return 42}\n",
  );
  await yaz("out-tsc/terminalTemasi.js", "export function terminalTemasiUygula(a){return a}\n");
  await yaz("target/debug/terminalTemasi.js", "export function terminalTemasiUygula(a){return a}\n");
  await yaz("build_ssr/terminalTemasi.js", "export function terminalTemasiUygula(a){return a}\n");

  // Capacitor'ın mobil kabuklara kopyaladığı web derlemesi. Yoldaki her
  // parça (android, app, src, main, assets, public) sıradan bir kaynak dizin
  // adı — ada dayalı hiçbir kural bunu güvenle eleyemez. Tek ayırt edici
  // özellik dosyanın ŞEKLİ: tek satıra sıkıştırılmış paket.
  const paket =
    `export function paketlenmisMobilSembol(a,b){${"return a+b;".repeat(4000)}}\n`;
  await yaz("android/app/src/main/assets/public/assets/index-B1c2D3.js", paket);

  return kok;
}

describe("derleme çıktısı dışlama", () => {
  // Asıl özellik bu: dosya İNDEKSE HİÇ GİRMEMELİ. Yalnızca kapsüle bakmak
  // zayıf bir testtir — puanlama cezası tek başına da onu kapsül dışında
  // tutar, dolayısıyla gezici bozulsa bile test yeşil kalır. (İlk hâli tam
  // olarak bu yüzden eski kodda da geçiyordu.) Yalnızca dist-tauri içinde
  // bulunan bir sembolü sormak, indekslenip indekslenmediğini doğrudan ölçer.
  it("derleme çıktısındaki sembolü indekslemez", async () => {
    const kok = await projeKur();
    const derleyici = new TypeScriptContextCompiler();

    const sonuc = await derleyici.read_symbol({
      projectRoot: kok,
      symbol: "yalnizcaPaketteVarOlanSembol",
    });

    assert.equal(sonuc.evidence.length, 0, "derleme çıktısındaki sembol indekslenmiş");
    assert.ok(
      sonuc.ambiguity.some((s: string) => /not found/i.test(s)),
      `bulunamama gerekçesi bekleniyordu, gelen: ${JSON.stringify(sonuc.ambiguity)}`,
    );
  });

  // Ada dayalı kuralın yetişemediği durum: sıradan adlı dizinlerde duran
  // küçültülmüş paket. Ölçüm (29 Temmuz 2026, natureco_improvements):
  // 4,4 MB / indeksin %26,4'ü, ve indeksleme süresi 12675 ms → 7575 ms.
  it("sıradan adlı dizindeki küçültülmüş paketi indekslemez", async () => {
    const kok = await projeKur();
    const derleyici = new TypeScriptContextCompiler();

    const sonuc = await derleyici.read_symbol({
      projectRoot: kok,
      symbol: "paketlenmisMobilSembol",
    });

    assert.equal(
      sonuc.evidence.length,
      0,
      "küçültülmüş paket indekslenmiş — yol tabanlı kural bunu yakalayamaz, şekil kontrolü yakalamalıydı",
    );
  });

  it("dist-tauri gibi son ekli derleme dizinlerini kapsüle sokmaz", async () => {
    const kok = await projeKur();
    const derleyici = new TypeScriptContextCompiler();
    const kapsul = await derleyici.context_capsule({
      task: "terminal temasini duzelt",
      projectRoot: kok,
    });

    const dosyalar = [
      ...new Set([
        ...kapsul.modelPayload.relevantSymbols.map((s) => s.file),
        ...kapsul.modelPayload.probableFiles,
      ]),
    ];

    const cop = dosyalar.filter((f) =>
      /^(dist|build|out|target)([-_.][^/]*)?\//.test(f),
    );
    assert.deepEqual(cop, [], `derleme çıktısı kapsüle girdi: ${cop.join(", ")}`);
    assert.ok(dosyalar.length > 0, "kapsül boş dönmemeli");
  });

  it("adı derleme dizinlerine benzeyen gerçek kaynağı elemez", async () => {
    const kok = await projeKur();
    const derleyici = new TypeScriptContextCompiler();
    const kapsul = await derleyici.context_capsule({
      task: "terminalTemasiKuyruk fonksiyonunu bul",
      projectRoot: kok,
    });

    const dosyalar = [
      ...new Set([
        ...kapsul.modelPayload.relevantSymbols.map((s) => s.file),
        ...kapsul.modelPayload.probableFiles,
      ]),
    ];

    // outbox/ ve distributed/ derleme çıktısı değil; desen bunları yutarsa
    // düzeltme hatanın kendisinden daha zararlı olur.
    assert.ok(
      dosyalar.some((f) => f.startsWith("outbox/") || f.startsWith("distributed/")),
      `benzer adlı gerçek kaynak elendi; dönen dosyalar: ${dosyalar.join(", ")}`,
    );
  });
});
