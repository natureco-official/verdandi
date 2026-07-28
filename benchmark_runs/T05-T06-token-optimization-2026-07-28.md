# T05–T06 token optimizasyonu — 2026-07-28

## Kapsam ve yöntem

- Kontrol grubu: 27 Temmuz 2026 tarihli, `gpt-5.6-sol` / medium effort standart Codex koşumları.
- Deney grubu: aynı başlangıç commit'lerindeki temiz `T05-codex-capsule` ve `T06-codex-capsule` worktree'leri.
- T05 ve T06 için daha önce Capsule koşumu bulunmadığından karşılaştırma “önceki standart Codex → optimize edilmiş Capsule” şeklindedir.
- Başarısız olan ilk T05 başlatması macOS sandbox'ında 243 ms içinde, token üretmeden kapandı; ölçümlere dahil edilmedi.
- Önceki ham izler `/private/tmp/capsule-t05-t06-before-token-fix-20260728` altında arşivlendi.

## Kök neden

Token artışının ana kaynağı MCP yanıtı değil, geniş terminal çıktılarının sonraki model turlarında tekrar taşınmasıydı.

- T05'in ilk depo-geneli `rg` araması 102.427 karakter çıktı verdi.
- T06'nın ilk depo-geneli `rg` araması 703.926 karakter çıktı verdi.
- T05 toplam 16, T06 toplam 15 terminal çağrısı yaptı.
- T05 sorgusunda `InvalidParamsError` gibi üretilmiş protokol tipleri gerçek `setResourceRequestHandlers` uygulamasının önüne geçiyordu.

## Uygulanan düzeltmeler

- URI görevleri için `url`, `resource`, `read`; Türkçe `çözüm*` kökü için `resolve`, `parse`, `match` kavram genişletmesi eklendi.
- Birden fazla bağımsız görev kavramını birlikte karşılayan sembollere kapsam puanı eklendi.
- Runtime server/client görevlerinde üretilmiş protokol aynaları uygulama dosyalarının gerisine alındı.
- Dosya adı ve yol eşleşmelerinin yönlendirme ağırlığı artırıldı.
- T05 artık `packages/server/src/server/mcp.ts`; T06 `mcpParamHeaders.ts` / `inboundClassification.ts` ile açılıyor.
- Benchmark talimatlarındaki tek Capsule çağrısı, en fazla iki sembol okuma, en fazla sekiz terminal çağrısı ve sınırlı çıktı kuralları korundu.

## Sonuçlar

| Görev | Ölçüm | Standart Codex | Optimize Capsule | Değişim |
|---|---|---:|---:|---:|
| T05 | Süre | 141.138 ms | 122.560 ms | -%13,2 |
| T05 | Input token | 678.465 | 284.876 | **-%58,0** |
| T05 | Output token | 3.843 | 3.585 | -%6,7 |
| T06 | Süre | 159.323 ms | 144.842 ms | -%9,1 |
| T06 | Input token | 838.150 | 393.572 | **-%53,0** |
| T06 | Output token | 5.208 | 4.427 | -%15,0 |
| Toplam | Süre | 300.461 ms | 267.402 ms | **-%11,0** |
| Toplam | Input token | 1.516.615 | 678.448 | **-%55,3** |
| Toplam | Uncached input | 110.151 | 92.208 | -%16,3 |
| Toplam | Output token | 9.051 | 8.012 | -%11,5 |

Reasoning output T05'te 761'den 1.036'ya yükseldi; T06'da 1.209'dan 1.093'e düştü. Toplam reasoning output %8,1 arttı, ancak toplam output ve input maliyeti belirgin biçimde azaldı.

## İz ekonomisi

| Görev | Terminal çağrısı | Terminal çıktı karakteri | En büyük tek çıktı |
|---|---:|---:|---:|
| T05 önce | 16 | 158.759 | 102.427 |
| T05 sonra | 7 | 61.816 | 32.216 |
| T06 önce | 15 | 802.198 | 703.926 |
| T06 sonra | 8 | 82.547 | 28.451 |

Toplam terminal çağrısı 31'den 15'e, terminal çıktı hacmi 960.957 karakterden 144.363 karaktere düştü.

## Kalite doğrulaması

- Capsule projesi: lint/typecheck başarılı; 82/82 test başarılı.
- T05 validator: hedef entegrasyon testi, server lint ve server typecheck başarılı.
- T05 değişmiş `mcp.compat.test.ts`: 9/9 başarılı.
- T05 davranışı: malformed URI `InvalidParams`; geçerli resource okuması başarılı.
- T06 validator: iki hedef test dosyası, core-internal lint ve typecheck başarılı; toplam 70/70 hedef test başarılı.
- T06 değişmiş `standardHeaderValidation.test.ts`: 19/19 başarılı.
- T06 davranışı: baştaki/sondaki SP ve HTAB kabul ediliyor; iç whitespace reddediliyor.
- Her iki worktree'de `git diff --check` başarılı ve hedef dışı dosya değişikliği yok.

