# WPAI Windows kurulum ve kaldırma

## Kurulum

1. Yalnız final raporunda SHA-256 değeri verilen `WPAI_*_x64-setup.exe` dosyasını çalıştırın.
2. Yayıncı imzası yoksa Windows SmartScreen uyarısı gösterebilir. Dosya hashini final raporuyla karşılaştırın.
3. İlk açılışta Cloudflare bağlantısı yapılmamışsa **Cloudflare Kurulumu ve Onarımı** ekranı açılır.
4. Cloudflare API tokeni yalnız Windows Credential Manager içinde saklanır. D1, R2 veya uygulama loguna yazılmaz.
5. Kurulum tamamlandıktan sonra yönetici hesabı doğrulanır ve Windows oturumu otomatik açılır.

## Çevrimdışı kullanım

İnternet yokken uygulama yalnız daha önce senkronize edilmiş, yönetici tarafından onaylanmış yerel bilgileri aramaya açar. Müşteri mesajı gönderme, bulut verisi değiştirme, Meta işlemi ve senkronizasyon kapalıdır. Uygulama çevrimdışı işlemi başarılı gönderilmiş gibi göstermez.

## Kaldırma

Normal kaldırma, uygulama ikililerini kaldırır fakat kullanıcı verilerini ve yerel indeksi varsayılan olarak korur. Etkileşimli kaldırmada kullanıcıya **Yerel Eğitim İndeksi ve geçici Cloudflare kurulum önbelleğini de silme** seçeneği sunulur. Bu seçenek yalnız bilgisayardaki şu cache klasörlerini temizler:

- `faiss-index`
- `cloudflare-bootstrap`

Cloudflare D1, R2, Queue, Vectorize, WhatsApp konuşmaları ve audit kayıtları kaldırıcı tarafından silinmez.

Sessiz kurulum/kaldırma testinde varsayılan koruma davranışı ve `/PURGELOCALCACHE` seçeneği ayrı ayrı doğrulanır.
