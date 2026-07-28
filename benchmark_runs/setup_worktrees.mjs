#!/usr/bin/env node
/**
 * Benchmark worktree'lerini hazırlar.
 *
 * Oracle'lar `${CAPSULE_WORKTREE_BASE}/T01-codex-capsule` … `T10-codex-capsule`
 * dizinlerini bekler. Bu dizinler `modelcontextprotocol/typescript-sdk`
 * deposunun kopyalarıdır ve projeyle birlikte gelmez.
 *
 * Neden var: kurulum hiçbir yerde yazılı değildi. Oracle varsayılan olarak
 * `/private/tmp/capsule-baseline-worktrees` yolunu deniyordu — macOS'un gerçek
 * /tmp yolu — ve başka bir makinede ENOENT veriyordu. Benchmark'ı çalıştırmak
 * için önce hangi deponun, nereye, nasıl kurulacağını bulmak gerekiyordu.
 *
 * Kullanım:
 *   node benchmark_runs/setup_worktrees.mjs
 *   node benchmark_runs/setup_worktrees.mjs --commit <sha>
 *   node benchmark_runs/setup_worktrees.mjs --base C:/bir/yol
 */
import { execFile } from "node:child_process";
import { mkdir, symlink, access, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const DEPO = "https://github.com/modelcontextprotocol/typescript-sdk.git";
const GOREVLER = Array.from({ length: 10 }, (_, i) => `T${String(i + 1).padStart(2, "0")}`);

const bayrak = (ad) => {
  const i = process.argv.indexOf(ad);
  return i > -1 ? process.argv[i + 1] : null;
};

const kok = bayrak("--base") || path.join(os.homedir(), "capsule-benchmark");
const commit = bayrak("--commit");
const kaynak = path.join(kok, "typescript-sdk");
const worktreeBase = path.join(kok, "worktrees");

const calistir = (komut, argumanlar, cwd) =>
  new Promise((cozumle, reddet) => {
    execFile(komut, argumanlar, { cwd, maxBuffer: 16 * 1024 * 1024 }, (hata, cikti) =>
      hata ? reddet(hata) : cozumle(String(cikti).trim()),
    );
  });

const varMi = async (yol) => access(yol).then(() => true).catch(() => false);

await mkdir(kok, { recursive: true });

if (await varMi(kaynak)) {
  console.log(`kaynak zaten var: ${kaynak}`);
} else {
  console.log(`klonlanıyor: ${DEPO}`);
  // Belirli bir commit isteniyorsa sığ klon yetmez; tam geçmiş gerekir.
  await calistir("git", commit ? ["clone", DEPO, kaynak] : ["clone", "--depth", "1", DEPO, kaynak]);
}

if (commit) {
  console.log(`sabitleniyor: ${commit}`);
  await calistir("git", ["checkout", "--quiet", commit], kaynak);
}

const dayanak = await calistir("git", ["rev-parse", "HEAD"], kaynak);

await mkdir(worktreeBase, { recursive: true });
let olusan = 0;
for (const gorev of GOREVLER) {
  const hedef = path.join(worktreeBase, `${gorev}-codex-capsule`);
  if (await varMi(hedef)) continue;
  // Her göreve ayrı kopya çıkarmak yerine tek kaynağa bağlantı: oracle yalnızca
  // OKUYOR. Görevler farklı commit'lere sabitlenecekse bu satır gerçek
  // `git worktree add` ile değiştirilmelidir.
  await symlink(kaynak, hedef, "dir").catch(async (hata) => {
    if (hata.code === "EPERM") {
      throw new Error(
        "symlink oluşturulamadı (EPERM). Windows'ta Geliştirici Modu'nu açın " +
          "ya da --base ile symlink gerektirmeyen bir yol verin.",
      );
    }
    throw hata;
  });
  olusan++;
}

console.log(`\nworktree kökü : ${worktreeBase}`);
console.log(`oluşturulan   : ${olusan} / ${GOREVLER.length}`);
console.log(`dayanak commit: ${dayanak}`);
console.log(`\nÇalıştırmak için:\n  CAPSULE_WORKTREE_BASE="${worktreeBase.replace(/\\/g, "/")}" npm run benchmark:retrieval`);
