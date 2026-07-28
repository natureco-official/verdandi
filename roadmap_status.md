# Verðandi Context Compiler — Yol Haritası Durumu

**Durum tarihi:** 28.07.2026  
**Aşama:** Güvenlik ve süreç dayanıklılığı sertleştirilmiş TypeScript MVP çekirdeği ve legacy/2026 stdio MCP adaptörü
**Genel durum:** Beş araç, crash-safe atomik patch/rollback, model-metadata sınırı, sınırlı stdio/LLM I/O, bağımsız adversarial test paketi ve resmî MCP TypeScript istemci uyumluluk kapısı hazır.

| MVP adımı | Durum | Not |
|---|---|---|
| 1. 30–50 gerçek görevlik benchmark seti | Devam ediyor | Resmi `modelcontextprotocol/typescript-sdk` deposundan gerçek commit çiftleriyle T01–T10 dolduruldu. T11–T40 bekliyor. |
| 2. Codex/Claude Code taban ölçümleri | Devam ediyor | Codex T01–T10 çiftleri mevcut; Claude Code ve daha geniş tekrar örneklemi bekliyor. Sonuçlar henüz genellenebilir değil. |
| 3. TypeScript/JS sembol indeksi | İlk MVP hazır | TypeScript compiler API ile `.ts/.tsx/.mts/.cts/.js/.jsx/.mjs/.cjs` AST sembolleri, relative import ve çağrı ilişkileri taranıyor; 1-hop komşular ve derin tipler okunabiliyor. |
| 4. Beş MCP aracı | Tamamlandı (MVP) | Beş araç hazır; `@modelcontextprotocol/client@2.0.0` ile legacy initialize ve 2026-07-28 discovery/list/call/error/close akışları doğrulandı. |
| 5. Benchmark'ı context compiler ile tekrar çalıştırma | T01–T10 tamamlandı | On Codex/Capsule çifti mevcut. T04 üç tekrarlı izole oracle ile; T02/T03 exact baseline-diagnostic imzasıyla; T08 declaration/public-import oracle'sıyla yeniden doğrulandı. |
| 6. Token ve kör review-score karşılaştırması | Devam ediyor | İlk ölçüm hit@1 %100, dosya-grubu recall %100, precision %60,78, sembol recall %100 vermişti — ancak bu sayılar **yeniden üretilemiyor**: dayandıkları sabitlenen commit'ler hiçbir yerde kayıtlı değil ve aranıp bulunamadı. 28.07.2026'da güncel HEAD (`cc4b416`) ile alınan bağımsız ölçüm: hit@1 %90,00 · dosya-grubu recall %95,45 · precision %50,91 · sembol recall %53,33. Sembol düşüşü retrieval gerilemesi DEĞİL — beklenen dört sembol depoda artık yok. Ayrıntı: `benchmark_runs/RETRIEVAL-QUALITY-2026-07-28.md`. Bağımsız kör çözüm skoru hâlâ bekliyor. |
| 7. Rust/Python ve diğer dillere genişletme | Bekliyor | TypeScript sonuçları başarı eşiğini geçerse başlanacak. |

## Tamamlanan tasarım kararları

- Model görünür görev kapsülü için normal bütçede 200–300 token hedefi, Seviye 3 escalation için daha geniş fakat sınırlı bütçe belirlendi.
- Retrieval güveni `0.72` altında olduğunda görev kullanıcıya/model çıktısına yansıtılmadan Seviye 3'e yükseltilecek.
- MCP wire trafiği `snake_case`, TypeScript domain modeli `camelCase` kullanacak; iki yönlü dönüşüm tek `mapContextCapsule` sınır fonksiyonunda yapılacak.
- Varsayılan `maxEscalationAttempts` değeri 3 olacak. Sayaç sınıra ulaştığında yeni retrieval/escalation çalıştırılmadan görev insana devredilecek.
- İlgili sembol seçimi doğrudan eşleşmelerle sınırlı olmayacak; çağrı grafiğinin 1-hop komşuları da kapsüle alınacak.
- Yapısal yamalarda stale-index ve yanlış sembol riskine karşı içerik hash'i önkoşulları kullanılacak.
- Doğrulama çıktıları tam log yerine kompakt hata farkı olarak modele sunulacak.
- Kalite, test geçişi ile birlikte üçüncü modelin kör karşılaştırma puanıyla ölçülecek.
- Çekirdek Cupertino Terminal'den bağımsız olacak; Codex ve Claude Code ayrı adaptörlerle aynı MCP çekirdeğini kullanacak.
- Verðandi yalnızca görev bağlamı için kullanılacak; kalıcı karar belleği Urðr'a ait olacak ve ham oturum geçmişi veya büyük kod parçaları saklanmayacak.
- `Toplam yeni token`, cache okumasını hariç tutan `fresh input + output + reasoning` toplamıdır; cache-read tokenları gerçek context boyutunu gizlememesi için ayrı raporlanır.

## Oluşturulan başlangıç çıktıları

- `context_capsule_schema.json`: kapsül ve adaptör-only kontrol verisi JSON şeması.
- `mcp_tools.ts`: beş MCP aracının transport-neutral TypeScript sözleşmeleri.
- `benchmark_template.md`: görev dağılımı, koşum kaydı ve kör review-score protokolü.
- `roadmap_status.md`: bu durum belgesi.
- `src/context_compiler.ts`: AST indeksleme, retrieval, güvenli yapısal yama ve doğrulama implementasyonu.
- `src/mcp_server.ts`: stdio JSON-RPC MCP sunucusu.
- `mcp-config.json`: Codex MCP sunucu tanımı.
- `smoke_test.mjs`: araçların tekrarlanabilir canlı smoke testi.
- `__tests__/independent_adversarial.test.ts`: eski testlerden bağımsız atomiklik, symlink, stale-cache, MCP sınırı ve ajan rollback testleri.
- `__tests__/official_mcp_client.test.ts`: resmî TypeScript istemcisiyle legacy/modern stdio çapraz uyumluluk testi.

## Sıradaki somut adım

T11–T40 görevlerini aynı izole protokolle eklemek; çoklu tekrar, ikinci etiketleyiciyle retrieval ölçümü ve bağımsız kör review-score raporlamak.
