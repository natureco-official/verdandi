import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { TypeScriptContextCompiler } from "../src/context_compiler.js";

const gecici: string[] = [];
after(async () => {
  for (const d of gecici) await rm(d, { recursive: true, force: true });
});

const KAYNAK_CRLF =
  "export function ekle(a: number, b: number): number {\r\n  return a + b;\r\n}\r\n\r\n"
  + "export function cikar(a: number, b: number): number {\r\n  return a - b;\r\n}\r\n";
const KAYNAK_LF = KAYNAK_CRLF.replace(/\r\n/g, "\n");

async function projeKur(dosyaMetni: string): Promise<string> {
  const kok = await mkdtemp(path.join(tmpdir(), "verdandi-eol-"));
  gecici.push(kok);
  await mkdir(path.join(kok, "src"), { recursive: true });
  await writeFile(path.join(kok, "package.json"), '{"name":"eol","version":"1.0.0"}', "utf8");
  await writeFile(path.join(kok, "src", "a.ts"), dosyaMetni, "utf8");
  return kok;
}

async function yamala(kok: string, govde: string) {
  const derleyici = new TypeScriptContextCompiler();
  const oku = await derleyici.read_symbol({
    projectRoot: kok,
    symbol: "cikar",
    fileHint: "src/a.ts",
    includeBody: true,
  });
  const sonuc = await derleyici.apply_structured_patch({
    projectRoot: kok,
    taskId: "eol",
    snapshot: oku.snapshot,
    language: "typescript",
    operations: [{
      operation: "replace_function_body",
      file: "src/a.ts",
      symbol: "cikar",
      newBody: govde,
      precondition: {
        file: "src/a.ts",
        contentHash: oku.evidence[0]!.fileContentHash,
        symbol: "cikar",
      },
    }],
  });
  const metin = await readFile(path.join(kok, "src", "a.ts"), "utf8");
  return {
    applied: sonuc.applied,
    crlf: (metin.match(/\r\n/g) || []).length,
    lf: (metin.match(/(?<!\r)\n/g) || []).length,
    metin,
  };
}

/**
 * Canlı denemede bulundu (30 Temmuz 2026): `apply_structured_patch` gelen
 * gövdeyi olduğu gibi yerleştiriyordu. Çağıran taraf gövdeyi `\n` ile
 * yazdığında — JSON üzerinden gelen istekte olağan olan budur — CRLF bir dosya
 * KARIŞIK satır sonlu hale geliyordu: yamalanan satırlar LF, gerisi CRLF.
 * `applied: true` dönüyordu ve tek bir uyarı yoktu.
 *
 * Windows'ta bedeli sessiz değil: `eslint linebreak-style` ihlali, `prettier`
 * farkı, `core.autocrlf` altında dosyanın tamamının değişmiş görünmesi. Test
 * paketi bunu göremiyordu çünkü tüm fixture'lar LF.
 *
 * Dört yön de tutuluyor: dosya ne kullanıyorsa sonuç onu kullanmalı, gövdenin
 * hangi biçimde geldiğinden bağımsız olarak.
 */
describe("yapısal yama — satır sonu geleneği", () => {
  it("CRLF dosyaya LF gövde yamalanınca dosya CRLF kalır", async () => {
    const kok = await projeKur(KAYNAK_CRLF);
    const sonuc = await yamala(kok, "{\n  return a - b - 0;\n}");
    assert.equal(sonuc.applied, true);
    assert.equal(sonuc.lf, 0, "dosyada yalnız-LF satır kalmamalı (karışık satır sonu)");
    assert.ok(sonuc.crlf > 0);
    assert.match(sonuc.metin, /return a - b - 0;/);
  });

  it("LF dosyaya CRLF gövde yamalanınca dosya LF kalır", async () => {
    const kok = await projeKur(KAYNAK_LF);
    const sonuc = await yamala(kok, "{\r\n  return a - b - 0;\r\n}");
    assert.equal(sonuc.applied, true);
    assert.equal(sonuc.crlf, 0, "LF dosyaya CRLF sızmamalı");
    assert.ok(sonuc.lf > 0);
  });

  it("gövde dosyayla aynı gelenekte geldiğinde de tek biçimli kalır", async () => {
    const crlf = await yamala(await projeKur(KAYNAK_CRLF), "{\r\n  return a - b - 0;\r\n}");
    assert.equal(crlf.lf, 0);
    const lf = await yamala(await projeKur(KAYNAK_LF), "{\n  return a - b - 0;\n}");
    assert.equal(lf.crlf, 0);
  });

  /**
   * Satır sonu içermeyen bir dosyada uyulacak bir gelenek yoktur. Tahmin
   * etmek, yanlış tahmin etme riskini bedava getirirdi; metin olduğu gibi
   * bırakılır.
   */
  it("satır sonu olmayan dosyada gövdeye dokunmaz", async () => {
    const kok = await projeKur("export function cikar(a: number, b: number): number { return a - b; }");
    const sonuc = await yamala(kok, "{ return a - b - 0; }");
    assert.equal(sonuc.applied, true);
    assert.equal(sonuc.crlf, 0);
    assert.equal(sonuc.lf, 0);
  });
});
