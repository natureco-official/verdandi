# Resmî MCP istemci çapraz uyumluluk raporu — 2026-07-28

## Sonuç

Verðandi stdio sunucusu, sabitlenmiş `@modelcontextprotocol/client@2.0.0` ile gerçek alt süreç üzerinden doğrulandı. Hem legacy initialize akışı hem de 2026-07-28 `server/discover` akışı; araç listeleme, araç çağırma, tipli protokol hatası ve temiz kapanış senaryolarında geçiyor.

## Bulunan ve düzeltilen uyumsuzluklar

1. Sunucu `server/discover` uygulamadığı için resmî istemci modern akıştan legacy akışına düşüyordu.
2. Modern başarılı sonuçlarda zorunlu `resultType: "complete"` alanı yoktu.
3. Modern `tools/list` sonucunda zorunlu `ttlMs` ve `cacheScope` alanları yoktu.
4. Başarılı sonuçlarda önerilen `io.modelcontextprotocol/serverInfo` metadata'sı tutarlı değildi.
5. Legacy initialize, desteklenmeyen istemci sürümünü aynen yankılıyordu; artık desteklenen en güncel legacy sürüme iner.
6. Desteklenmeyen modern protokol zarfları artık `-32022` ve desteklenen sürüm bilgisiyle reddedilir.

Modern alanlar yalnız 2026-07-28 istek zarfı görüldüğünde üretilir; legacy cevap biçimi korunur.

## Doğrulama

| Kontrol | Sonuç |
|---|---:|
| Resmî istemci legacy connect/ping/list/call | PASS |
| Resmî istemci modern auto-discovery/list/call | PASS |
| Legacy ve modern tipli `-32602` araç hatası | PASS |
| Her bağlantıda temiz stdio kapanışı | PASS |
| Doğrudan discovery/result-envelope oracle'ları | PASS |
| Yerel tam paket | 105/105 PASS (sonraki retrieval regresyonu dahil) |
| İzole `npm ci` sonrası tam paket | 105/105 PASS |
| Typecheck + statik güvenlik lint'i | PASS |
| `npm audit --audit-level=high` | 0 bilinen açık |

Bu matris stdio ve resmî TypeScript istemcisini kanıtlar. Streamable HTTP/SSE taşıyıcıları bu sunucunun mevcut kapsamı değildir.
