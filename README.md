# WPAI

Tek işletmeye ait WhatsApp Business görüşmelerini, dosyaları, müşteri ihtiyaçlarını ve kontrollü yapay zekâ yanıtlarını Cloudflare üzerinde yöneten tam kapsamlı sistem.

## Ürün bileşenleri

- **Cloudflare Worker:** API, WhatsApp webhook, Queue tüketicileri, cron görevleri ve React asset sunumu.
- **Cloudflare D1:** konuşmaların, mesajların, müşteri notlarının, AI kararlarının ve audit kayıtlarının ana kaynağı.
- **Cloudflare R2:** konuşmaya bağlı özel görsel, PDF ve belgeler.
- **Cloudflare Queues:** inbound AI, outbound WhatsApp ve yönetici bildirimleri; ayrı DLQ’lar.
- **Workers AI + Vectorize:** onaylı işletme bilgisine dayalı production RAG ve yapılandırılmış AI kararları.
- **React yönetim paneli:** WhatsApp gelen kutusu, kişiler, bilgi bankası, dosyalar, AI kontrolü, bildirimler, raporlar ve ayarlar.
- **Tauri 2 Windows uygulaması:** production Worker’a güvenli cihaz oturumuyla bağlanan gerçek Windows programı.
- **Wrangler OAuth bootstrap:** kullanıcının Windows’taki mevcut Wrangler OAuth oturumunu kullanır; WPAI içine Cloudflare API tokeni, e-posta veya parola girilmez.
- **Windows Credential Manager:** yalnız WPAI cihaz refresh oturumu ve gerekli yerel güvenli kayıtlar için kullanılır.
- **FAISS sidecar:** arka plandaki indeksleme ve test altyapısıdır; son kullanıcıya teknik FAISS, checksum veya yerel indeks ekranı gösterilmez.

## Temel güvenlik kuralları

**AI varsayılan kapalıdır.** Eğitim veya indeks senkronizasyonu otomatik cevap modunu kendiliğinden açmaz.

1. Her müşteri yalnız doğrulanmış `contact_id + conversation_id` ilişkisiyle işlenir.
2. AI’ın başka konuşmaları listeleme, serbest SQL çalıştırma veya farklı müşteri kimliği seçme yetkisi yoktur.
3. AI yalnız `approved` işletme bilgisi, mevcut müşteri profili, kısa özet ve son mesajlarla çalışır.
4. Fiyat, indirim ve teslim süresi D1’de doğrulanmadan gönderilemez.
5. AI ilk deployda kapalıdır. Otomatik yanıt için global ayar, konuşma modu, insan devri, pause ve güncel mesaj kapıları gönderimden hemen önce tekrar kontrol edilir.
6. R2 public değildir. Dosya erişimi yetkili Worker endpointi ve konuşma ilişkisiyle sınırlıdır.
7. Cloudflare OAuth credentialı WPAI arayüzüne taşınmaz; Wrangler kendi OS-güvenli oturumunu kullanır. Stale `CLOUDFLARE_API_TOKEN`/`CF_API_TOKEN` ortam değişkenleri onboarding sırasında özellikle devre dışı bırakılır.
8. Windows uygulaması kullanıcı adı, yönetici e-postası, yönetici parolası veya Cloudflare API tokeni istemez.
9. WPAI cihaz oturumu D1’de cihaz kimliğine bağlıdır; erişim/refresh tokenları döndürülür, refresh token Windows Credential Manager’da tutulur ve rotasyona uğrar.
10. Bağlantıyı kaldırmak D1, R2, müşteri kayıtları veya konuşma geçmişini silmez.
11. Kampanya gönderim çalışma akışı ürün arayüzünden ve aktif API’den kaldırılmıştır.

## Sabit Cloudflare manifesti

| Bileşen | Değer |
|---|---|
| Account ID | `ad8e99c82c6c17d823f6877ff1efade4` |
| Worker | `wa-ai-panel` |
| Worker URL | `https://wa-ai-panel.wa-ai-panel.workers.dev` |
| D1 | `wa-ai-prod` |
| D1 ID | `81983219-f57b-487b-8144-7c70bf9b1fe2` |
| R2 | `wa-ai-files-prod` |
| Vectorize | `wa-ai-knowledge-prod` |
| Inbound Queue | `wa-inbound-ai` |
| Outbound Queue | `wa-outbound` |
| Admin Queue | `wa-admin-notify` |
| AI DLQ | `wa-ai-dlq` |
| Outbound DLQ | `wa-outbound-dlq` |

Bu manifest uygulamanın iç doğrulama ve dağıtım sınırıdır. Account ID, D1 ID, kuyruk isimleri ve benzeri teknik kimlikler normal kullanıcı arayüzünde gösterilmez.

## Gereksinimler

- Son kullanıcı: Windows 10/11, WebView2 ve internet bağlantısı.
- Cloudflare hesabı bu bilgisayarda daha önce `wrangler login` ile bağlıysa WPAI mevcut OAuth oturumunu otomatik kullanır.
- Mevcut Wrangler OAuth oturumu yoksa WPAI **Cloudflare Oturumunu Aç** düğmesiyle Cloudflare’ın resmî tarayıcı OAuth akışını başlatır; credential WPAI formuna girilmez.
- Geliştirme/build: Node.js 22+, npm 10+, Wrangler 4.x, Python 3.12, Rust 1.97.1 ve Windows WebView2.

## Windows ilk açılış ve cihaz bağlantısı

1. WPAI açıldığında önce Windows Credential Manager’daki mevcut WPAI refresh oturumunu dener.
2. Geçerli refresh oturumu yoksa paketlenmiş Wrangler çalışma yolu devreye girer.
3. WPAI, stale API-token ortam değişkenlerini Wrangler alt sürecinden çıkarır ve `wrangler whoami` ile yalnız OAuth oturumunu doğrular.
4. OAuth oturumu geçerliyse production Worker/D1 sağlık durumu doğrulanır ve cihaza bağlı kısa ömürlü aktivasyon bileti oluşturulur. Uygulama açılışında npm kurulumu, build, migration veya deploy çalıştırılmaz.
5. Aktivasyon bileti yalnız ilk cihaz hash’ine bağlanır; başka cihazda tekrar kullanılamaz.
6. Worker, bu cihaz için access/refresh oturumu üretir. Refresh token Windows Credential Manager’da saklanır.
7. OAuth oturumu yoksa WPAI form açmaz; **Cloudflare Oturumunu Aç** düğmesi resmî Cloudflare tarayıcı girişini başlatır ve tamamlanınca cihaz bağlantısı yeniden kurulur.
8. Bu akışın hiçbir noktasında WPAI kullanıcı adı, e-posta, parola veya Cloudflare API tokeni istemez.

## Meta WhatsApp kurulumu

Panelde **Ayarlar → WhatsApp / Meta Bağlantısı** bölümüne Meta WhatsApp Business Platform entegrasyon bilgileri girilir ve gerçek Graph API isteğiyle doğrulanır. Bunlar WPAI yönetici giriş bilgileri değildir; yalnız Meta API entegrasyon secretlarıdır. Başarılı bağlantı **Bağlı** olarak görünür ve aynı bölümden doğrulanabilir, güncellenebilir, geçici olarak durdurulabilir veya kaldırılabilir.

Webhook URL:

```text
https://wa-ai-panel.wa-ai-panel.workers.dev/webhooks/whatsapp
```

Meta uygulamasında `messages` webhook alanına abone olunmalıdır. İlk iletişim yalnız Meta tarafından `APPROVED` durumuna getirilmiş şablonla yapılır. Müşteri cevap verdikten sonra 24 saatlik pencerede serbest metin ve medya gönderilebilir.

## AI eğitim akışı

- Yönetici AI Kontrolü ekranında iç asistanla konuşabilir.
- Asistanın cevabı otomatik olarak işletme gerçeğine dönüşmez.
- Yönetici eğitim taslağını düzenler ve onaylar.
- Onaylı kayıt D1’de `approved` olur, embedding üretilir ve Vectorize’a işlenir.
- Arka plandaki indeks bileşenleri kullanıcıya teknik yönetim ekranı olarak sunulmaz.
- Müşteriden gelen hiçbir iddia otomatik genel bilgiye dönüştürülmez.

## Yerel geliştirme

```bash
npm ci
npm run types
npm run db:local
npm run dev
```

Vite: `http://localhost:5173`  
Worker: `http://localhost:8787`

## Production secretları

Meta ve uygulama içi kriptografik secretlar GitHub/Cloudflare secret yönetiminde tutulur; gerçek değerler kaynak koda veya `.dev.vars.example` içine yazılmaz. Windows onboarding için kullanıcıdan Cloudflare API tokeni alınmaz.

Örnek Worker secretları:

```text
META_ACCESS_TOKEN
META_APP_SECRET
META_WHATSAPP_PHONE_NUMBER_ID
META_WHATSAPP_BUSINESS_ACCOUNT_ID
WHATSAPP_VERIFY_TOKEN
ADMIN_WHATSAPP_PHONE
SESSION_SIGNING_KEY
DATA_ENCRYPTION_KEY
ADMIN_BOOTSTRAP_TOKEN
```

`ADMIN_BOOTSTRAP_TOKEN` eski/web uyumluluk katmanında bulunabilir; Windows ürün onboarding’i bunu kullanıcıdan istemez ve Windows arayüzünde yönetici parola kurulumu yoktur.

## Testler ve kalite kapıları

```bash
npm run security:scan
npm run validate
npm run typecheck
npm run test:oauth
npm run test:unit
npm run test:worker
npm run build
npm run deploy:dry
python -m pytest -q sidecar/test_faiss_service.py
```

Zorunlu kapsamın önemli parçaları:

- D1 migration ve foreign key kontrolü,
- cihaza bağlı aktivasyon bileti ve başka cihazda tekrar kullanım reddi,
- access/refresh oturumu üretimi ve refresh rotasyonu,
- mevcut Wrangler OAuth ile credential-free ilk açılış,
- OAuth yoksa yalnız resmî tarayıcı OAuth düğmesinin görünmesi,
- stale Cloudflare API-token ortam değişkenlerinin Wrangler OAuth’u ezememesi,
- ürün UI’sinde `apiToken` inputunun bulunmaması,
- webhook imzası ve idempotency,
- opt-out kaydı,
- müşteriler arası veri izolasyonu,
- AI global/konuşma/insan devri/stale-message kapıları,
- manuel mesaj idempotency’si,
- dosya magic-byte doğrulaması,
- responsive ekran ve overlap kontrolleri,
- FAISS arka plan arama/metadata testleri,
- React production build,
- Wrangler dry-run,
- Windows Rust compile, gerçek NSIS kurulum/çalıştırma/kaldırma yaşam döngüsü,
- Windows üzerinde paketlenmiş Wrangler OAuth runtime kanıtı.

## GitHub Actions

Zorunlu ana kapılar:

- **WPAI Quality Gates**
- **WPAI Live-like and Responsive Scenarios**
- **WPAI Windows Installer**
- **WPAI Windows Wrangler OAuth Runtime**

Eski Cloudflare Account API Token onboarding yolu ürün akışının parçası değildir. Windows kullanıcı akışı Wrangler OAuth + cihaz oturumudur.

## Production deploy

CI/CD için ayrı manuel `Deploy WPAI Production` workflow’u bulunabilir ve GitHub secretı üzerinden çalışabilir. Bu, son kullanıcı onboarding’inden bağımsızdır. Son kullanıcı Windows uygulamasında API token girmez; gerektiğinde yerel Wrangler OAuth üzerinden aynı sabit Cloudflare hesabı doğrulanır ve production runtime güncellenir.

## Windows installer

Windows workflow’ları:

1. kilitli npm bağımlılıklarını kurar ve güvenlik auditini çalıştırır,
2. FAISS sidecar test/EXE üretimini yapar,
3. TypeScript ve Rust compile/test kapılarını çalıştırır,
4. Wrangler OAuth onboarding testlerini Windows üzerinde çalıştırır,
5. generic NSIS `setup.exe` üretir; build içine kullanıcıya ait Cloudflare API tokeni gömülmez,
6. paketi gerçekten kurar, ana uygulamanın açılışını/tek örnek davranışını ve kaldırmayı doğrular,
7. kurulu pakette `oauth-device-bootstrap.mjs`, paketlenmiş Node ve Wrangler proje kaynaklarının mevcut olduğunu doğrular,
8. ürün kaynaklarında Cloudflare `apiToken` inputunun bulunmadığını ayrıca denetler.

EXE yalnız bir tarayıcı kısayolu değildir; Windows credential saklama, cihaz oturumu, yerel FAISS sidecar ve Wrangler OAuth bağlantı motoru Tauri backendinde uygulanmıştır.

## Sorun giderme

- **İnternet yok:** kayıtlı cihaz oturumu silinmez; bulut işlemleri internet gelene kadar bekler.
- **Cloudflare OAuth yok:** **Cloudflare Oturumunu Aç** düğmesine basılır; giriş Cloudflare’ın kendi tarayıcı sayfasında yapılır.
- **Eski/expired API token:** Windows onboarding bunu kullanmaz. Stale API-token ortam değişkenleri Wrangler alt sürecinden temizlenir.
- **Cihaz refresh oturumu geçersiz:** WPAI otomatik Wrangler OAuth bootstrap yoluna geri döner.
- **Meta `not_configured`:** Ayarlar → WhatsApp / Meta Bağlantısı bölümünden Meta entegrasyon bilgileri doğrulanır.
- **İlk WhatsApp mesajı gönderilemiyor:** Meta şablonu `APPROVED` değildir veya bağlantı durdurulmuştur.
- **Serbest WhatsApp mesajı engelleniyor:** müşterinin son inbound mesajından itibaren 24 saatlik pencere kapanmıştır.
- **AI yanıt vermiyor:** bu güvenli varsayılandır; global mod, konuşma modu, insan devri ve pause durumları kontrol edilmelidir.

## Veri koruma

Yönetici kişi bazında D1 verilerini dışa aktarabilir. Kalıcı silme işlemi tam telefon numarasıyla açık doğrulama ister; konuşmaya bağlı R2 dosyalarını da siler. Audit loglar secret, parola veya token içermez.

## İnternet kesintisi davranışı

İnternet kesildiğinde kayıtlı cihaz bağlantısı silinmez. Uygulama Ayarlar bölümünde bağlantının kayıtlı durumunu ve internetin beklenmekte olduğunu sade biçimde gösterir. Mesaj gönderme, kayıt değiştirme ve diğer bulut işlemleri internet yeniden gelene kadar kapalıdır.

İnternet kesintisi ayrı bir “yerel bilgi modu” açmaz; son kullanıcıya FAISS, checksum, indeks sürümü veya yerel indeks temizleme kontrolleri gösterilmez.

## 500 maddelik şartname kanıtı

Bağlayıcı şartnamenin SHA-256 değeri ve 1–500 arasındaki her madde için kaynak/test yolları `docs/SPEC-500-EVIDENCE.json` içinde tutulur. `scripts/validate_spec500.py` tam 500 kimliği, kanıt yollarını, sürüm/marka senkronizasyonunu, credential-free cihaz onboarding’ini, müşteri izolasyonunu, eğitim etki karşılaştırmasını, indeks altyapısını ve Windows paketleme kapılarını doğrular.

Ayrıntılı kılavuzlar:

- `docs/WINDOWS-KURULUM-KALDIRMA.md`
- `docs/AI-EGITIM-MERKEZI-KILAVUZU.md`
- `docs/TEST-RAPORU.md`
