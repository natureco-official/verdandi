# Verðandi sistem sağlamlaştırma raporu — 2026-07-28

## Sonuç

Bu turda kaynak, MCP sınırı, ajan döngüsü, otomatik adaptörler ve benchmark koşucuları bağımsız olarak denetlendi. Yerel ve lockfile'dan izole tam paket **105/105**, typecheck, statik güvenlik lint'i ve canlı MCP smoke testi başarılıdır. `npm audit` bilinen güvenlik açığı bildirmemiştir.

“Kusursuzluk” mutlak olarak kanıtlanamaz. Mevcut kanıt, sistemin test edilen TypeScript/MCP kapsamı içinde önceki halinden belirgin biçimde daha güvenli, hatayı saklamayan ve kaynak kullanımını sınırlayan bir duruma geldiğini gösterir.

## Düzeltilen kritik ve yüksek etkili sorunlar

1. Benchmark validator artık ilan edilen hedef test dosyasının gerçekten varlığını önceden doğrular. Başka testlerin tesadüfen geçmesi eksik hedef testi maskeleyemez.
2. Validator herhangi bir alt komut başarısız olduğunda non-zero çıkar; timeout'ta `SIGTERM` sonrası `SIGKILL` uygular; spawn hatasını kaydeder; stdout/stderr belleği 4 MiB ile sınırlıdır ve truncation loglanır.
3. Benchmark ajan koşucusuna 30 dakika varsayılan üst süre, 64 MiB stdout/8 MiB stderr sınırı, geçerli timeout ayarı kontrolü ve spawn-hata kaydı eklendi.
4. Benchmark prompt'u depo-geneli çıktı, tekrar okuma, git geçmişi tarama ve birleşik komutlarda erken hata maskelemesini sınırlar.
5. MCP sunucusu bozuk JSON, geçersiz JSON-RPC zarfı/ID/parametre, bilinmeyen araç ve iç hata sınıflarını standart hata kodlarıyla ayırır; beklenmeyen iç hata ayrıntılarını sızdırmaz.
6. MCP istekleri, task/path/symbol, patch adedi/içeriği, `read_symbol` bütçesi ve validation çıktısı için üst sınırlar uygular.
7. Belirsiz `read_symbol` çağrısı sekiz tam gövde dökmek yerine yalnız imzaları döndürür ve `fileHint` ister.
8. Çok dosyalı patch'in crash-safe rollback günlüğü kaynaklara dokunmadan önce yazılır. Güvenli günlük oluşturulamıyorsa patch reddedilir. Kısmi süreç çökmesinden sonra hem yazılmış hem henüz yazılmamış dosyalar güvenle ayırt edilir.
9. Rollback yedek hacmi 16 MiB, toplam patch içeriği 8 MiB ve operasyon sayısı 100 ile sınırlıdır.
10. İndeks yürüyüşü okunamayan veya yarış sırasında kaybolan alt girdilerde tüm projeyi düşürmez; sonucu `truncated` işaretleyip confidence'ı düşürür.
11. Auto-capsule ve auto-inject ortak, bounded stdio istemcisi kullanır. Sunucu kapanışı/EPIPE/bozuk JSON bekleyen çağrıları timeout'u beklemeden reddeder ve zorunlu kapanış uygular.
12. LLM API yanıtı streaming olarak en fazla 8 MiB okunur; timeout 1 saniye–30 dakika aralığına, prompt 100.000 tokene, görev 20.000 karaktere ve model editleri 100 adede sınırlandı.
13. Dokümantasyondaki eski test sayısı ve sabit “200–300 token” iddiaları kaldırıldı; bütçeye bağlı 200–1200 sınırıyla uyumlu hale getirildi.
14. `@modelcontextprotocol/client@2.0.0` ile gerçek stdio çapraz uyumluluk kapısı eklendi. Legacy initialize ve 2026-07-28 discovery akışları birlikte doğrulanıyor.
15. Modern MCP cevaplarına zorunlu `resultType`, `tools/list` cache alanları ve tutarlı server identity metadata'sı eklendi; desteklenmeyen modern sürümler `-32022` ile reddediliyor.
16. `it/test` çağrı blokları AST retrieval sembolü olarak indeksleniyor; T04'teki test-dosyası kör noktası kapatıldı ve T01–T10 etiketli precision/recall oracle'sı eklendi.

## Doğrulama matrisi

| Kontrol | Sonuç |
|---|---:|
| `npm run lint` (typecheck dahil) | PASS |
| `npm test` | 105/105 PASS |
| `node smoke_test.mjs` | PASS; 5 MCP aracı canlı |
| `node benchmark_test.mjs` | PASS; sentetik 29.095 → 676 BPE token |
| İzole `npm ci` | PASS; lockfile'dan 22 paket kuruldu |
| İzole temiz kurulumda `npm test` | 105/105 PASS |
| `npm audit --json` | 0 bilinen açık |
| Resmî MCP TypeScript istemcisi, legacy + modern stdio | PASS |
| T01–T10 retrieval oracle | hit@1 %100; dosya-grubu recall %100; precision %60,78; sembol recall %100 |
| Auto-capsule gerçek süreç smoke | PASS |
| Benchmark JS sözdizimi kontrolleri | PASS |

Sentetik 97,68% bağlam küçülmesi uçtan uca kalite veya gerçek ajan faturası değildir; yalnız seçilmiş dosyaların tokenizer ile ölçülen bağlam hacmidir.

## T01–T10 toplu canlı sonuç

Ham `meta.json` kayıtlarının toplamı:

| Ölçüm | Standart Codex | Optimize Capsule | Fark |
|---|---:|---:|---:|
| Input token (cached dahil) | 13.826.263 | 4.047.792 | **-%70,7** |
| Output token | 79.747 | 55.205 | **-%30,8** |
| Süre | 3.013.175 ms | 1.795.989 ms | **-%40,4** |

Bu toplam tek başına genellenebilir üstünlük kanıtı değildir:

- T01'de Capsule input/output ve süre bakımından daha pahalıdır.
- T07 input azalırken süre, output ve reasoning artmıştır.
- T04'ün ilk yeşil sonucu test sırası bağımlılığı nedeniyle geçersizdi. Testler explicit fetch injection ile düzeltildi; validator artık davranış oracle'sını üç ayrı süreçte çalıştırıyor ve iki worktree de geçiyor. Bu post-run düzeltmenin maliyeti eski token ölçümüne dahil değildir.
- T02/T03 integration-wide typecheck fiziksel olarak non-zero kalır. Validator yalnız başlangıç commit'ine ait 47/44 tanının dosya+satır+sütun+kod SHA-256 imzası birebir eşleşirse bunu `acceptedBaselineFailure` olarak ayırır; hedef test ve lint iki grupta geçer.
- T08'in eski runtime toplu testi görev dışı ağ/zamanlama hatalarını karıştırıyordu. Yeni declaration oracle özel/private core importu, workspace graph sızıntısı, eksik manifest bağımlılığı ve aşırı dts boyutunu reddeder. Bu oracle Capsule çıktısındaki gerçek private-core sızıntısını buldu ve düzeltme sonrası iki worktree de geçiyor.
- T05, T06, T09 ve T10 hedef davranış, test, lint ve typecheck doğrulamalarını tam geçmiştir. T07 hedef client testi de geçmiştir.

## Kalan dürüst riskler

- Benchmark yalnız on görev, tek ana model ailesi ve çoğunlukla tek koşum içerir; istatistiksel güven için T11–T40 ve çoklu tekrar gerekir.
- Kör insan/üçüncü-model kalite değerlendirmesi henüz tamamlanmamıştır.
- Token ölçümünün canlı `input_tokens` alanı cache okumalarını içerir; sağlayıcı fiyatı ve fresh-token yorumu ayrıca raporlanmalıdır.
- Çekirdek yalnız TypeScript/JavaScript AST'sini destekler.
- Gerçek OS power-loss sırasında dosya sistemi `fsync` dayanıklılığı garanti edilmez; günlük yazma sırası süreç çökmesini kapsar, fiziksel disk kaybını değil.
- MCP stdio uygulaması resmî TypeScript istemcisinin legacy ve 2026-07-28 akışlarıyla doğrulandı; Streamable HTTP/SSE taşıyıcıları sunucunun mevcut kapsamı değildir.

## Sonraki kalite eşiği

1. T11–T40, her varyant için en az üç tekrar ve median/p95 raporu.
2. Retrieval precision/recall için etiketli beklenen dosya/sembol seti.
3. Kör kalite review ve başarısızlık türüne göre skor.
4. İkinci bağımsız MCP istemci uygulamasıyla çapraz uyumluluk ve bozuk-peer fuzzing.
