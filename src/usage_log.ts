// Gerçek kullanım kaydı — sorunları tahminle değil kanıtla bulmak için.
//
// Şimdiye kadarki bütün ölçümler benchmark koşumlarından geldi: seçilmiş
// görevler, temiz worktree'ler, tek depo. Günlük kullanımda neyin bozulduğunu
// bunlar göstermez. Retrieval'ın ıskaladığı, güvenin sürekli eşiğin altında
// kaldığı, yamanın bayat hash yüzünden reddedildiği durumlar ancak burada
// görünür.
//
// Kurallar:
//  - Yalnızca yerel dosya. Ağ yok, uzak uç yok.
//  - Kaynak kodu ya da sembol gövdesi yazılmaz; sayılar ve kısa görev metni.
//  - Kayıt hiçbir koşulda sunucuyu düşürmez; her hata yutulur.
//  - stdout'a asla yazılmaz — orası JSON-RPC kanalı.
//  - VERDANDI_USAGE_LOG=0 ile tamamen kapanır.

import { appendFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const KAPALI = process.env.VERDANDI_USAGE_LOG === "0";

const DOSYA =
  process.env.VERDANDI_USAGE_LOG_PATH ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.verdandi/usage.jsonl");

// Görev metni tanılama için gerekli ama uzunluğu sınırlı tutulur: amaç
// "hangi görevde ıskaladı" sorusunu cevaplamak, geçmişi arşivlemek değil.
const GOREV_SINIRI = 200;

export type KullanimKaydi = {
  arac: string;
  sureMs: number;
  hata?: string;
  gorev?: string;
  sembolSayisi?: number;
  dosyaSayisi?: number;
  kapsulToken?: number;
  guven?: number;
  yukseltme?: number;
  devredildi?: boolean;
  devirNedeni?: string;
  belirsizlik?: string[];
};

export function kullanimKaydet(kayit: KullanimKaydi): void {
  if (KAPALI) return;
  try {
    const satir = {
      t: new Date().toISOString(),
      ...kayit,
      gorev: kayit.gorev ? kayit.gorev.slice(0, GOREV_SINIRI) : undefined,
    };
    mkdirSync(path.dirname(DOSYA), { recursive: true });
    appendFileSync(DOSYA, `${JSON.stringify(satir)}\n`, "utf8");
  } catch {
    // Kayıt tutulamaması bir aracın çalışmamasına asla sebep olmamalı.
  }
}

export const kullanimKaydiYolu = DOSYA;
