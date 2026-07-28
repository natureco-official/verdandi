# T09–T10 token optimizasyonu — 2026-07-28

## Kapsam ve yöntem

- Kontrol grubu: 27 Temmuz 2026 tarihli `gpt-5.6-sol`, medium effort standart Codex koşumları.
- Deney grubu: aynı başlangıç commit'lerindeki temiz `T09-codex-capsule` ve `T10-codex-capsule` worktree'leri.
- T09 ve T10 için önceden Capsule koşumu bulunmadığından karşılaştırma standart Codex → optimize edilmiş Capsule şeklindedir.
- Önceki ham izler `/private/tmp/capsule-t09-t10-before-token-fix-20260728` altında arşivlendi.

## Kök neden

- T09 24 terminal çağrısı ve 439.454 karakter terminal çıktısı üretti. İlk depo-geneli arama 141.322 karakterdi; ayrıca geçmiş commit diff'leri ve geniş codec aramaları tekrar bağlama alındı.
- T10 18 terminal çağrısı yaptı; aynı iki büyük transport ile test dosyaları geniş satır aralıklarıyla tekrar tekrar okundu.
- Serialize/document/cache-hit kavramları gerçek `_serveFromCache` seam'ine yeterince bağlanmıyordu.
- `.examples.ts` sembolleri aynı sınıf adlarını tekrarlayarak gerçek per-request transportu sıralamada geriye itiyordu.

## Uygulanan düzeltmeler

- `serialize`/`deserialize` görevleri `encode`, `decode`, `document`, `codec` kavramlarına genişletildi.
- Cache `hit` görevi `serve`, `read`, `write`; Türkçe `aynalama` görevi `mirror`/`mirroring` ile bağlandı.
- Kullanıcı açıkça örnek istemedikçe example/demo/fixture sembollerinin production uygulamayı geçmesi engellendi.
- T09 retrieval'ı `responseCache.ts` ile `_serveFromCache` metodunu birlikte getiriyor.
- T10 retrieval'ı shared `streamableHttp.ts` ile `perRequestTransport.ts` dosyalarını birlikte getiriyor.
- Bu davranışlar için iki yeni regresyon testi eklendi.

## Sonuçlar

| Görev | Ölçüm | Standart Codex | Optimize Capsule | Değişim |
|---|---|---:|---:|---:|
| T09 | Süre | 670.555 ms | 201.221 ms | **-%70,0** |
| T09 | Input token | 3.417.767 | 414.962 | **-%87,9** |
| T09 | Output token | 13.799 | 7.210 | -%47,7 |
| T09 | Reasoning output | 2.565 | 3.035 | +%18,3 |
| T10 | Süre | 270.795 ms | 221.623 ms | **-%18,2** |
| T10 | Input token | 1.668.854 | 611.438 | **-%63,4** |
| T10 | Output token | 9.545 | 7.852 | -%17,7 |
| T10 | Reasoning output | 1.550 | 2.468 | +%59,2 |
| Toplam | Süre | 941.350 ms | 422.844 ms | **-%55,1** |
| Toplam | Input token | 5.086.621 | 1.026.400 | **-%79,8** |
| Toplam | Uncached input | 236.445 | 134.496 | -%43,1 |
| Toplam | Output token | 23.344 | 15.062 | -%35,5 |
| Toplam | Reasoning output | 4.115 | 5.503 | **+%33,7** |

Toplam maliyet ve süre güçlü biçimde düştü; ancak reasoning output iki görevde de arttı. Bu nedenle kazanım bütün token sınıflarında eşit değildir.

## İz ekonomisi

| Görev | Terminal çağrısı | Terminal çıktı karakteri | En büyük tek çıktı |
|---|---:|---:|---:|
| T09 önce | 24 | 439.454 | 141.322 |
| T09 sonra | 8 | 104.402 | 24.421 |
| T10 önce | 18 | 221.776 | 40.420 |
| T10 sonra | 8 | 200.145 | 71.954 |

Toplam terminal çağrısı 42'den 16'ya, terminal çıktısı 661.230 karakterden 304.547 karaktere düştü. T10'un en büyük tek komut çıktısı arttı; buna rağmen input kazancı daha az tur ve daha az tekrar sayesinde oluştu.

## Kalite doğrulaması

### Capsule

- Lint/typecheck başarılı.
- 86/86 test başarılı.

### T09

- Validator: 67/67 hedef test başarılı; client lint ve typecheck başarılı.
- Cache yazımı runtime nesnesi yerine JSON protocol document string'i saklıyor.
- Her cache read yeni decode edilmiş, izole bir nesne döndürüyor; `structuredClone` bağımlılığı kaldırıldı.
- Eski/custom store'lardaki non-string değerler geriye uyumluluk için kabul ediliyor.
- Serialize/store/decode round-trip, cache-hit izolasyonu ve parametre aynalama testleri başarılı.
- `git diff --check` başarılı; yalnız iki client kaynağı ve iki ilgili test dosyası değişti.

### T10

- Validator: 59/59 hedef test başarılı; server lint ve typecheck başarılı.
- Per-request ve shared Web-standard SSE yolları comment-frame keep-alive gönderiyor.
- Per-request abort ve shared stream cancel sonrasında fake-timer sayısı sıfıra düşüyor.
- Explicit transport close tüm stream mapping cleanup yollarını kullanıyor.
- `git diff --check` başarılı; değişiklikler server transport/handler seam'leri ve ilgili iki test dosyasıyla sınırlı.

## Kalan optimizasyon noktası

T10 yalnız sekiz terminal çağrısı yapmasına rağmen ilk iki kaynak okuması toplam 118 KB çıktı üretti. Sonraki benchmark talimatında çağrı başına birleşik kaynak okuma sınırı eklenirse reasoning ve tek-komut çıktı maliyeti ayrıca düşürülebilir.
