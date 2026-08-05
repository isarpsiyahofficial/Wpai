# WPAI

Tek işletmeye ait WhatsApp Business görüşmelerini, dosyaları, müşteri ihtiyaçlarını ve kontrollü yapay zekâ yanıtlarını Cloudflare üzerinde yöneten tam kapsamlı sistem.

## Ürün bileşenleri

- **Cloudflare Worker:** API, WhatsApp webhook, Queue tüketicileri, cron görevleri ve React asset sunumu.
- **Cloudflare D1:** konuşmaların, mesajların, müşteri notlarının, AI kararlarının ve audit kayıtlarının ana kaynağı.
- **Cloudflare R2:** konuşmaya bağlı özel görsel, PDF ve belgeler.
- **Cloudflare Queues:** inbound AI, outbound WhatsApp ve yönetici bildirimleri; ayrı DLQ’lar.
- **Workers AI + Vectorize:** onaylı işletme bilgisine dayalı production RAG ve yapılandırılmış AI kararları.
- **React yönetim paneli:** WhatsApp gelen kutusu, kişiler, bilgi bankası, dosyalar, AI kontrolü, bildirimler, raporlar ve ayarlar.
- **Tauri 2 Windows uygulaması:** production Worker’a bağlanan gerçek Windows programı ve Windows Credential Manager.
- **FAISS sidecar:** arka plandaki indeksleme ve test altyapısıdır; son kullanıcıya teknik FAISS, checksum veya yerel indeks ekranı gösterilmez.

## Temel güvenlik kuralları

**AI varsayılan kapalıdır.** Eğitim veya indeks senkronizasyonu otomatik cevap modunu kendiliğinden açmaz.

1. Her müşteri yalnız doğrulanmış `contact_id + conversation_id` ilişkisiyle işlenir.
2. AI’ın başka konuşmaları listeleme, serbest SQL çalıştırma veya farklı müşteri kimliği seçme yetkisi yoktur.
3. AI yalnız `approved` işletme bilgisi, mevcut müşteri profili, kısa özet ve son mesajlarla çalışır.
4. Fiyat, indirim ve teslim süresi D1’de doğrulanmadan gönderilemez.
5. AI ilk deployda kapalıdır. Otomatik yanıt için global ayar, konuşma modu, insan devri, pause ve güncel mesaj kapıları gönderimden hemen önce tekrar kontrol edilir.
6. R2 public değildir. Dosya erişimi yetkili Worker endpointi ve konuşma ilişkisiyle sınırlıdır.
7. Meta ve Cloudflare tokenleri kaynak koda, Git’e, D1’e veya loglara yazılmaz.
8. Cloudflare bağlantısı yalnız Ayarlar → Bağlantılar bölümünden kullanıcı tarafından kurulur, doğrulanır, güncellenir veya kaldırılır.
9. Bağlantıyı kaldırmak D1, R2, müşteri kayıtları veya konuşma geçmişini silmez.
10. Kampanya gönderim çalışma akışı ürün arayüzünden ve aktif API’den kaldırılmıştır.

## Sabit Cloudflare manifesti

| Bileşen | Değer |
|---|---|
| Account ID | `ad8e99c82c6c17d823f6877ff1efade4` |
| Worker | `wa-ai-panel` |
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
2. Cloudflare bağlantısı Windows uygulamasında Ayarlar → Bağlantılar bölümünden kullanıcı tarafından kurulur.
3. Yönetici adını, e-postasını ve kendi parolasını belirler.
4. İlk admin oluştuktan sonra bootstrap endpointi kapanır.
5. Parola Ayarlar → Parola Değiştir ekranından değiştirilebilir; diğer oturumlar iptal edilir.

## Meta WhatsApp kurulumu

Panelde **Ayarlar → Bağlantılar → WhatsApp / Meta Bağlantısı** bölümüne Meta bilgileri girilir ve gerçek Graph API isteğiyle doğrulanır. Başarılı bağlantı **Bağlı** olarak görünür ve aynı bölümden doğrulanabilir, güncellenebilir, geçici olarak durdurulabilir veya kaldırılabilir.

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

## Cloudflare bağlantı yönetimi

Windows uygulamasındaki bağlantı yaşam döngüsü:

1. Uygulama normal Ayarlar → Bağlantılar ekranını açar.
2. Kullanıcı Cloudflare API tokenini kendisi girer ve **Bağlantıyı Kur** işlemini başlatır.
3. Doğrulanan token Windows Credential Manager’da saklanır.
4. Uygulama kapatılıp yeniden açıldığında bağlantı **Bağlı** görünmeye devam eder.
5. Kullanıcı aynı bölümden **Bağlantıyı Doğrula**, **Bağlantı Bilgisini Güncelle** veya **Bağlantıyı Kaldır** işlemlerini yapabilir.
6. Bağlantıyı kaldırmak yalnız bu bilgisayardaki credential kaydını kaldırır; D1, R2, işletme bilgileri, müşteriler ve konuşmalar korunur.

Bağlantı yoksa bulut gerektiren işlemler teknik teşhis ekranı açmadan Ayarlar → Bağlantılar bölümüne yönlendirir. Uygulamada sabit Account ID alanı, altyapı tarama kartları, FAISS boyutu veya checksum gibi geliştirici ayrıntıları gösterilmez.

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
- Cloudflare bağlantısının kurulması, kalıcı tutulması, doğrulanması, güncellenmesi ve kaldırılması,
- bağlantı kaldırıldığında bulut verilerinin korunması,
- teknik yerel indeks ekranlarının son kullanıcı akışında bulunmaması,
- FAISS arka plan boyut, arama ve metadata testleri,
- React production build,
- Wrangler dry-run,
- Windows Rust compile ve NSIS `setup.exe` üretimi.

PR, `.github/workflows/ci.yml`, `.github/workflows/e2e-live-scenarios.yml` ve `.github/workflows/windows-desktop.yml` yeşil olmadan birleştirilmez.

## Production deploy

Production deploy yalnız manuel GitHub Actions workflow’u ile yapılır:

```text
Deploy WPAI Production
```

Workflow `DEPLOY-WPAI` onayı, GitHub `production` environment onayı ve `CLOUDFLARE_API_TOKEN` secretı ister. Sırasıyla bütün testleri, remote D1 migrationlarını, Worker deployunu ve gerçek `/health` kontrolünü çalıştırır.

## Windows installer

Windows workflow’u:

1. FAISS arka plan testlerini çalıştırır.
2. `faiss-service.exe` sidecarını PyInstaller ile üretir.
3. TypeScript ve Rust compile kontrolü yapar.
4. Tauri NSIS `setup.exe` üretir.
5. Gerçek kurulum, uygulamayı açma, tek örnek ve kaldırma yaşam döngüsünü doğrular.
6. Kurulum dosyasını GitHub Actions artifactı olarak yayınlar.

EXE yalnız bir tarayıcı kısayolu değildir; Windows credential saklama ve bağlantı yaşam döngüsü Tauri backendinde uygulanmıştır.

## Sorun giderme

- Bağlantı yok: Ayarlar → Bağlantılar bölümünden Cloudflare bağlantısını kurun.
- Bağlantı kayıtlı fakat doğrulanamıyor: interneti kontrol edip **Bağlantıyı Doğrula** işlemini kullanın.
- Meta `not_configured`: Ayarlar → Bağlantılar → WhatsApp / Meta Bağlantısı bölümünden bilgileri girip doğrulayın.
- İlk mesaj gönderilemiyor: Meta şablonu `APPROVED` değildir veya bağlantı durdurulmuştur.
- Serbest mesaj engelleniyor: müşterinin son inbound mesajından itibaren 24 saatlik pencere kapanmıştır.
- AI yanıt vermiyor: bu güvenli varsayılandır; global mod, konuşma modu, insan devri ve pause durumları kontrol edilmelidir.

## Veri koruma

Yönetici kişi bazında D1 verilerini dışa aktarabilir. Kalıcı silme işlemi tam telefon numarasıyla açık doğrulama ister; konuşmaya bağlı R2 dosyalarını da siler. Audit loglar secret, parola veya token içermez.

## İnternet kesintisi davranışı

İnternet kesildiğinde kayıtlı Cloudflare bağlantısı silinmez. Uygulama Ayarlar → Bağlantılar bölümünde bağlantının kayıtlı durumunu ve internetin beklenmekte olduğunu sade biçimde gösterir. Mesaj gönderme, kayıt değiştirme ve diğer bulut işlemleri internet yeniden gelene kadar kapalıdır.

İnternet kesintisi ayrı bir “yerel bilgi modu” açmaz; son kullanıcıya FAISS, checksum, indeks sürümü veya yerel indeks temizleme kontrolleri gösterilmez.

## 500 maddelik şartname kanıtı

Bağlayıcı şartnamenin SHA-256 değeri ve 1–500 arasındaki her madde için kaynak/test yolları `docs/SPEC-500-EVIDENCE.json` içinde tutulur. `scripts/validate_spec500.py` tam 500 kimliği, kanıt yollarını, sürüm/marka senkronizasyonunu, Ayarlar’a bağlı bağlantı yaşam döngüsünü, eğitim etki karşılaştırmasını, indeks altyapısını ve Windows kaldırıcı kapılarını doğrular.

Ayrıntılı kılavuzlar:

- `docs/WINDOWS-KURULUM-KALDIRMA.md`
- `docs/AI-EGITIM-MERKEZI-KILAVUZU.md`
- `docs/TEST-RAPORU.md`
