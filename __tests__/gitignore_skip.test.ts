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

const HEDEF = [
  "export function widgetHandler(): string {",
  "  return \"widget\";",
  "}",
  "",
].join("\n");

async function projeKur(kokGitignore: string): Promise<string> {
  const kok = await mkdtemp(path.join(tmpdir(), "verdandi-gitignore-"));
  gecici.push(kok);
  await mkdir(path.join(kok, "src"), { recursive: true });
  await writeFile(path.join(kok, "package.json"), '{"name":"g","version":"1.0.0"}', "utf8");
  await writeFile(path.join(kok, ".gitignore"), kokGitignore, "utf8");
  await writeFile(path.join(kok, "src", "widget.ts"), HEDEF, "utf8");
  return kok;
}

const dosyalar = (sonuc: { modelPayload: { probableFiles: string[] } }): string[] =>
  sonuc.modelPayload.probableFiles.map(f => f.replace(/\\/g, "/"));

/**
 * Derlenmiş çıktı ve kopyalanmış paketler indeksi kirletiyordu. Ölçüldü
 * (30 Temmuz 2026, natureco_improvements): "forum gönderisi silme yetkisi"
 * görevine dönen ilk dosya 683 KB'lık bir Capacitor paketi olan
 * `android/app/src/main/assets/public/assets/firebase-CuxlGNoM.js` idi.
 *
 * Ad kalıbıyla elemeyi denedim ve ölçünce vazgeçtim: `pattern-detector.js`,
 * `rock2-selftest.mjs` gibi gerçek kaynaklar da "tire + 8 karakter" kalıbına
 * uyuyor. Doğru sinyal projede zaten yazılı — `.gitignore`.
 */
describe("indeksleme — .gitignore", () => {
  it("kökteki .gitignore'da yazan dizini indekslemez", async () => {
    const kok = await projeKur("dist/\n");
    await mkdir(path.join(kok, "dist"), { recursive: true });
    await writeFile(path.join(kok, "dist", "widget.ts"), HEDEF, "utf8");

    const sonuc = await new TypeScriptContextCompiler().context_capsule({
      projectRoot: kok,
      task: "widgetHandler",
    });
    assert.ok(dosyalar(sonuc).some(f => f.includes("src/widget.ts")), "gerçek kaynak kalmalı");
    assert.equal(dosyalar(sonuc).some(f => f.startsWith("dist/")), false, "dist/ elenmeliydi");
  });

  /**
   * Asıl vakayı bu yakalıyor: `android/app/src/main/assets/public` kökteki
   * dosyada DEĞİL, `android/.gitignore` içinde yazıyordu. Yalnızca kökü okuyan
   * bir uygulama o paketleri elemezdi.
   */
  it("iç içe .gitignore dosyalarını da uygular", async () => {
    const kok = await projeKur("node_modules/\n");
    await mkdir(path.join(kok, "android", "assets", "public"), { recursive: true });
    await writeFile(path.join(kok, "android", ".gitignore"), "assets/public\n", "utf8");
    await writeFile(path.join(kok, "android", "assets", "public", "widget.ts"), HEDEF, "utf8");

    const sonuc = await new TypeScriptContextCompiler().context_capsule({
      projectRoot: kok,
      task: "widgetHandler",
    });
    assert.equal(
      dosyalar(sonuc).some(f => f.includes("android/assets/public")),
      false,
      "iç içe .gitignore kuralı uygulanmalıydı",
    );
  });

  it("glob ve ** desenlerini anlar", async () => {
    const kok = await projeKur("nc-backup-*/\n**/.onbellek/\n");
    await mkdir(path.join(kok, "nc-backup-20260704"), { recursive: true });
    await writeFile(path.join(kok, "nc-backup-20260704", "widget.ts"), HEDEF, "utf8");
    await mkdir(path.join(kok, "src", "derin", "onbellek-dizini"), { recursive: true });
    await writeFile(path.join(kok, "src", "derin", "onbellek-dizini", "widget.ts"), HEDEF, "utf8");

    const sonuc = await new TypeScriptContextCompiler().context_capsule({
      projectRoot: kok,
      task: "widgetHandler",
    });
    assert.equal(
      dosyalar(sonuc).some(f => f.startsWith("nc-backup-")),
      false,
      "glob deseni uygulanmalıydı",
    );
    // `**/.onbellek/` nokta ile başlıyor ve yürüyücü zaten nokta dizinlerini
    // atlıyor; buradaki `onbellek-dizini` ise ELENMEMELİ — desen ona uymuyor.
    assert.ok(
      dosyalar(sonuc).some(f => f.includes("onbellek-dizini")),
      "eşleşmeyen dizin yanlışlıkla elenmemeli",
    );
  });

  /**
   * Yanlış eleme, fazla indekslemekten kötüdür: `!` ile geri alınan bir yol
   * indekste kalmalı.
   *
   * Desen `uretilmis/*` — `uretilmis/` DEĞİL. Fark git'in kendi kuralından
   * geliyor: "It is not possible to re-include a file if a parent directory of
   * that file is excluded." Üst dizin komple elenmişse git de `!` satırını
   * dikkate almaz, biz de almıyoruz. Olumsuzlamanın anlamlı olduğu yer, üstün
   * elenmediği bu durumdur.
   */
  it("olumsuzlama (!) kuralına uyar", async () => {
    const kok = await projeKur("uretilmis/*\n!uretilmis/onemli\n");
    await mkdir(path.join(kok, "uretilmis", "onemli"), { recursive: true });
    await mkdir(path.join(kok, "uretilmis", "gecici"), { recursive: true });
    await writeFile(path.join(kok, "uretilmis", "gecici", "widget.ts"), HEDEF, "utf8");
    await writeFile(path.join(kok, "uretilmis", "onemli", "widget.ts"), HEDEF, "utf8");

    const sonuc = await new TypeScriptContextCompiler().context_capsule({
      projectRoot: kok,
      task: "widgetHandler",
    });
    assert.ok(
      dosyalar(sonuc).some(f => f.includes("uretilmis/onemli")),
      "olumsuzlanan yol indekste kalmalı",
    );
    assert.equal(
      dosyalar(sonuc).some(f => f.includes("uretilmis/gecici")),
      false,
      "olumsuzlanmayan kardeş dizin elenmeli",
    );
  });
});
