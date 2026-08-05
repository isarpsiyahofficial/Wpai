# WPAI Windows kurulum ve kaldırma

## Kurulum

1. Yalnız final raporunda SHA-256 değeri verilen `WPAI_*_x64-setup.exe` dosyasını çalıştırın.
2. Yayıncı imzası yoksa Windows SmartScreen uyarısı gösterebilir. Dosya hashini final raporuyla karşılaştırın.
3. Uygulama açıldığında Cloudflare bağlantısı **Ayarlar → Bağlantılar** bölümünden kullanıcı tarafından kurulur.
4. Cloudflare API tokeni yalnız Windows Credential Manager içinde saklanır. D1, R2 veya uygulama loguna yazılmaz.
5. Başarılı bağlantı **Bağlı** olarak gösterilir ve uygulama kapatılıp yeniden açıldığında kayıtlı kalır.
6. Aynı bölümden bağlantı doğrulanabilir, bağlantı bilgisi güncellenebilir veya bağlantı kaldırılabilir.
7. Bağlantıyı kaldırmak D1, R2, Queue, Vectorize, işletme bilgileri, müşteriler veya konuşma geçmişini silmez.

## İnternet kesintisi

İnternet yokken kayıtlı Cloudflare bağlantısı korunur. Uygulama Ayarlar → Bağlantılar bölümünde bağlantının kayıtlı olduğunu ve internet bağlantısının beklendiğini sade biçimde gösterir. Müşteri mesajı gönderme, bulut verisi değiştirme ve Meta işlemleri internet yeniden gelene kadar kapalıdır.

İnternet kesintisinde ayrı bir “Yerel Bilgi Modu” açılmaz. Son kullanıcıya FAISS boyutu, checksum, indeks sürümü, yerel indeks temizleme veya benzeri geliştirici kontrolleri gösterilmez.

## Kaldırma

Normal kaldırma uygulama ikililerini kaldırır fakat kullanıcı verilerini ve arka plan önbelleğini varsayılan olarak korur. Etkileşimli kaldırmada kullanıcıya yalnız bilgisayardaki geçici uygulama önbelleğini temizleme seçeneği sunulur. Bu seçenek şu yerel cache klasörlerini temizleyebilir:

- `faiss-index`
- `cloudflare-bootstrap`

Bu klasör adları ürünün normal kullanıcı arayüzünde gösterilmez. Cloudflare D1, R2, Queue, Vectorize, WhatsApp konuşmaları ve audit kayıtları kaldırıcı tarafından hiçbir durumda silinmez.

Sessiz kurulum/kaldırma testinde varsayılan koruma davranışı ve `/PURGELOCALCACHE` seçeneği ayrı ayrı doğrulanır.
