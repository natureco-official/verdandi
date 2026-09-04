# Kayıpsız kanıt erişimi ve Urðr bağlantısı

Bu sürüm kaynağa erişimi ve dahili ajanın bağlam bütçesini geliştirir. Bütün görevleri binlerce tokenla, sıfır kalite kaybıyla çözme hedefi henüz uçtan uca kanıtlanmış değildir.

## Kod okuma

Eski `read_symbol` API'si uyumluluk için korunur; büyük sembolleri başlangıçtan kırpabilir. Yeni akış:

```json
{"projectRoot":"/project","file":"src/invoice.ts","symbol":"invoiceTotal","maxTokens":1000}
```

Bu argümanları `read_evidence` aracına verin. Yanıt `ref`, `source`, `offset`, `nextOffset`, `totalChars`, `done`, `hash`, `snapshot`, `kind`, `encoding` ve `tokenCount` taşır. `symbol` verilmezse dosyanın tamamı sayfalanır. İzin verilen dosyalar derleyicinin proje içinde indekslediği dosyalardır.

Devamı:

```json
{"projectRoot":"/project","ref":"ev_<64-hex>","offset":1234,"maxTokens":1000}
```

`offset` önceki yanıtın `nextOffset` değeridir. UTF-16 metin konumudur; satır numarası değildir. Sembol seçildiyse sembolün başına göredir. JSON içindeki kaçışlanmış kaynak satırları bir bütün olarak alınmaz; bütçe kaynak içeriğini güvenli Unicode sınırlarından böler. `source` parçaları sırayla birleştirildiğinde tam kaynak elde edilir.

`maxTokens` 300–4000 aralığındadır ve **JSON kanıt yükünün tamamını** `cl100k_base` tokenizer ile sınırlar. İstemcinin dış MCP zarfı, kendi sistem talimatları ve farklı model tokenizasyonu bu sayıya dahil değildir. Çok uzun dosya adı gibi yalnız metadata ile bütçeyi aşan durumlarda sessiz taşma yerine açık hata döner.

Kaynak değişse veya sunucu yeniden başlasa da eski referans eski kanıtı döndürür. Güncel kaynak için yeniden `file`/`symbol` ile çağrı yapılır. `knownRef` yalnız tam kanıt hâlâ mevcut model bağlamındaysa gönderilir; bağlam sıkıştırması sonrasında gönderilmez. Bu, sunucunun hatırlamasını modelin hatırlamasıyla karıştırmaz.

## Değişen kısmı okuma

```json
{"projectRoot":"/project","file":"src/invoice.ts","previousRef":"ev_<old-source-ref>","maxTokens":1000}
```

Bu çağrı `kind: "delta"` sayfaları döndürür. `source` parçalarını birleştirip JSON olarak ayrıştırın. İçeride `baseRef`, `targetRef`, `baseHash`, `targetHash`, `offset`, `deleteChars` ve `insert` bulunur. Aynı dosya/sembolün kaynak referansı gerekir; başka projenin referansı kabul edilmez. `applyEvidenceDelta` önce eski içerik hash'ini, sonra yeniden oluşturulan hedef hash'ini doğrular. Ortadaki büyük değişiklik özetlenmez; aynen sayfalanır.

## Dahili ajan

```sh
node bin/verdandi-agent "Görev" --project /project \
  --max-prompt-tokens 8000 --max-total-tokens 16000 --max-output-tokens 2000
```

- Başlangıçta dosya ve görevle ilgili sembol sayfaları alınır. Model `needs_more_context` ile dosya veya sembolün devamını isteyebilir; belirli konuma dönüş için `offset` verebilir.
- Her istek yeniden oluşturulur; sistem, görev, bellek, kod ve yeniden deneme metni birlikte sayılır. Bütçe gerektiğinde eski kaynak sayfaları etkin bağlamdan çıkarılır; aynı referans veya dosya/sembol konumuyla geri alınabilirler.
- Tam sembol değiştirme işlemi, sembolün tamamı etkin bağlamda değilse reddedilir. Modelin görmediği kuyruk kısmının kazara silinmesine izin verilmez. Sembol bütçeye sığmıyorsa görev tamamlanmış sayılmaz.
- Modelin gördüğü snapshot sonrasında proje değiştiyse eski öneri güncel kodun üzerine uygulanmaz.
- `max-total-tokens` yerel rezervasyon bütçesidir. Her isteğin girdisi ve cevap payı dikkate alınır; ağ hatasında bilinmeyen çıktı payı da rezerve edilir. Sağlayıcı/model farklarından dolayı evrensel bir faturalama üst sınırı değildir.
- `usage.requests` sağlayıcı sayacı ile yerel tahmini ayırır. Cache okuması ayrıca gösterilir; OpenAI uyumlu cevapta zaten prompt toplamının içindeyse tekrar eklenmez.
- `completionEvidence: project-checks`, proje kontrollerinin geçtiğini söyler. `task-verifier`, host tarafından verilen `taskVerifier` fonksiyonunun da davranışı doğruladığını söyler. Boş değişiklik listesi yalnız typecheck ile başarı sayılmaz; bağımsız doğrulayıcı gerekir. Dry-run sonucu `proposal` olarak etiketlenir.

Üçüncü taraf MCP istemcilerinin eski mesajlarını bu sunucu silemez. Etkin bağlamı yeniden oluşturma davranışı dahili ajan için uygulanmıştır; diğer istemciler yeni sayfalama aracını kullanabilir ancak geçmiş bağlamlarını kendileri yönetmelidir.

## Urðr: isteğe bağlı, açık proje bağlantısı

```sh
node bin/verdandi-agent "invoice" --project /project \
  --urdr-server /path/to/urdr/scripts/mcp-server.mjs \
  --memory-root /project-memory
```

Bellek kendiliğinden keşfedilmez veya oluşturulmaz. Verilen bellek klasörünün bu proje için uygun olması kullanıcının tercihidir. `urdr_context → urdr_search → urdr_read` ile en çok üç ilgili yaprak seçilir ve bellek damgası yeniden kontrol edilir. Tam yaprak bütçeye sığmıyorsa kesilerek karar gibi verilmez; atlandığı sayılır. Büyük spool yanıtı için tehlikeli sınırsız JSON satırı fetch'i yapılmaz; bellek kullanılamadığı bildirilir.

Bağlantı sadece okuma araçlarını çağırır; Urðr kendi türetilmiş pack/spool önbelleklerini güncelleyebilir. Yaprak ekleme veya değiştirme çağrısı yoktur. Tarihsel bellek modele kanıt olarak sunulur; güncel kodun yerine geçmez. Başlangıç bellek seçimi tek seferliktir; modelin daha sonra yeni bellek sorguları istemesi bu sürümde desteklenmez.

## Yazma ve kurtarma sınırları

Kaynak önce aynı dizindeki geçici dosyaya yazılır, diske aktarılır ve içerik önkoşulu yeniden kontrol edilerek yeniden adlandırılır. Yazma yarıda kesilirse hedef dosya kırpılmaz. Dosya modu korunur. Her proje için `.verdandi/mutation.lock`, ayrı süreçlerden gelen eşzamanlı derleyici yazmalarını da engeller.

Rollback kayıtları canonical proje köküne bağlıdır. Yazma veya geri yükleme başarısız olursa kayıt korunur. Birden fazla dosyanın yayımlanması işletim sistemi düzeyinde tek atomik işlem değildir; journal kurtarmayı sağlar. Harici editörler bu kilide katılmaz; kontrol ile rename arasındaki çok dar yarış penceresi tamamen ortadan kalkmış değildir.

Çöken süreçten kalan `mutation.lock` otomatik çalınmaz. İlgili sürecin bittiği ve başka yazıcı bulunmadığı doğrulandıktan sonra kilit kaldırılıp journal ile kurtarma yapılmalıdır. Canlı yazıcının kilidini silmeyin.

Kanıtlar `.verdandi/evidence` altında içerik adresli dosyalardır. Aktif referansları sessizce silmemek için otomatik GC yoktur; tek kayıt 8 MiB, depo normal seri kullanımda 64 MiB sınırını aşınca açık hata verir. Tamamlanan görevlerin kanıtları ihtiyaç kalmadığı doğrulanınca arşivlenmelidir. Kaynak içerebildikleri için bu klasör Git'e eklenmez. Depo sınırı ayrı süreçlerin eşzamanlı kanıt yazmalarında global kota kilidi değildir.

## Doğrulama ve ölçüm

```sh
npm test
npm run lint
npm run benchmark:lossless
VERDANDI_URDR_SERVER=/path/to/urdr/scripts/mcp-server.mjs npm test
```

Son komut gerçek Urðr entegrasyon testini de açar; test kendi geçici belleğini oluşturur. Ortam değişkeni yoksa sadece bu entegrasyon testi atlanır.

Sentetik aktarım deneyinde 113.000 tokenlık kaynak: ilk sayfa 999, değişmedi yanıtı 166, bir değişikliğin delta sayfası 342 token. Tam geri getirme birebir doğrulandı. **Bütün 143 sayfayı okumak 142.307 token tuttu**: gereksiz kısmı hiç okutmazsak kazanıyoruz; her şeyi sayfalayarak okumak daha pahalı. Bunlar model görevi başarısı ölçümleri değildir.

Gerçek eşleştirilmiş koşum kayıtlarını karşılaştırmak için:

```sh
npm run benchmark:compare -- baseline.json candidate.json 10000
```

Dosyalar `EvaluationRun[]` biçimindedir (`src/evaluation.ts`). Görev, tekrar, commit, model ve bağımsız oracle kimliği eşleşmelidir. Her API isteği input/output/cache verilerini ve input'un cache içerip içermediğini taşır. Eksik sayaç sıfır sayılmaz. Başarısız, korunan girdileri değişmiş veya bütçeyi aşmış vakalar gizlenmez; rapor görev bazında, medyan ve p95 ile değerlendirilir. Oracle kayıtlarını üretmek ve bağımsız davranış testlerini yürütmek deney koşucusunun sorumluluğudur; karşılaştırıcı bir modelin kendi başarı beyanını doğrulamaz.

Kalan hedef çalışması: gerçek görevlerde aynı modelle normal ajan/mevcut sürüm/yeni sürüm/yeni sürüm+Urðr karşılaştırması, geliştirmeden ayrı görevler ve kör kalite değerlendirmesi. Bu oturumda ücretli model karşılaştırması yapılmadı.
