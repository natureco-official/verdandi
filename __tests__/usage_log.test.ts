import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

const KOK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SUNUCU = path.join(KOK, "dist", "src", "mcp_server.js");

const gecici: string[] = [];
after(async () => {
  for (const d of gecici) await rm(d, { recursive: true, force: true });
});

/** Sunucuyu ayrı bir kayıt yolu ile çalıştırır, istekleri gönderir, stdout'u döndürür. */
async function sunucuyuCalistir(
  istekler: unknown[],
  ortam: NodeJS.ProcessEnv,
): Promise<string> {
  return await new Promise((cozumle, reddet) => {
    const cocuk = spawn(process.execPath, [SUNUCU], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...ortam },
    });
    let cikti = "";
    cocuk.stdout.on("data", (d) => (cikti += String(d)));
    cocuk.on("error", reddet);

    cocuk.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } },
      })}\n`,
    );

    setTimeout(() => {
      for (const istek of istekler) cocuk.stdin.write(`${JSON.stringify(istek)}\n`);
      setTimeout(() => {
        cocuk.kill();
        cozumle(cikti);
      }, 2500);
    }, 800);
  });
}

const okuIstegi = (id: number, sembol: string) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name: "read_symbol", arguments: { projectRoot: KOK, symbol: sembol } },
});

describe("kullanım kaydı", () => {
  it("aracın sonucunu ve gerekçesini kaydeder", async () => {
    const dizin = await mkdtemp(path.join(tmpdir(), "verdandi-kayit-"));
    gecici.push(dizin);
    const yol = path.join(dizin, "usage.jsonl");

    // Test koşucusu kaydı kapatarak başlatıyor (depo kaydını kirletmemek için).
    // Kaydın kendisini sınayan test onu açıkça geri açmalı.
    await sunucuyuCalistir([okuIstegi(2, "boyleBirSembolYok")], {
      VERDANDI_USAGE_LOG_PATH: yol,
      VERDANDI_USAGE_LOG: "1",
    });

    const satirlar = (await readFile(yol, "utf8")).trim().split("\n").filter(Boolean);
    assert.ok(satirlar.length >= 1, "en az bir kayıt yazılmalı");
    const kayit = JSON.parse(satirlar[satirlar.length - 1]);
    assert.equal(kayit.arac, "read_symbol");
    assert.equal(typeof kayit.sureMs, "number");
    // read_symbol bulamadığında hata fırlatmaz. Sinyal düşük güven ve
    // ambiguity gerekçesindedir; kayıt bunu görmezse her şey "başarılı" görünür.
    assert.ok(kayit.guven < 0.5, `düşük güven bekleniyordu, gelen: ${kayit.guven}`);
    assert.ok(
      Array.isArray(kayit.belirsizlik) && kayit.belirsizlik.some((s: string) => /not found/i.test(s)),
      "bulunamama gerekçesi kaydedilmeli",
    );
  });

  it("VERDANDI_USAGE_LOG=0 ile hiçbir şey yazmaz", async () => {
    const dizin = await mkdtemp(path.join(tmpdir(), "verdandi-kapali-"));
    gecici.push(dizin);
    const yol = path.join(dizin, "usage.jsonl");

    await sunucuyuCalistir([okuIstegi(2, "boyleBirSembolYok")], {
      VERDANDI_USAGE_LOG_PATH: yol,
      VERDANDI_USAGE_LOG: "0",
    });

    await assert.rejects(() => stat(yol), "kapalıyken dosya oluşmamalı");
  });

  it("kayıt yazılamasa bile araç çalışmaya devam eder ve stdout bozulmaz", async () => {
    // Yazılamayan bir yol: kayıt tutma başarısızlığı aracı düşürmemeli.
    const yazilamaz = path.join(KOK, "dist", "src", "mcp_server.js", "olmaz", "u.jsonl");

    const cikti = await sunucuyuCalistir([okuIstegi(2, "boyleBirSembolYok")], {
      VERDANDI_USAGE_LOG_PATH: yazilamaz,
      VERDANDI_USAGE_LOG: "1",
    });

    const satirlar = cikti.split("\n").filter(Boolean);
    // stdout JSON-RPC kanalıdır; kayıt kodu oraya tek bir bayt yazmamalı.
    for (const satir of satirlar) {
      assert.doesNotThrow(() => JSON.parse(satir), `stdout kirlendi: ${satir.slice(0, 120)}`);
    }
    const yanitlar = satirlar.map((s) => JSON.parse(s));
    assert.ok(
      yanitlar.some((y) => y.id === 2 && y.result),
      "kayıt tutulamasa da araç yanıtı dönmeli",
    );
  });
});
