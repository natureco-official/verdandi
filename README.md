# Verðandi Context Compiler

[![CI](https://github.com/natureco-official/verdandi/actions/workflows/ci.yml/badge.svg)](https://github.com/natureco-official/verdandi/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

Verðandi, AI coding agent'ları için TypeScript AST tabanlı görev bağlamı derleyicisidir. Geniş kod tabanlarından görevle ilgili sembolleri seçer, sınırlı kaynak dilimleri sağlar ve isteğe bağlı güvenli sembol yamaları uygular.

## Başlangıç

```bash
npm install
npm run build
npm test
./run_with_capsule.sh codex /path/to/project "Görevi yaz"
```

`npm test` tam birim, entegrasyon, benchmark-koşucu ve bağımsız adversarial güvenlik paketini çalıştırır. Test sayısı geliştikçe değiştiğinden başarı ölçütü komutun sıfır çıkış kodu ve rapordaki sıfır başarısız testtir. (28.07.2026 itibarıyla: 111 test, hepsi geçiyor.)

### Windows

Takım Windows'ta da eksiksiz çalışır, iki noktaya dikkat edin:

- **Symlink güvenlik testleri** Geliştirici Modu gerektirir. Kapalıysa bu iki test gerekçesiyle atlanır (başarısız olmaz), ama symlink kaçış korumaları o makinede doğrulanmamış olur. Açmak için: *Ayarlar → Sistem → Geliştiriciler için → Geliştirici Modu*.
- **Benchmark koşucusu** `pnpm` çağırır (`npm i -g pnpm`). Kurulu değilse ilgili testler atlanır.
 `benchmark_test.mjs` yalnızca bu depodaki seçilmiş dosyalarla sentetik bağlam hacmini ölçer; uçtan uca ajan token maliyetini veya kalite eşdeğerliğini kanıtlamaz.

## Çalışma Modları

### Auto-inject

`run_with_capsule.sh`, kapsülü ve seçilen kaynak dilimlerini desteklenen ajanın prompt'una ekler:

```bash
./run_with_capsule.sh <agent> <project-root> "Görev"
```

Desteklenen ajanlar: `natureco`, `hermes`, `codex`, `claude`, `opencode`, `openclaw`, `kimi`, `glm`.

### MCP sunucusu

```bash
node bin/verdandi-context-compiler setup codex
node bin/verdandi-context-compiler status
```

`setup` ilgili ajan için çalıştırılacak kayıt komutunu gösterir. MCP sunucusunu doğrudan başlatmak için `npm start` kullanın.

Stdio protokol sınırı, sabitlenmiş resmî `@modelcontextprotocol/client@2.0.0` ile hem legacy initialize hem de 2026-07-28 `server/discover` akışında sürekli test edilir.

Araçlar:

- `context_capsule`: Görev için sembol ve dosya seçer.
- `read_symbol`: Sembolün kaynak kanıtını ve karmalarını döndürür.
- `apply_structured_patch`: Snapshot ve içerik önkoşullarıyla yama uygular.
- `rollback_patch`: Sadece proje içindeki, yama sonrasında değişmemiş dosyaları geri alır.
- `validate_delta`: Yalnızca çağıran `commandProfile: "package-scripts"` ile açıkça izin verdiğinde proje scriptlerini çalıştırır.

### Bağımsız ajan

```bash
verdandi-agent "Import sıralamasını düzelt" --project ./project --model gpt-4o --api-key "$VERDANDI_API_KEY"
```

Ortam değişkenleri: `VERDANDI_API_KEY`, `VERDANDI_MODEL`, `VERDANDI_BASE_URL`, `VERDANDI_REQUEST_TIMEOUT_MS`, `VERDANDI_CODEX_MODEL`. Eski `URDR_*` değişkenleri geriye uyumluluk için desteklenir.

## Güvenlik ve Sınırlar

- Yamalar kaynak snapshot'ı ve dosya/sembol karmalarını doğrular; eşzamanlı değişen veya proje dışına çözümlenen yolları reddeder.
- Bağımsız ajan çok dosyalı editleri tek atomik patch olarak uygular; hazırlama veya doğrulama hatasında tüm patch geri alınır.
- Rollback kayıtları yalnızca göreli dosya yollarını saklar ve kullanıcının sonradan değiştirdiği dosyaları ezmez.
- Model editleri allowlist ile doğrulanır; eksik, bilinmeyen veya kesilmiş edit dizileri kısmen uygulanmaz.
- Düşük retrieval confidence Seviye 3 bütçesini gerçekten genişletir; kontrol metadata'sı MCP model içeriğinden ayrı tutulur.
- `validate_delta` paket scriptlerini çalıştırabildiğinden güvenilmeyen projelerde yalnızca açık kullanıcı onayıyla çağrılmalıdır.

## Geliştirme

```bash
npm run typecheck
npm run lint
npm test
node smoke_test.mjs
node benchmark_test.mjs
node benchmark_runs/setup_worktrees.mjs   # worktree'leri hazırlar
CAPSULE_WORKTREE_BASE="<çıktıda yazan yol>" npm run benchmark:retrieval
```

GitHub Actions kalite matrisi aynı kapıları **Ubuntu, macOS ve Windows** üzerinde Node 20, 22 ve 24 ile çalıştırır; action sürümleri immutable commit SHA'larına sabitlenmiştir.

Windows matrise 28.07.2026'da eklendi. O güne dek yalnızca Ubuntu ve macOS koşuluyordu ve Windows'a özgü üç hata fark edilmemişti: `validate_delta` hiç çalışmıyordu, benchmark koşucusu her komutu "bulunamadı" sayıyordu ve testlerin dördü ortam farkı yüzünden düşüyordu. Bir platformda koşmayan test, o platformda olmayan testtir.

Mimari ayrıntıları ve ajan bazlı komutlar için `UNIVERSAL.md` ve `integrations/` dizinine bakın.

## Ölçüm durumu

Retrieval kalitesi T01–T10 için `modelcontextprotocol/typescript-sdk` worktree'lerine
karşı ölçülür. Son bağımsız koşum (28.07.2026, dayanak `cc4b416`):

| Ölçüm | Sonuç | Eşik |
|---|---:|---:|
| Birincil dosya `hit@1` | %90,00 | ≥ %90 |
| Zorunlu dosya-grubu recall | %95,45 | ≥ %90 |
| Kabul edilebilir dosya precision | %50,91 | ≥ %50 |
| Sembol-grubu recall | %53,33 | ≥ %85 |

Sembol recall eşiğin altında. Sebep retrieval gerilemesi değil: beklenen dört
sembol (`signalProcessGroup`, `stopProcessGroup`, `trimHeaderOws`,
`serializeProtocolDocument`) güncel depoda artık yok — dosyalar duruyor,
semboller yeniden adlandırılmış.

Daha önce yayınlanan %100'lük sonuçlar sabitlenen commit'lerle alınmıştı ve
**yeniden üretilemiyor**: o commit'ler kayıtlı değil. Bu yüzden oracle artık her
koşumda `baseCommit` ve `measuredAt` alanlarını yazar. Ayrıntı:
[`benchmark_runs/RETRIEVAL-QUALITY-2026-07-28.md`](benchmark_runs/RETRIEVAL-QUALITY-2026-07-28.md).

Benchmark hâlâ on göreve dayanıyor; T11–T40, ikinci bağımsız etiketleyici ve kör
çözüm kalitesi değerlendirmesi bekliyor. Sonuçlar bu hâliyle genellenebilir değil.

## Nature.co ekosistemi

- [Urðr](https://github.com/natureco-official/urdr) — ağaç yapılı kalıcı karar belleği
- [CodeDNA](https://github.com/natureco-official/codedna) — kod kimlik ve benzerlik analizi
- [NatureCo CLI](https://github.com/natureco-official/natureco-cli) — platform komut satırı aracı
- [NatureCo SDK](https://github.com/natureco-official/natureco-sdk) — JavaScript SDK
- [Cupertino Terminal](https://github.com/natureco-official/cupertino-terminal) — macOS'tan Windows'a uzak terminal

Verðandi yalnızca görev bağlamı üretir; kalıcı karar belleği Urðr'a aittir.

## Lisans

MIT — bkz. [LICENSE](LICENSE).
