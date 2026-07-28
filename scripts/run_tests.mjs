#!/usr/bin/env node
/**
 * Test koşucusu — kabuktan bağımsız.
 *
 * Neden var: test scripti `node --test __tests__/*.test.ts` çağırıyordu ve glob
 * genişletmesini kabuğa bırakıyordu. Bu üç yerde birden kırılıyor:
 *
 *   - Windows'ta npm scriptleri cmd ile çalışır; cmd glob genişletmez.
 *   - GitHub Actions Windows'ta varsayılan pwsh de dış komutlar için genişletmez.
 *   - Node 20'nin test koşucusu glob'u kendisi çözmez (Node 22+ çözer), bu
 *     yüzden deseni dosya adı sanar: "Could not find ...\__tests__\*.test.ts".
 *
 * Sonuç: takım Node 20 + Windows'ta hiç çalışmıyordu ve iş akışına `shell: bash`
 * eklemek de yetmedi — o yalnızca adımın kendi komutunu etkiliyor, npm'in
 * içeride açtığı kabuğu değil.
 *
 * Burada dosyalar Node ile bulunuyor ve test koşucusuna tek tek veriliyor.
 * Kabuk hangi platformda ne yaparsa yapsın sonuç aynı.
 *
 * Kullanım:
 *   node scripts/run_tests.mjs                      # varsayılan raportör
 *   node scripts/run_tests.mjs --test-reporter=dot  # ek bayraklar aktarılır
 */
import { readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const kok = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testDizini = path.join(kok, "__tests__");

const dosyalar = readdirSync(testDizini)
  .filter(ad => ad.endsWith(".test.ts"))
  .sort()
  .map(ad => path.join(testDizini, ad));

if (dosyalar.length === 0) {
  console.error("run_tests: __tests__ içinde .test.ts dosyası bulunamadı.");
  process.exit(1);
}

// Bayraklar dosya adlarından ÖNCE gelmeli: Node 20 sonrasında gelen bayrağı
// dosya yolu sanıyor.
const ekBayraklar = process.argv.slice(2);

// Testler gerçek MCP sunucusunu başlatıyor ve kayıt varsayılan olarak açık.
// Devre dışı bırakılmazsa depo içindeki .verdandi/usage.jsonl her `npm test`
// ile şişer ve "gerçek kullanımda ne bozuluyor" sinyali test gürültüsünün
// altında kalır. Kaydın kendi testleri yolu zaten geçici bir dizine çeviriyor,
// bu yüzden onlar bundan etkilenmez.
const cocuk = spawn(
  process.execPath,
  ["--import", "tsx", ...ekBayraklar, "--test", ...dosyalar],
  { cwd: kok, stdio: "inherit", env: { ...process.env, VERDANDI_USAGE_LOG: "0" } },
);

cocuk.on("exit", (kod, sinyal) => {
  if (sinyal) {
    console.error(`run_tests: test koşucusu ${sinyal} sinyaliyle durdu.`);
    process.exit(1);
  }
  process.exit(kod ?? 1);
});
