# WPAI

Tek işletmeye ait WhatsApp Business görüşmelerini, dosyaları, müşteri ihtiyaçlarını ve kontrollü yapay zekâ yanıtlarını Cloudflare üzerinde yöneten tam kapsamlı sistem.

## Ürün bileşenleri

- **Cloudflare Worker:** API, WhatsApp webhook, Queue tüketicileri, cron görevleri ve React asset sunumu.
- **Cloudflare D1:** konuşmaların, mesajların, müşteri notlarının, AI kararlarının ve audit kayıtlarının ana kaynağı.
- **Cloudflare R2:** konuşmaya bağlı özel görsel, PDF ve belgeler.
- **Cloudflare Queues:** inbound AI, outbound WhatsApp ve yönetici bildirimleri; ayrı DLQ’lar.
- **Workers AI + Vectorize:** onaylı işletme bilgisine dayalı production RAG ve yapılandırılmış AI kararları.
- **React yönetim paneli:** WhatsApp gelen kutusu, kişiler, bilgi bankası, dosyalar, AI kontrolü, bildirimler, raporlar ve ayarlar.
- **Tauri 2 Windows uygulaması:** production Worker’a bağlanan gerçek Windows programı, Windows Credential Manager ve yerel FAISS sidecar.
- **FAISS sidecar:** yerel eğitim önizlemesi ve çevrimdışı vektör araması; son kullanıcı Python kurmaz.

## Temel güvenlik kuralları

1. Her müşteri yalnız doğrulanmış `contact_id + conversation_id` ilişkisiyle işlenir.
2. AI’ın başka konuşmaları listeleme, serbest SQL çalıştırma veya farklı müşteri kimliği seçme yetkisi yoktur.
3. AI yalnız `approved` işletme bilgisi, mevcut müşteri profili, kısa özet ve son mesajlarla çalışır.
4. Fiyat, indirim ve teslim süresi D1’de doğrulanmadan gönderilemez.
5. AI ilk deployda kapalıdır. Otomatik yanıt için global ayar, konuşma modu, insan devri, pause ve güncel mesaj kapıları gönderimden hemen önce tekrar kontrol edilir.
6. R2 public değildir. Dosya erişimi yetkili Worker endpointi ve konuşma ilişkisiyle sınırlıdır.
7. Meta ve Cloudflare tokenleri kaynak koda, Git’e, D1’e veya loglara yazılmaz.
8. Cloudflare onarım motoru kaynak silmez, DNS değiştirmez, ücretli plan açmaz ve proje dışı kaynaklara dokunmaz.
9. Kampanya gönderim çalışma akışı ürün arayüzünden ve aktif API’den kaldırılmıştır.

## Sabit Cloudflare manifesti

| Bileşen | Değer |
|---|---|
| Account ID | `ad8e99c82c6c17d823f6877ff1efade4` |
| Worker | `wa-ai-panel` |
| D1 | `wa-ai-prod` |
| D1 ID | `81983219-f57b-487b-8144-7c70bf9b1fe2` |
| R2 | `wa-ai-files-prod` |
| Vectorize | `wpai-knowledge` |
| Inbound Queue | `wa-inbound-ai` |
| Outbound Queue | `wa-outbound` |
| Admin Queue | `wa-admin-notify` |
| AI DLQ | `wa-ai-dlq` |
| Outbound DLQ | `wa-outbound-dlq` |

Ayarlar → Cloudflare Kurulum ve Onarım ekranı bu manifesti gerçek hesapla karşılaştırır. Aynı adlı fakat farklı kimlikteki D1 gibi riskli sapmalar otomatik düzeltilmez; veri kaybını önlemek için incelemeye bırakılır.

## Gereksinimler

- Node.js 22+
- npm 10+
- Wrangler 4.x
- Python 3.12 (yalnız FAISS sidecar build/test)
- Rust stable ve Windows WebView2 (Windows installer build)

## Yerel geliştirme

```bash
npm install
npm run types
npm run db:local
npm run dev
```

Vite: `http://localhost:5173`  
Worker: `http://localhost:8787`

## Secret kurulumu

Production secretları GitHub veya Cloudflare secret yönetiminde tutulur:

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

`SESSION_SIGNING_KEY`, `DATA_ENCRYPTION_KEY` ve `ADMIN_BOOTSTRAP_TOKEN` kriptografik olarak güvenli rastgele değerler olmalıdır. Gerçek değerler `.dev.vars.example` dosyasına dahi yazılmaz.

## İlk yönetici kurulumu

1. Secret olarak `ADMIN_BOOTSTRAP_TOKEN` tanımlanır.
2. Panel açıldığında aktif admin yoksa ilk kurulum ekranı görünür.
3. Yönetici adını, e-postasını ve kendi parolasını belirler.
4. İlk admin oluştuktan sonra bootstrap endpointi kapanır.
5. Parola Ayarlar → Parola Değiştir ekranından değiştirilebilir; diğer oturumlar iptal edilir.

## Meta WhatsApp kurulumu

Panelde Ayarlar → WhatsApp Business API bölümüne Meta bilgileri girilir ve gerçek Graph API isteğiyle doğrulanır.

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
- Windows uygulamasında aynı eğitim yerel FAISS’e de yazılabilir.
- Müşteriden gelen hiçbir iddia otomatik genel bilgiye dönüştürülmez.

## Cloudflare kurulum ve onarım

Panelin Cloudflare yönetim ekranı:

- tokeni ve Account ID’yi doğrular,
- D1, R2, Queue, Worker ve Vectorize durumunu tarar,
- yalnız eksik ve güvenle oluşturulabilir WPAI kaynaklarını kurar,
- yanlış D1 kimliği veya yanlış vektör boyutu gibi riskli durumları otomatik değiştirmez,
- kaynak silme, DNS, domain ve ücretli plan işlemlerini yapmaz.

Web sürümünde token yalnız sayfa belleğinde tutulur. Windows sürümünde kullanıcı seçerse Windows Credential Manager’da saklanır.

## Testler ve kalite kapıları

```bash
npm run security:scan
npm run validate
npm run typecheck
npm run test:unit
npm run test:worker
npm run build
npm run deploy:dry
python -m pytest -q sidecar/test_faiss_service.py
```

Zorunlu test kapsamı:

- telefon normalizasyonu,
- API schema doğrulaması,
- D1 migration ve foreign key kontrolü,
- auth, CSRF, parola değişimi ve session iptali,
- webhook imzası ve tekrar mesaj idempotency’si,
- opt-out kaydı,
- müşteriler arası veri izolasyonu,
- AI global/konuşma/insan devri/stale-message kapıları,
- manuel mesaj idempotency’si,
- dosya magic-byte doğrulaması,
- Cloudflare yıkıcı olmayan onarım sınırı,
- FAISS boyut, arama ve metadata testleri,
- React production build,
- Wrangler dry-run,
- Windows Rust compile ve NSIS `setup.exe` üretimi.

PR, `.github/workflows/ci.yml` ve `.github/workflows/windows-desktop.yml` yeşil olmadan birleştirilmez.

## Production deploy

Production deploy yalnız manuel GitHub Actions workflow’u ile yapılır:

```text
Deploy WPAI Production
```

Workflow `DEPLOY-WPAI` onayı, GitHub `production` environment onayı ve `CLOUDFLARE_API_TOKEN` secretı ister. Sırasıyla bütün testleri, remote D1 migrationlarını, Worker deployunu ve gerçek `/health` kontrolünü çalıştırır.

## Windows installer

Windows workflow’u:

1. FAISS testlerini çalıştırır.
2. `faiss-service.exe` sidecarını PyInstaller ile üretir.
3. TypeScript ve Rust compile kontrolü yapar.
4. Tauri NSIS `setup.exe` üretir.
5. Kurulum dosyasını GitHub Actions artifactı olarak yayınlar.

EXE yalnız bir tarayıcı kısayolu değildir; güvenli Windows credential saklama ve yerel FAISS komutları Tauri backendinde uygulanmıştır.

## Sorun giderme

- `/health` 503: D1 veya zorunlu bindinglerden biri çalışmıyordur.
- Meta `not_configured`: Ayarlar ekranından Meta bilgileri girilip doğrulanmalıdır.
- İlk mesaj gönderilemiyor: Meta şablonu `APPROVED` değildir veya bağlantı durdurulmuştur.
- Serbest mesaj engelleniyor: müşterinin son inbound mesajından itibaren 24 saatlik pencere kapanmıştır.
- AI yanıt vermiyor: bu güvenli varsayılandır; global mod, konuşma modu, insan devri ve pause durumları kontrol edilmelidir.
- Cloudflare onarımı bir bileşeni atlıyor: bileşen yıkıcı işlem veya manuel inceleme gerektiriyordur.

## Veri koruma

Yönetici kişi bazında D1 verilerini dışa aktarabilir. Kalıcı silme işlemi tam telefon numarasıyla açık doğrulama ister; konuşmaya bağlı R2 dosyalarını da siler. Audit loglar secret, parola veya token içermez.
