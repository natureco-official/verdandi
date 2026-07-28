# Benchmark koşumu

## Ne gerekiyor

Oracle'lar `modelcontextprotocol/typescript-sdk` deposunun worktree'lerine karşı
çalışır. Depo bu projenin içinde değildir; ayrıca hazırlanması gerekir.

```bash
node benchmark_runs/setup_worktrees.mjs
CAPSULE_WORKTREE_BASE="<çıktıda yazan yol>" npm run benchmark:retrieval
```

`pnpm` de gerekir (`npm i -g pnpm`); doğrulama koşucusu onu çağırır.

## Sabitlenen commit'ler hakkında

`RETRIEVAL-QUALITY-2026-07-28.md` içindeki ilk sonuçlar (hit@1 %100, sembol
recall %100) "sabitlenen commit" ile alınmıştı. **O commit'ler kayıtlı değil ve
bulunamadı** — ne yer gerçeğinde, ne koşum raporlarında, ne bir manifestte.

Sonucu şu: o sayılar yeniden üretilemez. 28.07.2026'da güncel HEAD ile alınan
bağımsız ölçüm dört metrikten üçünü eşiğin üstünde buldu; sembol recall'ı
düşüktü, çünkü beklenen sembollerin dördü depoda artık yok (retrieval
gerilemesi değil, commit kayması).

Bu yüzden oracle artık her koşumda kendi dayanağını yazıyor:

```json
{ "schemaVersion": 2, "baseCommit": "cc4b416…", "measuredAt": "2026-07-28T…" }
```

**Yeni bir sonuç yayınlarken `baseCommit` alanını da yayınlayın.** Dayanağı
kayıtlı olmayan bir ölçüm, bir süre sonra iddia hâline gelir.

## Görevlerin dayandığı sürümü sabitlemek

Karşılaştırılabilir sonuçlar istiyorsanız worktree'leri belirli bir commit'e
sabitleyin:

```bash
node benchmark_runs/setup_worktrees.mjs --commit <sha>
```

Sabitlenen sürümü bir sonraki raporun içine yazın; aksi hâlde depo ilerledikçe
sayılar sessizce kayar ve kimse sebebini bilemez.
