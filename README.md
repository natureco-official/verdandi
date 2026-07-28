# Verðandi Context Compiler

Verðandi, AI coding agent'ları için TypeScript AST tabanlı görev bağlamı derleyicisidir. Geniş kod tabanlarından görevle ilgili sembolleri seçer, sınırlı kaynak dilimleri sağlar ve isteğe bağlı güvenli sembol yamaları uygular.

## Başlangıç

```bash
npm install
npm run build
npm test
./run_with_capsule.sh codex /path/to/project "Görevi yaz"
```

`npm test` tam birim, entegrasyon, benchmark-koşucu ve bağımsız adversarial güvenlik paketini çalıştırır. Test sayısı geliştikçe değiştiğinden başarı ölçütü komutun sıfır çıkış kodu ve rapordaki sıfır başarısız testtir. `benchmark_test.mjs` yalnızca bu depodaki seçilmiş dosyalarla sentetik bağlam hacmini ölçer; uçtan uca ajan token maliyetini veya kalite eşdeğerliğini kanıtlamaz.

## Çalışma Modları

### Auto-inject

`run_with_capsule.sh`, kapsülü ve seçilen kaynak dilimlerini desteklenen ajanın prompt'una ekler:

```bash
./run_with_capsule.sh <agent> <project-root> "Görev"
```

Desteklenen ajanlar: `natureco`, `hermes`, `codex`, `claude`, `opencode`, `openclaw`, `kimi`, `glm`.

### MCP sunucusu

```bash
node bin/verdandi-context-compiler setup codex
node bin/verdandi-context-compiler status
```

`setup` ilgili ajan için çalıştırılacak kayıt komutunu gösterir. MCP sunucusunu doğrudan başlatmak için `npm start` kullanın.

Stdio protokol sınırı, sabitlenmiş resmî `@modelcontextprotocol/client@2.0.0` ile hem legacy initialize hem de 2026-07-28 `server/discover` akışında sürekli test edilir.

Araçlar:

- `context_capsule`: Görev için sembol ve dosya seçer.
- `read_symbol`: Sembolün kaynak kanıtını ve karmalarını döndürür.
- `apply_structured_patch`: Snapshot ve içerik önkoşullarıyla yama uygular.
- `rollback_patch`: Sadece proje içindeki, yama sonrasında değişmemiş dosyaları geri alır.
- `validate_delta`: Yalnızca çağıran `commandProfile: "package-scripts"` ile açıkça izin verdiğinde proje scriptlerini çalıştırır.

### Bağımsız ajan

```bash
verdandi-agent "Import sıralamasını düzelt" --project ./project --model gpt-4o --api-key "$VERDANDI_API_KEY"
```

Ortam değişkenleri: `VERDANDI_API_KEY`, `VERDANDI_MODEL`, `VERDANDI_BASE_URL`, `VERDANDI_REQUEST_TIMEOUT_MS`, `VERDANDI_CODEX_MODEL`. Eski `URDR_*` değişkenleri geriye uyumluluk için desteklenir.

## Güvenlik ve Sınırlar

- Yamalar kaynak snapshot'ı ve dosya/sembol karmalarını doğrular; eşzamanlı değişen veya proje dışına çözümlenen yolları reddeder.
- Bağımsız ajan çok dosyalı editleri tek atomik patch olarak uygular; hazırlama veya doğrulama hatasında tüm patch geri alınır.
- Rollback kayıtları yalnızca göreli dosya yollarını saklar ve kullanıcının sonradan değiştirdiği dosyaları ezmez.
- Model editleri allowlist ile doğrulanır; eksik, bilinmeyen veya kesilmiş edit dizileri kısmen uygulanmaz.
- Düşük retrieval confidence Seviye 3 bütçesini gerçekten genişletir; kontrol metadata'sı MCP model içeriğinden ayrı tutulur.
- `validate_delta` paket scriptlerini çalıştırabildiğinden güvenilmeyen projelerde yalnızca açık kullanıcı onayıyla çağrılmalıdır.

## Geliştirme

```bash
npm run typecheck
npm run lint
npm test
node smoke_test.mjs
node benchmark_test.mjs
npm run benchmark:retrieval # T01–T10 worktree'leri mevcutsa
```

GitHub Actions kalite matrisi aynı kapıları Ubuntu ve macOS üzerinde Node 20, 22 ve 24 ile çalıştırır; action sürümleri immutable commit SHA'larına sabitlenmiştir.

Mimari ayrıntıları ve ajan bazlı komutlar için `UNIVERSAL.md` ve `integrations/` dizinine bakın.
