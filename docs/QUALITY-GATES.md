# WPAI kalite kapıları

Bu dal aşağıdaki kapıların tamamı yeşil olmadan `main` dalına birleştirilmez:

1. Secret taraması
2. Cloudflare manifesti ve D1 migration doğrulaması
3. Ayrı frontend, Worker ve Workerd test TypeScript projeleri
4. Node unit testleri
5. Gerçek Workerd + D1 integration testleri
6. React production build
7. Wrangler production dry-run
8. npm yüksek seviye güvenlik denetimi
9. Linux FAISS testleri
10. Windows FAISS sidecar derlemesi
11. Rust unit testleri, Clippy sıfır uyarı kapısı ve kilitli compile kontrolü
12. Gerçek Tauri NSIS `setup.exe` üretimi
13. Temiz D1 üzerinde gerçek yerel Wrangler HTTP, R2, webhook ve scheduled handler senaryosu
14. Node 24 alternatif çalışma zamanı çapraz doğrulaması
15. 320 px telefondan 1920 px masaüstüne dolu verili responsive tarayıcı matrisi
16. Sayfa taşması, kırpılmış metin, öğe çakışması ve isimsiz kontrol denetimi

## Zorunlu işlev kapsamı

Testler; yönetici kurulumu ve oturum güvenliği, kişi ve konuşma alanları, CSV içe aktarma, Meta webhook ve bağlantı yaşam döngüsü, mesaj/şablon/dosya gönderimi, R2 konuşma yetkilendirmesi, D1 veri dışa aktarma ve silme, bilgi bankası, hizmet/fiyat kuralları, AI ayarları ve eğitim akışı, müşteri izolasyonu, Queue tüketicileri, insan devri, takip cronları ve Cloudflare güvenli onarımını kapsar.

Neuron doğrulaması yalnız yüzdeye bakmaz. Kullanılan Neuron, yapılandırılmış mevcut hak/bütçe, kalan, aşım, giriş/çıkış tokenleri, başarılı/başarısız işlem sayıları, UTC dönem başlangıcı ve sıfırlanma zamanı ayrı ayrı doğrulanır. Onaysız fiyat iddiaları gönderilmeden önce sunucu tarafında engellenir.

Para güvenlik testleri; `15.000 TL`, `250,50 EUR`, `100 USD`, `₺12.500`, `$99.90` ve `€ 1.250` biçimlerini kapsar. Cümle ayırıcıları tutar kaydına dahil edilmez ve başka müşterinin özel teklif tutarı mevcut konuşmada onaylı fiyat kabul edilmez.

Dosya erişimi yalnız `/api/conversations/:conversationId/attachments/:attachmentId` kapsamlı yolu üzerinden yapılır. Kapsamsız eski dosya yolu güvenlik amacıyla kapalı kalır; sohbet ve dosya listesi aynı konuşma kapsamlı yolu kullanmak zorundadır.

Responsive doğrulama; 320×568, 390×844, 768×1024, 1366×768 ve 1920×1080 ekranlarında tüm ana sayfaları üretim boyutlu uzun Türkçe içerikle dolaşır. Belge seviyesinde yatay taşma, kırpılmış metin, üst üste binen kardeş öğeler, isimsiz etkileşim kontrolleri, tarayıcı hataları ve konsol hataları kabul edilmez. Yoğun mobil tablolar sayfayı genişletmeden kendi paneli içinde kontrollü yatay kaydırma kullanır.

Canlı-benzeri yerel Wrangler akışı temiz veritabanına bütün migrationları uygular; health ve güvenlik başlıklarını, auth/CSRF’yi, CSV’yi, imzalı Meta webhook’unu, webhook ve mesaj idempotency’sini, kapsamlı R2 dosya turunu, Neuron güvenlik limitini, rapor/dışa aktarmayı ve scheduled handler’ı gerçek HTTP üzerinden doğrular. Akış sonunda Wrangler logunda beklenmeyen `Uncaught Error` veya hata seviyesi kaydı bulunamaz.

Test beklentileri hatayı gizlemek için gevşetilmez. Davranış bozuksa kaynak kod düzeltilir ve aynı test yeniden çalıştırılır.

## Birleştirme ve production kanıtı

Taslak PR yalnız son head commit için Linux kalite kapıları, bağımlılık denetimi, FAISS testleri, canlı-benzeri HTTP akışı, responsive tarayıcı matrisi ve Windows NSIS kurulumu başarıyla tamamlandığında incelemeye hazır duruma getirilebilir. Önceki commitlere ait sonuçlar veya yalnızca kaynak kod incelemesi güncel head commitin test kanıtı sayılmaz. Production dağıtımı ayrıca manuel `production` environment onayı, doğru Cloudflare hesap kimliği ve başarılı sağlık kontrolü gerektirir.
