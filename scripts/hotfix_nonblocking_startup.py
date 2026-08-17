from pathlib import Path


def replace_once(path: str, old: str, new: str, label: str) -> None:
    p = Path(path)
    text = p.read_text("utf-8")
    if old not in text:
        raise SystemExit(f"{label} anchor missing in {path}")
    p.write_text(text.replace(old, new, 1), "utf-8")


app = Path("src/frontend/App.tsx")
text = app.read_text("utf-8")
helper_anchor = """const DEFAULT_BRANDING: Branding = {
  app_name: 'WPAI Yönetim Paneli',
  company_name: '',
  short_description: 'Müşteri görüşmeleri ve yapay zekâ yönetimi',
  logo_key: null,
  primary_color: '#7657ff',
  secondary_color: '#22c7e8'
};
"""
helper = helper_anchor + """
async function settleWithin<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer = 0;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => { timer = window.setTimeout(() => reject(new Error(message)), timeoutMs); })
    ]);
  } finally {
    if (timer) window.clearTimeout(timer);
  }
}
"""
if "async function settleWithin<T>" not in text:
    if helper_anchor not in text:
        raise SystemExit("App helper anchor missing")
    text = text.replace(helper_anchor, helper, 1)

old = "      currentConnection = await desktop.cloudflareConnectionStatus();"
new = "      currentConnection = await settleWithin(desktop.cloudflareConnectionStatus(), 2500, 'Cihaz bağlantı durumu zaman aşımına uğradı.');"
if old not in text:
    raise SystemExit("App connection status anchor missing")
text = text.replace(old, new, 1)

old = """    try {
      const session = await restoreDesktopSession();
      const refreshed = await desktop.cloudflareConnectionStatus().catch(() => currentConnection);"""
new = """    try {
      const session = await settleWithin(restoreDesktopSession({ allowBootstrap: false }), 9000, 'Kayıtlı cihaz oturumu kontrolü zaman aşımına uğradı.');
      const refreshed = await desktop.cloudflareConnectionStatus().catch(() => currentConnection);"""
if old not in text:
    raise SystemExit("App saved-session anchor missing")
text = text.replace(old, new, 1)

old = """    } catch (error) {
    const message = error instanceof Error ? error.message : 'Otomatik cihaz bağlantısı kurulamadı.';
    setConnectionIssue(message);
    openConnections(currentConnection);
    notify(`Otomatik cihaz bağlantısı kurulamadı: ${message}`, 'error');
  }
"""
new = """    } catch (error) {
      const message = error instanceof Error ? error.message : 'Kayıtlı cihaz oturumu kullanılamadı.';
      const expectedFirstRun = message === 'DEVICE_SESSION_REQUIRED';
      setConnectionIssue(expectedFirstRun ? '' : message);
      openConnections(currentConnection);
      if (!expectedFirstRun) notify(`Kayıtlı cihaz oturumu kullanılamadı: ${message}`, 'error');
    }
"""
if old not in text:
    raise SystemExit("App boot catch anchor missing")
text = text.replace(old, new, 1)

text = text.replace("<p>WPAI cihaz bağlantısı hazırlanıyor…</p>", "<p>Kayıtlı cihaz oturumu kontrol ediliyor…</p>", 1)

old = """  const [busy, setBusy] = useState(false);
  const [connectionError, setConnectionError] = useState(initialError);"""
new = """  const [busy, setBusy] = useState(false);
  const [autoAttempted, setAutoAttempted] = useState(false);
  const [connectionError, setConnectionError] = useState(initialError);"""
if old not in text:
    raise SystemExit("App connection state anchor missing")
text = text.replace(old, new, 1)

oauth_anchor = "\n  async function openOauthLogin() {\n"
auto_effect = """
  useEffect(() => {
    if (!online || autoAttempted) return;
    setAutoAttempted(true);
    const timer = window.setTimeout(() => { void retryAutomaticConnection(); }, 100);
    return () => window.clearTimeout(timer);
  }, [autoAttempted, online]);

  async function openOauthLogin() {
"""
if "setAutoAttempted(true);" not in text:
    if oauth_anchor not in text:
        raise SystemExit("App OAuth function anchor missing")
    text = text.replace(oauth_anchor, "\n" + auto_effect, 1)

text = text.replace(
    "WPAI kayıtlı Wrangler oturumunu, production D1 migrasyonlarını ve Worker bağlantısını otomatik olarak doğruluyor.",
    "Ayarlar ekranı açık kalır; WPAI arka planda kayıtlı Wrangler OAuth oturumunu ve production Worker bağlantısını kısa süreli olarak doğrular. Uygulama açılışında npm kurulumu, build veya deploy çalıştırılmaz.",
    1,
)
app.write_text(text, "utf-8")

cloudflare = Path("src-tauri/src/cloudflare.rs")
text = cloudflare.read_text("utf-8")
old = """    let api_configured = load_api_token()?.is_some();
    let session_configured = has_desktop_session()?;
    let installer_activation = !activation_disabled(&app) && activation_token().is_some();
    let mode = if session_configured {
        "device_session"
    } else if api_configured {
        "cloudflare_api"
    } else if installer_activation {
        "installer_activation"
    } else {
        "none"
    };
    Ok(json!({
        "configured": api_configured || session_configured || installer_activation,
"""
new = """    let session_configured = has_desktop_session()?;
    let installer_activation = !activation_disabled(&app) && activation_token().is_some();
    let mode = if session_configured {
        "device_session"
    } else if installer_activation {
        "installer_activation"
    } else {
        "none"
    };
    Ok(json!({
        "configured": session_configured || installer_activation,
"""
if old not in text:
    raise SystemExit("cloudflare status anchor missing")
cloudflare.write_text(text.replace(old, new, 1), "utf-8")

spec = Path("scripts/validate_spec500.py")
text = spec.read_text("utf-8")
old = """        "wrangler(['login'])",
        "applyMigrations",
        "buildAndDeploy",
        "activationTicket",
        "activateDevice"
"""
new = """        "wrangler(['login']",
        "verifyWorkerHealth",
        "activationTicket",
        "activateDevice",
        "runtime', 'wrangler'"
"""
if old not in text:
    raise SystemExit("spec OAuth runtime anchor missing")
text = text.replace(old, new, 1)

old = '        "never receives administrator credentials"\n'
new = '        "never receives administrator credentials",\n        "without npm install",\n        "unhealthy production"\n'
if old not in text:
    raise SystemExit("spec OAuth test anchor missing")
text = text.replace(old, new, 1)

old = '        "Kullanıcı adı, e-posta, parola veya Cloudflare API tokeni uygulamaya girilmez."\n'
new = '        "Kullanıcı adı, e-posta, parola veya Cloudflare API tokeni uygulamaya girilmez.",\n        "restoreDesktopSession({ allowBootstrap: false })",\n        "setAutoAttempted(true)"\n'
if old not in text:
    raise SystemExit("spec App anchor missing")
text = text.replace(old, new, 1)

insert = """    forbid("desktop-bootstrap/oauth-device-bootstrap.mjs", "npm(['ci'", "buildAndDeploy", "wrangler(['deploy'", "d1', 'migrations")
    require(".github/workflows/windows-desktop.yml", "runtimeNpmInstallRequired = $false", "Packaged Wrangler runtime")
    require(".github/workflows/windows-oauth-runtime.yml", "runtimeNpmInstallRequired = $false", "runtimeDeployRequired = $false")
"""
marker = '    require("src/frontend/desktop.ts", "cloudflareAutoBootstrap", "cloudflareOauthLogin")\n'
if insert.strip() not in text:
    if marker not in text:
        raise SystemExit("spec workflow marker missing")
    text = text.replace(marker, insert + marker, 1)
spec.write_text(text, "utf-8")

auth = Path("tests/e2e/auth-regression.spec.mjs")
text = auth.read_text("utf-8")
marker = "test('an expired installer activation falls through to Wrangler OAuth rather than asking for Cloudflare credentials', async ({ page }) => {"
test_block = """test('slow automatic first-run never traps the app on the fullscreen connection loader', async ({ page }) => {
  await page.addInitScript(deviceId => {
    window.__TAURI_INTERNALS__ = {
      invoke: async command => {
        if (command === 'cloudflare_connection_status') return { configured: false, accountId: 'hidden', storage: 'Windows Credential Manager', mode: 'none', activationToken: null };
        if (command === 'get_or_create_device_id') return deviceId;
        if (command === 'load_desktop_refresh_token') return null;
        if (command === 'cloudflare_auto_bootstrap') return await new Promise(() => undefined);
        if (command === 'show_desktop_notification') return null;
        throw new Error(`Unexpected desktop command: ${command}`);
      },
      transformCallback: () => 1,
      unregisterCallback: () => undefined,
      convertFileSrc: value => value,
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main', windowLabel: 'main' } }
    };
  }, DEVICE_ID);
  await installApiMocks(page);
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'WPAI Cihaz Bağlantısı' })).toBeVisible({ timeout: 3000 });
  await expect(page.getByText('Kayıtlı cihaz oturumu kontrol ediliyor…')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Bağlanıyor…', exact: true })).toBeVisible();
  await expect(page.locator('input[name="apiToken"]')).toHaveCount(0);
});

"""
if "slow automatic first-run never traps" not in text:
    if marker not in text:
        raise SystemExit("auth regression insertion marker missing")
    text = text.replace(marker, test_block + marker, 1)
auth.write_text(text, "utf-8")

for path in ["README.md", "docs/WINDOWS-KURULUM-KALDIRMA.md"]:
    p = Path(path)
    text = p.read_text("utf-8")
    text = text.replace(
        "OAuth oturumu geçerliyse production D1 migrasyonları uygulanır, gerekli Worker sürümü deploy edilir ve cihaza bağlı kısa ömürlü aktivasyon bileti oluşturulur.",
        "OAuth oturumu geçerliyse production Worker/D1 sağlık durumu doğrulanır ve cihaza bağlı kısa ömürlü aktivasyon bileti oluşturulur. Uygulama açılışında npm kurulumu, build, migration veya deploy çalıştırılmaz.",
    )
    text = text.replace(
        "OAuth doğrulandıktan sonra WPAI gerekli production D1 migrasyonlarını ve Worker runtimeını doğrular/günceller, cihaza bağlı tek kullanımlık aktivasyon bileti üretir ve Worker’dan access/refresh cihaz oturumu alır.",
        "OAuth doğrulandıktan sonra WPAI production Worker/D1 sağlık durumunu doğrular, cihaza bağlı tek kullanımlık aktivasyon bileti üretir ve Worker’dan access/refresh cihaz oturumu alır. Production migration/deploy işleri masaüstü uygulaması açılırken çalıştırılmaz.",
    )
    p.write_text(text, "utf-8")
