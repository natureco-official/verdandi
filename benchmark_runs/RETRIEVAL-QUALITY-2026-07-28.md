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

---

## Bağımsız yeniden çalıştırma — 28 Temmuz 2026, Windows

Yukarıdaki sonuçlar sabitlenen commit'lerle alınmıştı. O commit'ler depoda
kayıtlı olmadığı için ölçüm **birebir yeniden üretilemedi**. Bunun yerine
`modelcontextprotocol/typescript-sdk` deposunun güncel HEAD'i
(`cc4b41617ce3601b1290d67216ea0b194a3cd9ac`) ile çalıştırıldı:

| Ölçüm | İlk rapor | Güncel HEAD | Eşik | Durum |
|---|---:|---:|---:|:--|
| Birincil dosya `hit@1` | %100 | %90,00 | ≥ %90 | geçti |
| Zorunlu dosya-grubu recall | %100 | %95,45 | ≥ %90 | geçti |
| Kabul edilebilir dosya precision | %60,78 | %50,91 | ≥ %50 | geçti |
| Sembol-grubu recall | %100 | %53,33 | ≥ %85 | **kaldı** |

Sembol recall'daki düşüş retrieval gerilemesi DEĞİL. Beklenen sembollerden
dördü güncel depoda hiç bulunmuyor:

- `signalProcessGroup`, `stopProcessGroup` (T03)
- `trimHeaderOws` (T06)
- `serializeProtocolDocument` (T09)

Dosyalar duruyor, semboller yeniden adlandırılmış ya da kaldırılmış. Var olmayan
bir sembol bulunamaz; ölçüm bu yüzden düşüyor.

### Çıkan ders

Yayınlanan sayılar, dayandıkları kaynak sürümü kayıtlı olmadığı için
doğrulanamaz durumdaydı. Oracle artık her koşumda `baseCommit` ve `measuredAt`
alanlarını yazıyor (schemaVersion 2). Sabitlenen commit'ler bulunursa
`CAPSULE_WORKTREE_BASE` ile o worktree'ler gösterilerek ilk sonuçlar
doğrulanabilir.
