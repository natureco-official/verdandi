import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { TypeScriptContextCompiler, queryTokens } from "../src/context_compiler.js";

const gecici: string[] = [];
after(async () => {
  for (const d of gecici) await rm(d, { recursive: true, force: true });
});

async function projeKur(): Promise<string> {
  const kok = await mkdtemp(path.join(tmpdir(), "verdandi-tr-"));
  gecici.push(kok);
  await mkdir(path.join(kok, "src", "components"), { recursive: true });
  await writeFile(path.join(kok, "package.json"), '{"name":"tr","version":"1.0.0"}', "utf8");
  await writeFile(
    path.join(kok, "src", "components", "VoiceRooms.tsx"),
    [
      "export function joinVoiceRoom(roomId: string): boolean {",
      "  return roomId.length > 0;",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(kok, "src", "components", "BillingTable.tsx"),
    [
      "export function renderBillingTable(rows: number): number {",
      "  return rows;",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  return kok;
}

/**
 * Görev Türkçe yazılıyor, kod İngilizce adlandırılıyor. Aralarında harf
 * örtüşmesi olmadığı için sıralama çöküyordu.
 *
 * Ölçüldü (30 Temmuz 2026, natureco_improvements, 10 gerçek görev): ilk sırada
 * doğru dosya oranı **%20**. İsabet eden görevlerin metninde zaten İngilizce
 * ya da ortak bir kelime vardı ("rate limit", "forum"); saf Türkçe kavramların
 * tamamı kaçıyordu. `VoiceRooms.tsx` dosya olarak duruyor ama "sesli oda"
 * sorgusuyla bulunamıyordu. Sözlükle **%80**.
 */
describe("sorgu — Türkçe kavram köprüsü", () => {
  it("Türkçe kökü İngilizce karşılıklarıyla genişletir", () => {
    const sozcukler = queryTokens("sesli oda katilma hatasi");
    for (const beklenen of ["voice", "room", "join", "error"]) {
      assert.ok(sozcukler.includes(beklenen), `"${beklenen}" genişletmede yok: ${sozcukler.join(",")}`);
    }
    // Genişletme DEĞİŞTİRME değil: Türkçe sözcük sorguda kalmalı, yoksa
    // Türkçe yazılmış yorum satırları eşleşmeyi bırakır.
    assert.ok(sozcukler.includes("sesli"), "Türkçe sözcük düşürülmemeli");
  });

  /**
   * Türkçe eklemeli bir dil: "katıl" kökü "katılma", "katılıyor",
   * "katılamıyor" hâllerinin hepsinde başta durur. Tam eşleşme bu yüzden
   * yetmiyordu.
   */
  it("çekimli hâlleri de tanır", () => {
    for (const hal of ["katilma", "katiliyor", "katilamiyor"]) {
      assert.ok(
        queryTokens(hal).includes("join"),
        `"${hal}" için genişletme çalışmadı`,
      );
    }
  });

  /**
   * "gönderi" (post) ile "gönder" (send) aynı şey değil; uzun kök önce
   * denenmeli.
   */
  it("uzun kökü kısa kökün önünde dener", () => {
    assert.ok(queryTokens("forum gonderisi").includes("post"), "gonderi → post olmalı");
  });

  it("Türkçe görev İngilizce adlı dosyayı bulur", async () => {
    const kok = await projeKur();
    const sonuc = await new TypeScriptContextCompiler().context_capsule({
      projectRoot: kok,
      task: "sesli oda katilma hatasi",
    });
    const ilk = (sonuc.modelPayload.probableFiles[0] ?? "").replace(/\\/g, "/");
    assert.match(ilk, /VoiceRooms\.tsx$/, `beklenen VoiceRooms.tsx, gelen: ${ilk}`);
  });
});
