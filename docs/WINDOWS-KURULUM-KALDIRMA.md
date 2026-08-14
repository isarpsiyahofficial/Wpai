# WPAI Windows kurulum ve kaldırma

## Kurulum

1. Yalnız final raporunda SHA-256 değeri verilen `WPAI_*_x64-setup.exe` dosyasını çalıştırın.
2. Yayıncı imzası yoksa Windows SmartScreen uyarısı gösterebilir. Dosya hashini final raporuyla karşılaştırın.
3. WPAI açıldığında kullanıcı adı, yönetici e-postası, yönetici parolası veya Cloudflare API tokeni isteyen bir onboarding formu açılmaz.
4. Uygulama önce Windows Credential Manager’daki WPAI cihaz refresh oturumunu dener.
5. Geçerli cihaz oturumu yoksa paketlenmiş Wrangler çalışma yolu bu Windows kullanıcısının mevcut Cloudflare OAuth oturumunu `wrangler whoami` ile doğrular.
6. Stale `CLOUDFLARE_API_TOKEN`, `CF_API_TOKEN` ve benzeri provider-token ortam değişkenleri onboarding alt sürecinden çıkarılır; eski/expired API token Wrangler OAuth’un önüne geçemez.
7. Mevcut Wrangler OAuth oturumu yoksa **Cloudflare Oturumunu Aç** düğmesi Cloudflare’ın resmî tarayıcı OAuth akışını başlatır. E-posta/parola Cloudflare’ın kendi sayfasında işlenir; WPAI formuna girilmez ve WPAI tarafından saklanmaz.
8. OAuth doğrulandıktan sonra WPAI gerekli production D1 migrasyonlarını ve Worker runtimeını doğrular/günceller, cihaza bağlı tek kullanımlık aktivasyon bileti üretir ve Worker’dan access/refresh cihaz oturumu alır.
9. Refresh token Windows Credential Manager’da saklanır. Uygulama yeniden açıldığında bağlantı otomatik yenilenir.
10. **Bu Cihazın Bağlantısını Kaldır** yalnız bu bilgisayarın WPAI cihaz oturumunu ve yerel bağlantı kaydını kaldırır; D1, R2, Queue, Vectorize, işletme bilgileri, müşteriler ve konuşma geçmişi silinmez.

## Cloudflare OAuth ve güvenlik sınırı

- WPAI içine Cloudflare API tokeni yapıştırılmaz.
- Wrangler OAuth credentialı frontend JavaScript’e verilmez; paketlenmiş Wrangler yalnız yerel Tauri alt sürecinde çalışır.
- OAuth hesabı sabit WPAI Account ID ile eşleşmezse bağlantı reddedilir.
- Cihaz aktivasyon bileti D1’de açık metin tutulmaz; yalnız SHA-256 hash saklanır.
- İlk başarılı kullanımda bilet cihaz hash’ine bağlanır ve başka cihaz tarafından kullanılamaz.
- Worker access/refresh tokenları bağımsız üretilir; Cloudflare OAuth credentialı uygulamanın normal API çağrılarında kullanılmaz.

## İnternet kesintisi

İnternet yokken kayıtlı WPAI cihaz bağlantısı korunur. Uygulama Ayarlar bölümünde bağlantının kayıtlı olduğunu ve internet bağlantısının beklendiğini sade biçimde gösterir. Müşteri mesajı gönderme, bulut verisi değiştirme ve Meta işlemleri internet yeniden gelene kadar kapalıdır.

İnternet kesintisinde ayrı bir “Yerel Bilgi Modu” açılmaz. Son kullanıcıya FAISS boyutu, checksum, indeks sürümü, yerel indeks temizleme veya benzeri geliştirici kontrolleri gösterilmez.

## Kaldırma

Normal kaldırma uygulama ikililerini kaldırır fakat kullanıcı verilerini ve arka plan önbelleğini varsayılan olarak korur. Etkileşimli kaldırmada kullanıcıya yalnız bilgisayardaki geçici uygulama önbelleğini temizleme seçeneği sunulur. Bu seçenek şu yerel cache klasörlerini temizleyebilir:

- `faiss-index`
- `cloudflare-bootstrap`
- `cloudflare-oauth-bootstrap`

Bu klasör adları ürünün normal kullanıcı arayüzünde gösterilmez. Cloudflare D1, R2, Queue, Vectorize, WhatsApp konuşmaları ve audit kayıtları kaldırıcı tarafından hiçbir durumda silinmez.

Sessiz kurulum/kaldırma testinde varsayılan koruma davranışı ve `/PURGELOCALCACHE` seçeneği ayrı ayrı doğrulanır.

## Final doğrulama

Final Windows paketi verilmeden önce en az şu kapılar geçmelidir:

- kaynak/manifest/500-madde doğrulaması,
- dependency ve secret taraması,
- Wrangler OAuth testleri; stale provider-token ortam değişkeni senaryosu dahil,
- worker device activation ve refresh rotasyonu testleri,
- responsive UI testleri ve Cloudflare `apiToken` inputunun bulunmadığının doğrulanması,
- Windows Rust compile/test,
- gerçek NSIS build, sessiz kurulum, uygulama açılışı, tek örnek ve kaldırma yaşam döngüsü,
- kurulu pakette `oauth-device-bootstrap.mjs`, paketlenmiş Node ve Wrangler proje kaynaklarının bulunduğunun doğrulanması.
