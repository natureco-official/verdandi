# Verðandi Context Compiler Benchmark Şablonu

## Amaç

Context compiler kullanılan deney kolunu mevcut Codex/Claude Code taban çizgisiyle aynı görevlerde karşılaştırmak. Bir görev yalnızca test geçtiği için başarılı sayılmaz; işlevsel doğrulama, kör inceleme ve token tüketimi birlikte değerlendirilir.

## Set oluşturma kuralları

- Toplam 30–50 gerçek görev seç.
- Görevlerin en az %20–30'u çok dosyalı ve/veya belirsiz olsun. Önerilen 40 görevlik sette en az 10–12 görev bu grupta olmalı.
- Yalnızca kolay bug fix seçme; özellik ekleme, refactor, test yazma, API değişikliği ve belirsiz hata ayıklama görevlerini dengeli dağıt.
- Her görev için temiz ve yeniden kurulabilir bir başlangıç Git commit'i kullan.
- Aynı model, reasoning ayarı, izinler, araçlar ve başarı kriterleri iki kolda da korunmalı.
- Görev tanımı çözümü ele vermemeli; iki kola aynı metin gönderilmeli.

## Önerilen kategori dağılımı

| Kategori | Önerilen oran | Örnek |
|---|---:|---|
| Tek sembollü hata düzeltme | %15–20 | Bir fonksiyondaki sınır koşulu |
| Çok dosyalı hata düzeltme | %15–20 | API, servis ve test uyumsuzluğu |
| Küçük özellik | %15–20 | Var olan akışa yeni seçenek |
| Refactor | %10–15 | Davranışı koruyan modül ayırma |
| Test ekleme/düzeltme | %10 | Eksik regresyon testi |
| Tip/API sözleşmesi değişikliği | %10 | Interface ve tüketicilerini güncelleme |
| Belirsiz hata ayıklama | %10–15 | Hatanın yeri görevde belirtilmiyor |

## Görev envanteri

`Dosya kapsamı` değeri `tek` veya `çok`; `Belirsizlik` değeri `düşük`, `orta` veya `yüksek` olmalıdır.

**İlk benchmark deposu:** `modelcontextprotocol/typescript-sdk` (`https://github.com/modelcontextprotocol/typescript-sdk`). Her görev, gerçek bir tarihsel düzeltmenin ebeveyn commit'inden bağımsız olarak başlatılır. Sonraki gerçek commit değerlendirme için kör referans çözüm olarak saklanır ve görev ajanına verilmez.

| ID | Kategori | Zorluk | Dosya kapsamı | Belirsizlik | Görev özeti | Başlangıç commit'i | Başarı kriteri | Beklenen token aralığı |
|---|---|---|---|---|---|---|---|---|
| T01 | Deterministik/lint düzeltmesi | kolay | tek | düşük | Client auth modülündeki import sıralamasını depo lint kurallarına uygun hale getir; davranışı değiştirme. | `61866d7a5ff4475663ceb525c88447c497c1b92a` | İlgili dosya lint kontrolünü geçer; çalışma zamanı davranışı ve public API değişmez. | 0–500 |
| T02 | Test altyapısı düzeltmesi | orta | tek | orta | Cloudflare Workers entegrasyon testinin koşum sırasında workspace `dist` çıktısını yeniden yazmasını ve diğer testleri etkilemesini engelle. | `78fbe2736d72be4841072b359b3a2b8c6f97cd5c` | Test izole geçici çıktı kullanır; workspace `dist` değişmez; entegrasyon testi geçer. | 500–1000 |
| T03 | Test altyapısı/hata ayıklama | orta | tek | yüksek | Cloudflare Workers entegrasyon testinden sonra `workerd` süreçlerinin sızmasını ve sonraki koşumların eski portlarda asılı kalmasını önle. | `f2a3320677e114cfd60b75f240344f77e9005e3c` | Başarılı ve hatalı test yollarında child process kapanır; tekrar koşum stale port nedeniyle asılı kalmaz. | 500–1000 |
| T04 | Regresyon testi | kolay | çok | düşük | Geçersiz token nedeniyle 401 alan client auth akışının token refresh sonrası isteği doğru biçimde yeniden denediğini kapsayan regresyon testleri ekle. | `ee732d64b66440dcb455c6a179ef99eea9824358` | Auth ve Streamable HTTP testleri ilk 401'i, tek refresh'i ve başarılı retry'ı doğrular; mevcut testler geçer. | 500–1000 |
| T05 | Hata düzeltme | orta | çok | orta | Server resource URI'si çözümlenemediğinde genel/internal hata yerine MCP `Invalid Params` hatası döndür. | `e2aeac2085f967c1cb9579880d6de48cffe4ad54` | Malformed URI entegrasyon testi `Invalid Params` kodunu doğrular; geçerli resource istekleri etkilenmez. | 500–1000 |
| T06 | Protokol ayrıştırma düzeltmesi | orta | çok | orta | Standart MCP header değerlerini doğrulamadan önce optional whitespace'i (OWS) kırp; iç değeri gevşek eşleştirme. | `7e697354de95111ca2c70a12ac9f5d3ec96b56c3` | Baştaki/sondaki space ve tab kabul edilir; yanlış iç değer reddedilir; header doğrulama testleri geçer. | 500–1000 |
| T07 | İstemci oturum hijyeni | orta | çok | orta | Initialize isteğinde önceden kalmış session id gönderilmesini engelle; session id'yi yalnızca initialize yanıtından yakala. | `44797d77792953d0ce70b68922bb6bb69e697c32` | Initialize request session header taşımaz; response header sonraki isteklerde kullanılır; yeniden initialize senaryosu test edilir. | 500–1000 |
| T08 | Çok dosyalı build düzeltmesi | zor | çok | yüksek | Middleware paketlerinin declaration build sırasında workspace type graph'ını bundle edip dts üretiminde OOM oluşturmasını engelle; public tip yüzeyini koru. | `5e0249f57fdc1d7b7d69cd6140952a8e4e7ae695` | Express/Fastify/Hono/Node declaration build'leri workspace graph'ını gömmeden tamamlanır; yayımlanan tip importları çözümlenir. | 1000–3000 |
| T09 | Çok dosyalı refactor | zor | çok | yüksek | Client response cache'i runtime nesneleri yerine serialize edilmiş protocol document'ları saklayacak biçimde değiştir ve `structuredClone` bağımlılığını kaldır. | `3f07a325c6741b2374ce2255846dfa0c25f74d03` | Cache codec round-trip testleri, parametre aynalama ve response cache testleri geçer; cache hit davranışı ve public API korunur. | 1000–3000 |
| T10 | Çok dosyalı/ belirsiz hata düzeltme | zor | çok | yüksek | Web-standard Streamable HTTP transport'ta uzun SSE bağlantılarının boşta kalıp ara katmanlarca kapatılmasını önlemek için comment-frame keep-alive desteği ekle. | `1e1392e3f91583884fe82a0b4b91335875c3fba6` | Per-request ve shared transport yolları periyodik SSE comment frame yollar; timer kapanış/abort sonrası temizlenir; ilgili server testleri geçer. | 1000–3000 |
| T11 |  |  |  |  |  |  |  |  |
| T12 |  |  |  |  |  |  |  |  |
| T13 |  |  |  |  |  |  |  |  |
| T14 |  |  |  |  |  |  |  |  |
| T15 |  |  |  |  |  |  |  |  |
| T16 |  |  |  |  |  |  |  |  |
| T17 |  |  |  |  |  |  |  |  |
| T18 |  |  |  |  |  |  |  |  |
| T19 |  |  |  |  |  |  |  |  |
| T20 |  |  |  |  |  |  |  |  |
| T21 |  |  |  |  |  |  |  |  |
| T22 |  |  |  |  |  |  |  |  |
| T23 |  |  |  |  |  |  |  |  |
| T24 |  |  |  |  |  |  |  |  |
| T25 |  |  |  |  |  |  |  |  |
| T26 |  |  |  |  |  |  |  |  |
| T27 |  |  |  |  |  |  |  |  |
| T28 |  |  |  |  |  |  |  |  |
| T29 |  |  |  |  |  |  |  |  |
| T30 |  |  |  |  |  |  |  |  |
| T31 |  |  |  |  |  |  |  |  |
| T32 |  |  |  |  |  |  |  |  |
| T33 |  |  |  |  |  |  |  |  |
| T34 |  |  |  |  |  |  |  |  |
| T35 |  |  |  |  |  |  |  |  |
| T36 |  |  |  |  |  |  |  |  |
| T37 |  |  |  |  |  |  |  |  |
| T38 |  |  |  |  |  |  |  |  |
| T39 |  |  |  |  |  |  |  |  |
| T40 |  |  |  |  |  |  |  |  |

## Koşum kayıtları

Her görev iki bağımsız kolda çalıştırılır:

- `A`: context compiler olmadan taban çizgisi.
- `B`: context compiler ile deney kolu.

`Toplam yeni token`, cache'den okunan tokenları hariç tutar ve yalnızca **fresh input + output + reasoning** toplamıdır. Cache okuma ayrıca raporlanır; gerçek context boyutunu temsil eden ayrı bir metriktir.

| Görev ID | Kol | Model/ayar | Girdi token | Cache okuma | Çıktı token | Reasoning token | Toplam yeni token | Süre (sn) | Bütçe seviyesi | Otomatik yükseltme | Test/lint/typecheck | İnsan müdahalesi |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---|---|---|
| T01 | A | Codex · `gpt-5.6-sol` / medium | 22.846 | 109.824 | 1.154 | 256 | 24.256 | 49,5 | — | — | test ✓ · lint ✓ · typecheck ✓ | Hayır |
| T02 | A | Codex · `gpt-5.6-sol` / medium | 83.740 | 1.119.232 | 8.257 | 4.671 | 96.668 | 348,7 | — | — | test ✓ · lint ✓ · typecheck ✗ (tarihsel repo hataları) | Hayır |
| T03 | A | Codex · `gpt-5.6-sol` / medium | 64.887 | 1.307.136 | 9.777 | 3.723 | 78.387 | 368,9 | — | — | test ✗ (`Network connection lost`) · lint ✓ · typecheck ✗ (tarihsel repo hataları) | Hayır |
| T04 | A | Codex · `gpt-5.6-sol` / medium | 89.077 | 2.004.736 | 6.389 | 1.733 | 97.199 | 320,6 | — | — | test ✓ · lint ✓ · typecheck ✓ | Hayır |
| T05 | A | Codex · `gpt-5.6-sol` / medium | 53.569 | 624.896 | 3.843 | 761 | 58.173 | 141,1 | — | — | test ✓ · lint ✓ · typecheck ✓ | Hayır |
| T06 | A | Codex · `gpt-5.6-sol` / medium | 56.582 | 781.568 | 5.208 | 1.209 | 62.999 | 159,3 | — | — | test ✓ · lint ✓ · typecheck ✓ | Hayır |
| T07 | A | Codex · `gpt-5.6-sol` / medium | 50.964 | 581.632 | 4.024 | 1.011 | 55.999 | 123,4 | — | — | test ✓ · lint ✓ · typecheck ✓ | Hayır |
| T08 | A | Codex · `gpt-5.6-sol` / medium | 180.031 | 2.044.672 | 10.637 | 3.667 | 194.335 | 441,3 | — | — | test ✗ (2 assertion) · lint ✓ · typecheck ✓ · build ✓ | Hayır |
| T09 | A | Codex · `gpt-5.6-sol` / medium | 140.967 | 3.276.800 | 13.799 | 2.565 | 157.331 | 670,6 | — | — | test ✓ · lint ✓ · typecheck ✓ | Hayır |
| T10 | A | Codex · `gpt-5.6-sol` / medium | 95.478 | 1.573.376 | 9.545 | 1.550 | 106.573 | 270,8 | — | — | test ✓ · lint ✓ · typecheck ✓ | Hayır |

Codex `Girdi token` değeri, modelin resmi kullanım olayındaki `input_tokens - cached_input_tokens` hesabıdır; iki ham alan değiştirilmeden `benchmark_runs/raw/*.meta.json` içinde tutulur. Ham ajan akışları `benchmark_runs/raw/`, doğrulama komutları ile stdout/stderr kayıtları `benchmark_runs/validation/` altındadır. Claude Code koşumları, bu benchmark turunda Claude kullanım limitleri dolu olduğu için ertelenmiştir; limitler yenilendiğinde aynı prompt/worktree düzeniyle Kol A satırları tamamlanacaktır.

## Kör inceleme protokolü

1. A ve B yamalarından araç/kol/model bilgisini kaldır.
2. Dosya sırasını rastgeleleştir ve sonuçları `Çözüm X` / `Çözüm Y` olarak adlandır.
3. Üçüncü modele yalnızca görev, başarı kriterleri, iki yama ve doğrulama özeti ver.
4. İnceleme modelinin iki çözümden hangisinin daha iyi olduğunu veya eşit olduklarını seçmesini iste.
5. Gerekçeyi aşağıdaki boyutlarda 1–5 puanlat: doğruluk, kapsam, sadelik, bakım yapılabilirlik, regresyon riski.
6. X/Y eşlemesini inceleme tamamlandıktan sonra aç.

| Görev ID | X hangi kol | Kör tercih | Doğruluk A/B | Kapsam A/B | Sadelik A/B | Bakım A/B | Risk A/B | Review-score farkı | Gerekçe |
|---|---|---|---|---|---|---|---|---|---|---|
|  |  |  |  |  |  |  |  |  |  |  |

## Başarı eşiği

- Görevlerin en az %70'i 1.000'den az **yeni** model tokenıyla tamamlanmalı.
- Deney kolunun zorunlu doğrulama geçiş oranı taban çizgisinden düşük olmamalı.
- Kör review-score toplamı taban çizgisine eşit veya daha yüksek olmalı.
- Düşük retrieval güveninde Seviye 3'e sessiz yükseltme gerçekleşmeli.
- Çok dosyalı/belirsiz alt küme ayrıca raporlanmalı; genel ortalama bu gruptaki kalite kaybını gizlememeli.
