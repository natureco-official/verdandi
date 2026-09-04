# Retrieval kalite raporu — 2026-09-05

Dayanak: `modelcontextprotocol/typescript-sdk` @ `cc4b41617ce3601b1290d67216ea0b194a3cd9ac`
(28 Temmuz ölçümüyle aynı commit; `node benchmark_runs/setup_worktrees.mjs --commit cc4b416…`).
Seviye 3 / 1200 token. Verðandi çalışma ağacı: bu raporla aynı commit.

## Sonuç

| Ölçüm | 28 Tem (README) | 5 Eyl, düzeltme öncesi | 5 Eyl, düzeltme sonrası | Eşik |
|---|---:|---:|---:|---:|
| Birincil dosya `hit@1` | %90,00 | %80,00 | **%100,00** | ≥ %90 |
| Zorunlu dosya-grubu recall | %95,45 | %86,36 | **%90,91** | ≥ %90 |
| Kabul edilebilir dosya precision | %50,91 | %46,43 | %48,21 | ≥ %50 — **kaldı** |
| Sembol-grubu recall | %53,33 | %46,67 | **%100,00** | ≥ %85 |

Dört eşikten üçü geçiyor. Precision eşiğin 1,8 puan altında; §5'te neden
dokunulmadığı yazılı. Oracle'ın görmediği üç kapsül kusuru §6'da.

## 1. Gerileme gerçekti ve Verðandi'nin kendisindendi

README'deki 28 Temmuz sayıları, 31 Temmuz'dan sonraki sıralama değişikliklerini
görmemişti ("oracle yeniden koşulmadı" notu). Yeniden koşuldu:

- Hedef deponun 3 Eylül HEAD'i (`5119ee7`) ile `cc4b416` **görev görev aynı** sonucu
  veriyor → iki aylık kayma sıfır etki. 36 ground-truth yolunun hepsi iki commit'te de var.
- `src/context_compiler.ts`'e dokunan her commit'te oracle koşuldu (bisect):

| Commit | hit@1 | grup recall | precision | sembol recall |
|---|---:|---:|---:|---:|
| `7997415` … `e1106d1` | 90,00 | 95,45 | 50,91 | 53,33 |
| `90e7b9c` test cezası oransal (0,75) | 90,00 | 95,45 | 49,09 | 53,33 |
| `882c072` Türkçe görev → İngilizce kod | **80,00** | **90,91** | 48,21 | 53,33 |
| `9b60b44` gövde ağırlığı 0,35 → 0,8 | 80,00 | **86,36** | 46,43 | **46,67** |
| `75eba35`, `174ec4d` | 80,00 | 86,36 | 46,43 | 46,67 |

Türkçe 15-görev setinde kazanılan puanlar (README, "Tasks written in another
language") bu oracle'da kaybedilmişti; iki ölçüm hiç birlikte koşulmamıştı.

## 2. Mekanizma (tahmin değil, ayrıştırma)

Prompt'lar "Görev: … Başarı kriteri: … entegrasyon testi doğrular." biçiminde.
10 görevin 8'inde test niyeti tetikleniyordu; **5'inde (T05, T06, T07, T09, T10)
tetikleyici yalnız başarı-kriteri cümlesiydi** ve hedef üretim dosyasıydı. Niyet
açıkken test dosyaları +1,2 alıp cezadan muaf kalıyordu.

Puan ayrıştırması (T05, kazanan test başlığı vs en iyi kaynak sembolü):

| | toplam | ad | yol | imza | gövde | kapsama+exact | prior |
|---|---:|---:|---:|---:|---:|---:|---:|
| `it("a hand-built embedded request without params is a server bug …")` | 138,2 | **93,1** | 10,3 | 27,9 | 13,7 | 37,5 | 1,8 |
| `mcp.ts::setResourceRequestHandlers` (14. sıra) | 117,6 | 24,9 | 9,0 | 7,4 | 34,6 | 25,4 | 16,3 |

On beş sözcüklük bir başlık "ad" alanında (ağırlık 4,0) sekiz sorgu terimini
toplar; bir tanımlayıcı toplayamaz. `hata → error, exception, fault, bug`
genişlemesi kapsama bonusunda dört ayrı kavram sayılıyordu (4×5 puan).

## 3. Yapılanlar ve her birinin ölçülen etkisi

| Değişiklik | hit@1 | grup recall | precision | sembol recall |
|---|---:|---:|---:|---:|
| (başlangıç) | 80,00 | 86,36 | 46,43 | 46,67 |
| Test niyeti yalnız görev cümlesinden (`hasTestIntent`, `taskClause`) | 80,00 | 90,91 | 46,43 | 53,33 |
| Kapsama bonusu kaynak sözcük sayar (`queryConceptGroups`) | 80,00 | 90,91 | 47,27 | 53,33 |
| Eşleşen test → test ettiği kodu öne al (`promoteSubjectUnderTest`, en iyi import) | 90,00 | 90,91 | 48,21 | 53,33 |
| … yalnız aday ≥ tepenin %75'iyse | **100,00** | 90,91 | 48,21 | 53,33 |
| Ground-truth: 7 ölü sembol kalıbı yenilendi (aşağıda) | 100,00 | 90,91 | 48,21 | **100,00** |

Reddedilen ablasyonlar (kod değişmeden, dışarıdan simüle):
- Test başlıklarının ad alanını imza ağırlığıyla puanlamak: hit@1 8 → **6**/10
  (T04/T06 gibi cevabı test olan görevler bozuluyor).
- Test çarpanı 0,75 → 0,6: 9/10, ama T05 kaynak dosyası 7. sırada kalıyor.
- Terfi kuralları: stem eşleşmesi 9/10; en çok sembol 9/10; oran eşiği
  0,70–0,80 aralığında 10/10, 0,90'da 8/10. Terfi etmesi gereken adaylar
  0,81 / 0,85 / 0,90, etmemesi gereken (T06) 0,69. Eşik 0,75 bu aralığın
  ortası; **dört noktadan seçildi**, yeni görev setleriyle yeniden ölçülmeli.
- `dogrula → auth, factor` eşanlamlılarını kaldırmak: ölçülebilir etki yok → geri alındı.

## 4. Ground-truth yenilemesi (kanıtla)

15 sembol kalıbının 7'si sabitlenen kaynakta **hiç geçmiyordu** (grep, birincil +
kabul dosyaları); sembol recall'ın tavanı 8/15 = %53,33'tü — yani erişilebilir
olanın %100'ü zaten alınıyordu ve kapı her koşuda düşerek hiçbir şey ölçmüyordu.

| Görev | Ölü kalıp | cc4b416'daki karşılığı |
|---|---|---|
| T03 | `(signalProcessGroup\|stopProcessGroup)` | `killWranglerTree` (cloudflareWorkers.test.ts:130) |
| T06 | `trimHeaderOws` | `stripHttpOws` (inboundClassification.ts:468) |
| T06 | `OWS around standard header` | `RFC 9110 OWS\|OWS is stripped` (test başlıkları :160, :175, :196) |
| T07 | `stale session ID` | `session ID` (streamableHttp.test.ts :90–:226) |
| T09 | `serializeProtocolDocument` | `encodeCacheValue` (responseCache.ts:696) |
| T09 | `cache codec round-trips` | `round-trip` (responseCache.test.ts:34) |
| T10 | `keep-alive comments` | `keep-alive comment frames\|keepAlive` (perRequestStreaming.test.ts:264) |

Oracle artık her kalıbı birincil/kabul dosyalarının metninde arar; hiç
geçmeyen kalıbı `deadPatterns` olarak yazar ve **"ground truth stale"** diye ayrı
gerekçeyle düşer. Kapı bir daha sessizce çürüyemez.

## 5. Precision'a neden dokunulmadı

27 kabul / 56 dönen. Gürültü ile kabul edilen dosyalar ham puanda iç içe
(T05: ✗138 ★137 … ★117) — doğal bir boşluk yok, göreli kesme kanıtsız olurdu.
T08'de dönen dört kardeş `tsdown.config.ts` (core/client/server/server-legacy),
raporun kendi tanımına göre ("göreve kabul edilebilir kanıt") kabul edilebilir
görünüyor; sayılsa precision %55 olur. Bu bir etiketçi kararıdır, ölçümü geçirmek
için tek taraflı verilmedi.

Yan bulgu: modele giden `score`, `x/(x+10)` ile normalize ediliyor; 117–250 arası
ham puanların hepsi 0,92–0,96'ya yapışıyor. Alan bilgi taşımıyor. Ayrı iş.

## 6. Kapsülün kendisi (oracle'ın ölçmediği üç kusur, aynı gün kapatıldı)

| Kusur | Kanıt | Düzeltme | Doğrulama |
|---|---|---|---|
| İngilizce göreve Türkçe karar/kriter/uyarı metni | Ekipman360 EN sorgusu: `retrieval_weak: "zayıf eşleşme, doğrula"`, üç Türkçe karar | `taskLanguage` (diakritik ya da ≥2 Türkçe işlev sözcüğü) + iki dilli `METIN` tablosu; gerekçeler dahil | Test: EN kapsül JSON'unda tek Türkçe harf yok; TR kapsül Türkçe kalır |
| `score` bilgi taşımıyor | x/(x+10): 117–250 ham puan → 0,92–0,99; kabul ile gürültü aynı | Kapsül içi en iyi sözcüksel eşleşmeye oran (1,00 = en iyi); anlamsal adaylar kosinüs ölçeğinde | Ekipman360 EN: 0,893-dümdüz → 0,99 / 0,98 / 0,95 / 0,91 / 0,89 |
| Seviye-1'de tek sembol | 250 token'ın ~200'ü kalıp metin; kod önce SEMBOL atıyordu | Sıra: uzun test başlığı kısalt (96) → algoritma kararı → fazla kriter → en son sembol | Test: uzun başlıklı fixture'da ≥2 sembol, ≤250 token; Ekipman360 TR: 1 → 2 sembol, 219 token |

Oracle bu değişikliklerden sonra birebir aynı (100 / 90,91 / 48,21 / 100): seviye 3 /
1200 token'da kırpma ve dil devreye girmiyor — beklenen.

## Yeniden üretmek

```bash
node benchmark_runs/setup_worktrees.mjs --commit cc4b41617ce3601b1290d67216ea0b194a3cd9ac
CAPSULE_WORKTREE_BASE="<çıktıda yazan yol>" npm run benchmark:retrieval
```

## Sınırlar

- On görev, tek etiketleyici. 0,75 eşiği dört gözlemden.
- Türkçe 15-görev seti (README) bu düzeltmelerden sonra **yeniden koşulmadı**;
  o set özel bir projede ve burada yeniden üretilemiyor. İki oracle birlikte
  koşulmadan sıralamaya bir daha dokunulmamalı.
