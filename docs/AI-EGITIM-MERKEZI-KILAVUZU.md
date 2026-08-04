# AI Eğitim Merkezi kullanım kılavuzu

AI Eğitim Merkezi temel modeli gizlice fine-tune etmez. Yönetici talimatları, onaylı bilgiler, örnek cevaplar, belge parçaları, sürümler ve kapsam filtreleriyle denetlenebilir bir eğitim hafızası oluşturur.

## Güvenli akış

1. Kalıcı bir eğitim oturumu açın.
2. AI ile kuralı veya örneği netleştirin.
3. İçeriği ayrı bir **taslak** olarak oluşturun.
4. Kapsamı `global`, `contact` veya `conversation` olarak seçin.
5. **Canlı AI’a Etkisi** bölümünde aynı senaryo için mevcut cevap ile taslak sonrası olası cevabı karşılaştırın.
6. Başlık, içerik, kullanım izni, geçerlilik ve insan devri etkisini kontrol edin.
7. Yalnız yönetici onayından sonra yayınlayın.
8. Yayınlanan sürüm D1’e yazılır, güvenli Queue üzerinden embedding üretilir, Bulut Bilgi İndeksi güncellenir ve Windows yerel indeks paketi hazırlanır.
9. Gerekirse eski sürüme geri dönün veya kaydı canlı kullanımdan çıkarın.

Taslaklar canlı müşteri cevaplarında kullanılmaz. Simülasyon ve etki karşılaştırması müşteriye mesaj göndermez. Kapsam dışındaki müşteri veya konuşma bilgileri aramaya alınmaz.

## İçe ve dışa aktarma

Dışa aktarma; kaynak, sürüm, durum, kapsam ve checksum bilgisini içerir. Secret veya yetkisiz başka müşteri verisi içermez. İçe aktarma önce önizleme ve çakışma kontrolü yapar; yeni kayıtlar varsayılan olarak taslaktır.

## Tüm hafızayı temizleme

Bu işlem yönetici parolası ve tam onay metni ister. Canlı eğitimleri kapatır, Bulut Bilgi İndeksi temizleme işini başlatır ve Windows uygulamasında yerel indeksin de temizlendiğini doğrular. Müşteri konuşma geçmişi ve audit kayıtları korunur.
