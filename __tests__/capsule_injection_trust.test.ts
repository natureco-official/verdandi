import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const kok = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const oku = (ad: string) => readFile(path.join(kok, ad), "utf8");

/**
 * Verðandi'nin işi, indekslenen projenin HAM KAYNAĞINI bir ajanın prompt'una
 * koymaktır. O kaynak sizin denetiminizde olmayan bir yerden geldiyse
 * (çekilmiş bağımlılık, PR, bir dosyadaki yorum satırı) içindeki metin ajana
 * kelimesi kelimesine ulaşır ve ajan onu yapısı gereği kullanıcının
 * talimatından ayıramaz.
 *
 * `run_with_capsule.sh` bunu bir süre `--yolo`, `--permission-mode auto` ve
 * `--dangerously-skip-permissions` ile birleştiriyordu: o metin onay
 * sorulmadan çalışabiliyordu. Bayraklar yasaklanmadı — VARSAYILAN olmaktan
 * çıkarıldı.
 *
 * Bu tam olarak sessizce geri gelebilecek türden bir değişiklik: bir ajanı
 * etkileşimsiz kipte "çalışır" hale getirmenin en kısa yolu, bayrağı geri
 * koymaktır. Bu yüzden metinle sabitleniyor.
 */
describe("kapsül enjeksiyonu — güven sınırı", () => {
  it("izin kapısını atlayan bayraklar VARSAYILAN olarak geçilmez", async () => {
    const kabuk = await oku("run_with_capsule.sh");
    const secim = kabuk.slice(kabuk.indexOf('case "$AGENT" in'), kabuk.indexOf("\nesac"));

    for (const bayrak of ["--yolo", "--permission-mode", "--dangerously-skip-permissions"]) {
      assert.ok(
        !secim.includes(bayrak),
        `case bloğu ${bayrak} bayrağını doğrudan geçiyor; VERDANDI_YOLO ardına alınmalı`,
      );
    }
  });

  it("bayraklar yalnızca VERDANDI_YOLO=1 ile devreye girer", async () => {
    const kabuk = await oku("run_with_capsule.sh");
    const kapi = kabuk.indexOf('if [ "${VERDANDI_YOLO:-0}" = "1" ]');
    assert.ok(kapi !== -1, "VERDANDI_YOLO kapısı yok");

    // Üç bayrak da kapının İÇİNDE tanımlanmalı.
    const kapiBlogu = kabuk.slice(kapi, kabuk.indexOf("\nfi", kapi));
    for (const bayrak of ["--yolo", "--permission-mode auto", "--dangerously-skip-permissions"]) {
      assert.ok(kapiBlogu.includes(bayrak), `${bayrak} VERDANDI_YOLO kapısının içinde değil`);
    }
  });

  it("boş dizi genişletmesi bash 3.2'de (macOS varsayılanı) patlamaz", async () => {
    const kabuk = await oku("run_with_capsule.sh");
    // `set -u` altında `"${ARR[@]}"` boş dizide bash 3.2'de "unbound variable"
    // verir. Güvenli biçim: `${ARR[@]+"${ARR[@]}"}`.
    for (const ad of ["HERMES_IZIN", "CLAUDE_IZIN", "AGY_IZIN"]) {
      assert.ok(
        !new RegExp(`(?<!\\+)"\\$\\{${ad}\\[@\\]\\}"`).test(kabuk),
        `${ad} korumasız genişletiliyor; \${${ad}[@]+"\${${ad}[@]}"} kullanın`,
      );
      assert.ok(
        kabuk.includes(`\${${ad}[@]+"\${${ad}[@]}"}`),
        `${ad} için güvenli genişletme yok`,
      );
    }
  });

  /**
   * Çerçeveleme tek başına yeterli değil — bir modeli sınırı çizmeye
   * zorlamaz, yalnızca çizebilmesini sağlar. Ama bu olmadan gömülü kaynak,
   * kullanıcının talimatıyla aynı düzlemde duruyor.
   */
  it("gömülü kaynak VERİ olarak çerçevelenir ve sınırlayıcı taşır", async () => {
    const enjekte = await oku("src/auto_inject.mjs");
    assert.match(enjekte, /OKUNACAK VERİDİR/, "kaynağın veri olduğu söylenmiyor");
    assert.match(enjekte, /talimat değildir/, "talimat olmadığı söylenmiyor");
    assert.match(enjekte, /const SINIR =/, "sınırlayıcı tanımı yok");
    // Sınırlayıcı bloğun HEM başına HEM sonuna konmalı; tek taraflı sınır,
    // kaynağın nerede bittiğini belirsiz bırakır.
    const govde = enjekte.slice(enjekte.indexOf("const SINIR ="));
    assert.equal(
      (govde.match(/parts\.push\(SINIR\)/g) || []).length,
      2,
      "sınırlayıcı iki kez (açılış ve kapanış) eklenmiyor",
    );
  });

  it("belgeler güvenilmeyen kod tabanı durumunu anlatır", async () => {
    for (const ad of ["README.md", "README.tr.md"]) {
      const metin = await oku(ad);
      assert.ok(metin.includes("VERDANDI_YOLO"), `${ad}: VERDANDI_YOLO anlatılmıyor`);
      // "Prompt injection" sütun başlığı, güvenlik terimiyle çakışıyordu:
      // belgede o terimi arayan biri dolu bir yetenek tablosu bulup konunun
      // ele alındığı sonucuna varıyordu.
      assert.ok(
        !metin.includes("| Prompt injection |") && !metin.includes("| Prompt enjeksiyonu |"),
        `${ad}: sütun başlığı hâlâ güvenlik terimiyle çakışıyor`,
      );
    }
  });
});
