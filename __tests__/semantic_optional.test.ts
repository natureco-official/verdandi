import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { anlamsalHazirMi, dosyaBelgesi, dosyaVektorleri, kosinus } from "../src/semantic.js";

const oncekiDeger = process.env.VERDANDI_SEMANTIC;
after(() => {
  if (oncekiDeger === undefined) delete process.env.VERDANDI_SEMANTIC;
  else process.env.VERDANDI_SEMANTIC = oncekiDeger;
});

/**
 * Anlamsal katman İSTEĞE BAĞLI ve VARSAYILAN OLARAK KAPALI.
 *
 * Yalnızca "paket kuruluysa aç" denendi ve ölçüldü: test paketi 30 sn'den
 * 162 sn'ye çıktı, MCP sınır testleri zaman aşımından kararsızlaştı, ve
 * sözcüksel hiçbir eşleşme olmadığında bile dosya eklendiği için "hiçbir şey
 * bulunamadı" sinyali kayboldu — dürüst boş sonuç uydurma bir sonuca döndü.
 *
 * Bir bağımlılığın varlığı, davranışı değiştirmek için gerekçe değil.
 */
describe("anlamsal katman — isteğe bağlı ve kapalı", () => {
  it("açık onay olmadan devre dışıdır", async () => {
    delete process.env.VERDANDI_SEMANTIC;
    assert.equal(await anlamsalHazirMi(), false, "onaysız açılmamalı");
  });

  it("kapalıyken vektör üretmez ve çağıranı bekletmez", async () => {
    delete process.env.VERDANDI_SEMANTIC;
    const basladi = Date.now();
    const sonuc = await dosyaVektorleri("C:/olmayan-proje", [
      { relative: "a.ts", text: "export function a() {}" },
    ]);
    assert.equal(sonuc, null, "kapalıyken null dönmeli");
    // Model yüklemeye kalkarsa bu saniyeler sürerdi; kapalı yol anında dönmeli.
    assert.ok(Date.now() - basladi < 1000, "kapalı yol model yüklemeye kalkmamalı");
  });

  /**
   * Belge kurucusu modelden bağımsız: yol, dışa aktarılan adlar ve metin
   * dizgeleri. Türkçe arayüz dizgeleri buraya girmezse Türkçe sorgunun
   * tutunacağı yer kalmaz.
   */
  it("dosya belgesi yol, dışa aktarılan ad ve metin dizgesi taşır", () => {
    const belge = dosyaBelgesi(
      "src/services/screenShareManager.ts",
      'export function startShare() {}\nconst etiket = "Ekran Paylas";\n',
    );
    assert.match(belge, /^passage: /, "e5 belge öneki şart");
    assert.match(belge, /screenShareManager/);
    assert.match(belge, /startShare/);
    assert.match(belge, /Ekran Paylas/);
  });

  it("kosinüs normalize vektörlerde nokta çarpımıdır", () => {
    assert.equal(kosinus([1, 0, 0], [1, 0, 0]), 1);
    assert.equal(kosinus([1, 0, 0], [0, 1, 0]), 0);
    assert.ok(Math.abs(kosinus([0.6, 0.8], [0.6, 0.8]) - 1) < 1e-9);
  });
});
