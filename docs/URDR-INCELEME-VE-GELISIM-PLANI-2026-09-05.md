# Verðandi + Urðr: token azaltma için inceleme ve geliştirme planı

Tarih: 5 Eylül 2026. Bu belge bir uygulama tamamlanma raporu değildir; mevcut kod, yerel test ve deney sonuçlarına dayanan geliştirme tasarımıdır.

## İncelenen sürümler

- Verðandi: `1d3bdeed27bb454859c413b4004dab5ad5f5f0cc`, `/Users/gencay/Downloads/Verðandi`.
- Urðr: `09dd7feb9d5c946eb13d9cd1ac5f127f1d520afa`, paket sürümü `1.4.0`, `/Users/gencay/Downloads/urdr`.
- Urðr GitHub deposundan ayrı klasöre indirildi. Mevcut kişisel bellek ve MCP ayarları değiştirilmedi.
- Urðr bağımlılıkları kilit dosyasından `npm ci --ignore-scripts` ile kuruldu. Ürün kaynakları değiştirilmedi.

## Hedefin ölçülebilir karşılığı

Hedef: aynı görevi, aynı başlangıç kodu ve aynı model koşullarında, yüz binlerce token yerine binlerce token kullanarak en az aynı kalitede tamamlamak.

Üç ayrı şey karıştırılmamalı:

1. **Bilgi bütünlüğü:** saklanan kaynağın istenen parçası eksiksiz geri getirilebiliyor mu?
2. **Bağlam yeterliliği:** görev için gerekli kanıt doğru zamanda modele ulaşıyor mu?
3. **Görev kalitesi:** sonuç gerçekten istenen davranışı sağlıyor ve diğer davranışları koruyor mu?

Hash ve geri getirilebilir referans birinciyi destekler. İkinci ve üçüncü için görev bazlı değerlendirme gerekir. Bütün olası görevlerde sıfır kalite kaybı bugün kanıtlanmış değildir. Sabit token tavanına sığmayan görevlerde sessizce bilgi kesmek yerine kapsam genişletilmeli ve hedefin aşıldığı raporlanmalıdır.

## Urðr'den yararlanılacak parçalar

| Parça | Kod | Verðandi'ye katkısı |
|---|---|---|
| Oturum başlangıç özeti ve yaprak indeksi | `urdr/scripts/lib/context-pack.mjs` | Önceki kararları yeniden keşfetmeden ilgili kanıta yönlenme |
| Değişmeyen yanıtın hash ile tespiti | `urdr/scripts/lib/context-tax.mjs` | Tekrarlanan sembol/arama çıktısını yeniden göndermeme |
| Büyük çıktının referansla saklanması | `urdr/scripts/lib/context-tax.mjs` | Kırpılan kod ve tanı çıktısına eksiksiz geri dönüş |
| Dosya farkları | `urdr/scripts/lib/file-watch.mjs` | Yeniden tam dosya okumak yerine değişen aralıkları getirme |
| Gerçek oturum tüketimi ayrıştırma | `urdr/scripts/token-autopsy.mjs` | Araç boyutu ile toplam API tüketimini ayrı ölçme |
| Kaynak, doğrulama ve geçerlilik bilgisi | `urdr/protocols/architecture.md` | Eski kararı güncel kod gerçeği sanmama |

Önerilen sorumluluk ayrımı: Urðr geçmiş karar ve kanıt belleğini; Verðandi güncel kodu, bağımlılıkları ve görev kapsülünü yönetir. İstemci adaptörü ise modele her adımda gönderilen bağlamı yönetir. İki depo zorunlu tek pakete dönüştürülmeden ortak sözleşmeyle bağlanabilir.

## Canlı yerel doğrulama

Urðr `node scripts/selftest.mjs` sıfır çıkış koduyla tamamlandı. Ana koşucu `223 passed, 0 failed` bildirdi; ayrıca çağırdığı alt süitler de geçti. Bağlam aktarımı için Rock 9: 11; dosya farkları için Rock 10: 10; yazma bağlamı için Rock 11: 11 kontrol geçti. Bu sayılar toplanarak yeni bir toplam üretilmedi.

`node scripts/context-bench.mjs --json` sentetik 9.000 yapraklı örnekte eski başlangıç okuması için 85.157, yeni özet için 375 token tahmini verdi. Bu ölçüm **karakter/4 yaklaşımıdır**, gerçek API tüketimi veya görev kalitesi değildir. Özet tüm yaprakların içeriğini içermez.

Ayrı aktarım deneyinde 6.000 basit TypeScript fonksiyonundan oluşan sentetik kaynak kullanıldı. `js-tiktoken` ile `cl100k_base` tokenizasyonu uygulandı:

| Ölçüm | Token |
|---|---:|
| Tam JSON araç yanıtı | 125.015 |
| Saklanmış çıktının ilk referans yanıtı | 124 |
| Aynı sorgunun değişmedi yanıtı | 91 |
| Bir satırlık değişikliğin fark verisi | 84 |
| Saklanan JSON'dan kaynak içeren tek satırın fetch yanıtı | 131.062 |

Tam yanıt JSON olarak birebir geri getirildi. Fark uygulanınca yeni kaynak birebir elde edildi. **124 tokenlık yanıt görev için gerekli kodu taşımıyor; yalnız aktarımın ertelenebildiğini kanıtlıyor.** Bu deneyde model çağrılmadı, görev çözülmedi, kalite değerlendirilmedi. Sonradan yapılan tüm okumalar gerçek uçtan uca maliyete eklenmelidir.

## Doğrudan kopyalamadan önce çözülmesi gerekenler

1. **JSON satırı, kod satırı değildir.** Kaynak bir JSON string alanındaysa binlerce kod satırı tek fiziksel JSON satırına dönüşür. Mevcut `urdr_fetch` satır aralığı bu durumda 131 bin token döndürdü. Kaynak aralığı veya byte/token tabanlı sayfalama ve devam imleci gerekir.
2. **Karakter/4 katı token sınırı değildir.** Her iki projede tahmin kullanılıyor. Bütçe bütün model görünür zarf, kaynak, tekrar bilgisi ve kontrol metni üzerinde gerçek tokenizer ile uygulanmalı. Tokenizer adı ölçümle kaydedilmeli.
3. **Sunucu belleği modelin gördüklerini kanıtlamaz.** Bağlam sıkıştırıldıktan sonra sunucu önceki yanıtı hatırlasa da model hatırlamayabilir. İstemcinin bağlam nesli/oturum kimliği ve gördüğü içerik hash'leri izlenmeli; gerektiğinde veri yeniden verilmelidir.
4. **MCP geçmiş mesajları silemez.** Küçük yeni yanıt geçmişte bağlama girmiş büyük yanıtı çıkarmaz. Büyük toplam tasarruf için adaptörün modele giden etkin çalışma kümesini yönetmesi gerekir. Desteklenmeyen istemcilerde garanti yalnız yeni araç çıktılarıyla sınırlanır.
5. **Spool önbellektir.** Urðr 32 dosya/4 MB süpürme politikası kullanıyor. Görev için gereken eski kanıt temizlenirse güncel dosya aynı eski sürümü vermeyebilir. Etkin görevin referansları korunmalı veya belirli snapshot'tan yeniden üretilebilmelidir.
6. **Mevcut Verðandi kesitleri genişletilemiyor.** `read_symbol` başlangıçtan kırpıyor; devam imleci yok. Ajanın aynı dosyadan daha fazla bağlam isteği de reddedilebiliyor. Bu yollar düzeltilmeden küçük bağlam kaliteyi düşürebilir.
7. **Test, config ve sözleşme bilgileri de kanıttır.** Sadece doğrudan eşleşen fonksiyonu seçmek yeterli değildir. Çağıranlar, veri tipleri, testler, yapılandırma ve yaşam döngüsü etkileri gerektiğinde kapsüle girmelidir.
8. **Token raporları normalize edilmeli.** Verðandi'nin mevcut `benchmark_runs/fair-test/fair-test.json` dosyasında `totalTokens` alanı bazı satırlarda cache dahil toplamla uyumlu, bazılarında değil. Yeni kararlar bu alanın doğrudan oranına dayanmamalı.

## Geliştirme sırası ve kabul koşulları

### 1. Güvenilir temel ve ölçüm

- Önceki incelemedeki yarım yazma/veri kaybı, başka proje anahtarıyla geri alma ve yanlış başarı raporlama hatalarını düzelt.
- Verðandi'nin Mac ortamındaki platforma uymayan bağımlılıklarını gider ve regresyon testlerini çalıştır.
- Görev manifestine repo commit'i, model/sürüm, sistem talimatları, araçlar, başlangıç bellek durumu ve tekrar ayarlarını yaz.
- Input/output/cache sayaçlarını sağlayıcı semantiğine göre ayrı kaydet; cache altküme ise tekrar toplama. Eksik kullanım verisini sıfır sayma.
- Önce güçlü, normal araç kullanan ajanı referans al. Sırf tasarrufu büyütmek için bütün repoyu zorla okutan bir temel kullanma.

### 2. Kayıpsız erişim sözleşmesi

- Her kanıt: proje kimliği, snapshot, dosya, sembol/aralık, içerik hash'i ve devam referansı taşısın.
- Büyük kaynak, log ve tanı çıktıları saklansın; sadece gerekli parça bütçeye sığarak gelsin.
- Yeni çağrıda sıfır ilerleme ve sonsuz sayfalama engellensin. Eksik/eski referans açık hata versin.
- Türkçe, Unicode, uzun tek satır, büyük fonksiyon ve çoklu JSON kaçışlama vakalarında tüm yanıt bütçesi test edilsin.

### 3. Küçük ve güncel çalışma bağlamı

- Aynı snapshot ve aralık tekrar gönderilmesin; değişiklik olduğunda doğrulanabilir fark ile güncellensin.
- Compaction/restart sonrası hangi kanıtın modelde bulunduğu yeniden kurulabilsin.
- Kalıcı talimatlar ve kullanıcının görevi korunurken eski araç gövdeleri adaptör seviyesinde etkin bağlamdan çıkarılabilsin.

### 4. Göreve göre kanıt seçimi ve Urðr bağlantısı

- Arama sonucu adaydır; doğruluk garantisi değildir. Gereken bağımlılıklar adım adım genişletilsin.
- Urðr'deki kararlar proje ve kaynak sürümüyle bağlansın. Eskimiş/çelişen kayıt doğrulanmadan uygulama kuralı yapılmasın.
- Geçmiş belleği olmayan ilk görev ve bellekten yararlanan tekrar görev ayrı ölçülsün. Bellek hazırlama maliyeti rapordan çıkarılmasın.
- Gerekli kanıt bulunamıyorsa daha fazla okuma yapılsın; yalnız token hedefini tutturmak için başarılı sonucu ilan edilmesin.

### 5. Kalite ve toplam tüketim kapısı

Dört koşul karşılaştırılsın: normal ajan; mevcut Verðandi; yeni Verðandi; yeni Verðandi + Urðr. Aynı görevler aynı repo snapshot'ından başlasın; her koşul tekrarlı çalıştırılsın.

Görevler küçük hata, çok dosyalı değişiklik, veri akışı, yapılandırma, Türkçe istek, yanıltıcı isimler, büyük fonksiyon, eski bellek ve bağlam sıkıştırma vakalarını içersin. Geliştirme görevlerinden ayrı tutulmuş değerlendirme görevleri bulunsun.

Kalite: gizli davranış testleri, regresyonlar, gerekli değişikliklerin tamamlanması ve gerektiğinde kör inceleme. Ajanın kendi başarı alanı veya sadece typecheck yeterli değildir. Test ve talimat dosyalarını değiştirerek değerlendirmeyi kolaylaştıran sonuçlar kabul edilmemeli.

Maliyet: görev başına tüm model istekleri, geri dönüş okumaları, yeniden denemeler, model kullanan bellek işlemleri ve özetleme; ayrıca tepe bağlam, gecikme ve hata oranı. Medyan, p95 ve görev bazlı sonuçlar ayrı gösterilsin.

Kabul: tanımlı değerlendirme kümesinde yeni kalite gerilemesi olmaması; belirsizlik/örneklem sınırının raporlanması; önceden seçilen binler düzeyindeki toplam token eşiğine kaç görevin sığdığının açık verilmesi. Başarısız veya bütçeyi aşan görevler sonuçtan çıkarılmamalı. Bu eşik henüz başarılmış değildir.

## Sonuç

Urðr, tekrar okuma ve çıktıyı kayıpsız dışarıda tutma için kullanılabilir bir temel sağlıyor. Hedefe giden ana iş, bu mekanizmaları Verðandi'nin AST kanıt seçimiyle ve istemcinin etkin bağlam yönetimiyle birleştirmek. Başarı ölçüsü küçük referans yanıtı değil, aynı kalitede tamamlanmış görevin toplam maliyetidir.
