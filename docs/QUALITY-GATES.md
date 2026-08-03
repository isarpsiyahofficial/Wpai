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
11. Rust compile kontrolü
12. Gerçek Tauri NSIS `setup.exe` üretimi

## Zorunlu işlev kapsamı

Testler; yönetici kurulumu ve oturum güvenliği, kişi ve konuşma alanları, CSV içe aktarma, Meta webhook ve bağlantı yaşam döngüsü, mesaj/şablon/dosya gönderimi, R2 konuşma yetkilendirmesi, D1 veri dışa aktarma ve silme, bilgi bankası, hizmet/fiyat kuralları, AI ayarları ve eğitim akışı, müşteri izolasyonu, Queue tüketicileri, insan devri, takip cronları ve Cloudflare güvenli onarımını kapsar.

Neuron doğrulaması yalnız yüzdeye bakmaz. Kullanılan Neuron, yapılandırılmış mevcut hak/bütçe, kalan, aşım, giriş/çıkış tokenleri, başarılı/başarısız işlem sayıları, UTC dönem başlangıcı ve sıfırlanma zamanı ayrı ayrı doğrulanır. Onaysız fiyat iddiaları gönderilmeden önce sunucu tarafında engellenir.

Para güvenlik testleri; `15.000 TL`, `250,50 EUR`, `100 USD`, `₺12.500`, `$99.90` ve `€ 1.250` biçimlerini kapsar. Cümle ayırıcıları tutar kaydına dahil edilmez ve başka müşterinin özel teklif tutarı mevcut konuşmada onaylı fiyat kabul edilmez.

Test beklentileri hatayı gizlemek için gevşetilmez. Davranış bozuksa kaynak kod düzeltilir ve aynı test yeniden çalıştırılır.

## Birleştirme ve production kanıtı

Taslak PR yalnız son head commit için Linux kalite kapıları, bağımlılık denetimi, FAISS testleri ve Windows NSIS kurulumu başarıyla tamamlandığında incelemeye hazır duruma getirilebilir. Önceki commitlere ait sonuçlar veya yalnızca kaynak kod incelemesi güncel head commitin test kanıtı sayılmaz. Production dağıtımı ayrıca manuel `production` environment onayı, doğru Cloudflare hesap kimliği ve başarılı sağlık kontrolü gerektirir.
