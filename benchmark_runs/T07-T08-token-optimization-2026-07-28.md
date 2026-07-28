# T07–T08 token optimizasyonu — 2026-07-28

## Kapsam ve yöntem

- Kontrol grubu: 27 Temmuz 2026 tarihli `gpt-5.6-sol`, medium effort standart Codex koşumları.
- Deney grubu: aynı başlangıç commit'lerindeki temiz `T07-codex-capsule` ve `T08-codex-capsule` worktree'leri.
- T07 ve T08 için önceden Capsule koşumu bulunmadığından karşılaştırma standart Codex → optimize edilmiş Capsule şeklindedir.
- Önceki ham izler `/private/tmp/capsule-t07-t08-before-token-fix-20260728` altında arşivlendi.

## Kök neden

- T07'nin ilk depo-geneli araması 197.372 karakter çıktı verdi ve yanlış server initialize dosyalarını taradı.
- T08 29 terminal çağrısı yaptı; dört build ve declaration incelemesini birleştiren tek komut 564.061 karakter çıktı üretti.
- `session id` görevi client/transport/header kavramlarına genişletilmiyordu.
- `tsdown.config.ts` TypeScript kaynağı olarak indeksleniyor, fakat build config deseni olarak tanınmadığı için config önceliğini alamıyordu.

## Uygulanan düzeltmeler

- `session` için `transport`, `http`, `client`, `header`; Türkçe `gönder*` için `send`, `request`; `yanıt*` için `response` kavramları eklendi.
- Declaration/dts/bundle/OOM görevleri `build`, `config`, `external`, `tsdown` ve memory kavramlarına bağlandı.
- Genel `*.config.ts/mts/cts/js/mjs/cjs` build config deseni eklendi.
- T07 retrieval'ı doğrudan `packages/client/src/client/streamableHttp.ts` ile açılıyor.
- T08'in ilk dört sonucu Express/Fastify/Hono/Node `tsdown.config.ts` dosyaları.
- Bu davranışlar için iki yeni regresyon testi eklendi.

## Sonuçlar

| Görev | Ölçüm | Standart Codex | Optimize Capsule | Değişim |
|---|---|---:|---:|---:|
| T07 | Süre | 123.407 ms | 169.162 ms | **+%37,1** |
| T07 | Input token | 632.596 | 451.486 | **-%28,6** |
| T07 | Output token | 4.024 | 5.238 | +%30,2 |
| T07 | Reasoning output | 1.011 | 1.775 | +%75,6 |
| T08 | Süre | 441.282 ms | 139.707 ms | **-%68,3** |
| T08 | Input token | 2.224.703 | 284.683 | **-%87,2** |
| T08 | Output token | 10.637 | 4.178 | -%60,7 |
| T08 | Reasoning output | 3.667 | 1.337 | -%63,5 |
| Toplam | Süre | 564.689 ms | 308.869 ms | **-%45,3** |
| Toplam | Input token | 2.857.299 | 736.169 | **-%74,2** |
| Toplam | Uncached input | 230.995 | 116.137 | -%49,7 |
| Toplam | Output token | 14.661 | 9.416 | -%35,8 |
| Toplam | Reasoning output | 4.678 | 3.112 | -%33,5 |

T07 input maliyeti azalsa da süre/output/reasoning geriledi. Bunun nedeni bir mock düzeltmesi ve yeniden-initialize kenarının ikinci turda kapatılmasıydı. Sonuç kalite olarak geçerli, fakat T07 tek başına bütün performans eksenlerinde kazanç değildir.

## İz ekonomisi

| Görev | Terminal çağrısı | Terminal çıktı karakteri | En büyük tek çıktı |
|---|---:|---:|---:|
| T07 önce | 9 | 283.347 | 197.372 |
| T07 sonra | 8 | 94.464 | 44.770 |
| T08 önce | 29 | 739.452 | 564.061 |
| T08 sonra | 6 | 49.087 | 20.940 |

Toplam terminal çağrısı 38'den 14'e; terminal çıktı hacmi 1.022.799 karakterden 143.551 karaktere düştü.

## Kalite doğrulaması

### Capsule

- Lint/typecheck başarılı.
- 84/84 test başarılı.

### T07

- Client `streamableHttp.test.ts`: 67/67 başarılı.
- Client lint ve typecheck başarılı.
- Initialize isteği eski session header'ını taşımıyor.
- Session yalnız başarılı initialize yanıtından yakalanıyor.
- Initialize dışı yanıtlar session'ı değiştirmiyor; yeni session sonraki istekte kullanılıyor.
- `git diff --check` başarılı; yalnız hedef kaynak ve test dosyası değişti.

### T08

- Dört middleware lint, typecheck ve declaration build başarılı.
- Declaration dosyaları toplam 19.940 bayt; workspace type graph gömülmedi.
- Public `@modelcontextprotocol/server` ve `@modelcontextprotocol/core` importları declaration yüzeyinde korunuyor.
- Dört yayımlanmış `.d.mts` dosyası birlikte `tsc --noEmit` ile başarıyla çözümlendi.
- Express 29/29, Fastify 16/16 ve Hono 7/7 test başarılı.
- Node paketindeki 74 testin aynı iki SSE/zamanlama testi hem standart kontrol validatorında hem Capsule worktree'de başarısız. Değişiklikler yalnız build config dosyalarında olduğundan bu yeni regresyon değil, mevcut taban hatasıdır.
- `git diff --check` başarılı; yalnız dört hedef `tsdown.config.ts` değişti.

### Post-hardening T08 oracle

The old middleware-wide runtime test gate mixed declaration quality with unrelated network/timing failures. It has been replaced by a task-specific gate: build all four packages, require bounded non-empty declarations, reject workspace source paths and private `@modelcontextprotocol/core` imports, and require every public bare import to be declared in dependencies or peerDependencies.

This oracle found a real Capsule defect hidden by the old checks: the Node declaration exposed private `@modelcontextprotocol/core`. The Node source now imports its public types through `@modelcontextprotocol/server`. Both worktrees pass build, declaration oracle, lint, and typecheck. This post-run correction is not included in the original token measurement.
