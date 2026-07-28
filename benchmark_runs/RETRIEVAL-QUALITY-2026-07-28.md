# Retrieval kalite raporu — 2026-07-28

## Sonuç

T01–T10 gerçek MCP TypeScript SDK görevleri için manuel etiketli dosya grupları ve sembol örüntüleri eklendi. Oracle, her görevi aynı Seviye 3 / 1200-token üst sınırında gerçek benchmark worktree'sine karşı yeniden çalıştırır ve eşik altı sonuçta non-zero çıkar.

| Ölçüm | Sonuç | Eşik |
|---|---:|---:|
| Birincil dosya `hit@1` | %100 | ≥ %90 |
| Zorunlu dosya-grubu recall | %100 | ≥ %90 |
| Kabul edilebilir dosya precision | %60,78 | ≥ %50 |
| Sembol-grubu recall | %100 | ≥ %85 |

## Bulunan hata ve düzeltme

İlk ölçümde T04'ün doğru regresyon test dosyaları retrieval sonucunda yoktu. Neden, indeksleyicinin yalnız bildirimleri sembol kabul etmesi; iç içe `it(...)` ve `test(...)` bloklarının başlık ve gövdelerini indekslememesiydi.

İndeksleyici artık doğrudan, `.only/.skip` ve `.each` biçimlerindeki test çağrılarını `test` sembolü olarak çıkarır. Böylece T04'te 401/refresh/retry davranışını adlandıran testler ilk sonuçlara yükseldi. Bu davranış küçük, bağımsız bir fixture ile ana `npm test`/CI kapısına bağlıdır.

## Çalıştırma

```bash
npm run benchmark:retrieval
```

Varsayılan worktree kökü `/private/tmp/capsule-baseline-worktrees`'dir; başka konum için `CAPSULE_WORKTREE_BASE` kullanılabilir.

## Sınırlar

- Etiketler on göreve dayanır ve manuel olarak semantik açıdan kabul edilebilir alternatifleri içerir.
- Precision, dönen her dosyanın zorunlu edit dosyası olmasını değil, göreve kabul edilebilir kanıt olmasını ölçer.
- Gerçek T01–T10 oracle'sı büyük dış worktree'lere ihtiyaç duyduğu için CI'da yeniden kurulmaz; yapısal `it/test` regresyonu CI'daki ana pakette çalışır.
- Genellenebilir kalite için T11–T40, bağımsız ikinci etiketleyici ve kör çözüm kalitesi değerlendirmesi hâlâ gerekir.
