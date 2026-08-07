import { FormEvent, useCallback, useEffect, useState } from 'react';
import {
  activateDesktopBootstrapSession,
  api,
  apiObjectUrl,
  desktopLogout,
  downloadApiFile,
  formValue,
  isDesktop,
  publicRawJson,
  restoreDesktopSession
} from './api';
import type { Admin, Health, Notify, PageId } from './types';
import { AiPage, ContactsPage, DashboardPage, FilesPage, KnowledgePage, NotificationsPage, ReportsPage, SettingsPage, TrainingPage, WhatsAppPage } from './pages';
import { desktop } from './desktop';

const NAV: Array<{ id: PageId; label: string; icon: string }> = [
  { id: 'dashboard', label: 'Gösterge Paneli', icon: '▦' },
  { id: 'whatsapp', label: 'WhatsApp', icon: '◉' },
  { id: 'contacts', label: 'Kişiler', icon: '♙' },
  { id: 'knowledge', label: 'Bilgi Bankası', icon: '◇' },
  { id: 'files', label: 'Dosyalar', icon: '▱' },
  { id: 'ai', label: 'AI Kontrolü', icon: '✦' },
  { id: 'training', label: 'AI Eğitim Merkezi', icon: '◈' },
  { id: 'notifications', label: 'Bildirimler', icon: '●' },
  { id: 'reports', label: 'Raporlar', icon: '⌗' },
  { id: 'settings', label: 'Ayarlar', icon: '⚙' }
];

const CLOUDFLARE_ACCOUNT_ID = 'ad8e99c82c6c17d823f6877ff1efade4';

type AuthState = { phase: 'loading' | 'connections' | 'ready' | 'unsupported'; admin?: Admin };
type Toast = { message: string; kind: 'success' | 'error' | 'info' } | null;
type CloudflareConnection = { configured: boolean; accountId: string; storage: string };
type Branding = {
  app_name: string;
  company_name: string;
  short_description: string;
  logo_key: string | null;
  primary_color: string;
  secondary_color: string;
};

const DEFAULT_CONNECTION: CloudflareConnection = {
  configured: false,
  accountId: CLOUDFLARE_ACCOUNT_ID,
  storage: 'Windows Credential Manager'
};

const DEFAULT_BRANDING: Branding = {
  app_name: 'WPAI Yönetim Paneli',
  company_name: '',
  short_description: 'Müşteri görüşmeleri ve yapay zekâ yönetimi',
  logo_key: null,
  primary_color: '#7657ff',
  secondary_color: '#22c7e8'
};

export function App() {
  const desktopMode = isDesktop();
  const browserLayoutTest = !desktopMode && import.meta.env.VITE_WPAI_E2E === '1';
  const [auth, setAuth] = useState<AuthState>({ phase: 'loading' });
  const [page, setPage] = useState<PageId>('dashboard');
  const [collapsed, setCollapsed] = useState(false);
  const [health, setHealth] = useState<Health | null>(null);
  const [branding, setBranding] = useState<Branding>(DEFAULT_BRANDING);
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast>(null);
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' ? true : navigator.onLine);
  const [cloudflareConnection, setCloudflareConnection] = useState<CloudflareConnection>(DEFAULT_CONNECTION);

  const notify: Notify = useCallback((message, kind = 'info') => {
    setToast({ message, kind });
    window.setTimeout(() => setToast(null), 4500);
    if (desktopMode && document.hidden) {
      void desktop.notify(kind === 'error' ? 'WPAI uyarısı' : 'WPAI bildirimi', message).catch(() => undefined);
    }
  }, [desktopMode]);

  const openConnections = useCallback((connection?: CloudflareConnection) => {
    if (connection) setCloudflareConnection(connection);
    setPage('settings');
    setAuth({ phase: 'connections' });
  }, []);

  const boot = useCallback(async () => {
    if (browserLayoutTest) {
      setAuth({ phase: 'ready', admin: { id: 'e2e-admin', name: 'WPAI', email: 'layout@local.invalid', role: 'owner' } });
      return;
    }
    if (!desktopMode) {
      setAuth({ phase: 'unsupported' });
      return;
    }

    let currentConnection = DEFAULT_CONNECTION;
    try {
      currentConnection = await desktop.cloudflareConnectionStatus();
      setCloudflareConnection(currentConnection);
    } catch {
      openConnections(DEFAULT_CONNECTION);
      return;
    }

    if (!currentConnection.configured || !navigator.onLine) {
      openConnections(currentConnection);
      return;
    }

    try {
      const session = await restoreDesktopSession();
      setAuth({ phase: 'ready', admin: session.admin });
    } catch {
      openConnections(currentConnection);
      notify('Bu cihazın bulut oturumu yenilenmeli. Yalnız Cloudflare API tokenini yeniden doğrulayın; e-posta veya parola gerekmiyor.', 'info');
    }
  }, [browserLayoutTest, desktopMode, notify, openConnections]);

  useEffect(() => { void boot(); }, [boot]);
  useEffect(() => {
    if (!desktopMode) return;
    const becameOnline = () => { setOnline(true); void boot(); };
    const becameOffline = () => {
      setOnline(false);
      void desktop.cloudflareConnectionStatus()
        .then(connection => openConnections(connection))
        .catch(() => openConnections(DEFAULT_CONNECTION));
    };
    window.addEventListener('online', becameOnline);
    window.addEventListener('offline', becameOffline);
    return () => {
      window.removeEventListener('online', becameOnline);
      window.removeEventListener('offline', becameOffline);
    };
  }, [boot, desktopMode, openConnections]);
  useEffect(() => {
    if (auth.phase !== 'ready') return;
    let disposed = false;
    let objectUrl: string | null = null;
    void api<Branding>('/api/branding').then(async value => {
      if (disposed) return;
      setBranding(value);
      document.documentElement.style.setProperty('--purple', value.primary_color);
      document.documentElement.style.setProperty('--cyan', value.secondary_color);
      document.title = value.app_name;
      if (value.logo_key) {
        objectUrl = desktopMode ? await apiObjectUrl('/api/branding/logo') : '/api/branding/logo';
        if (!disposed) setLogoUrl(objectUrl);
      } else {
        setLogoUrl(null);
      }
    }).catch(() => undefined);
    const refresh = () => void publicRawJson<Health>('/health')
      .then(value => setHealth(value))
      .catch(() => setHealth(null));
    refresh();
    const timer = window.setInterval(refresh, 30_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      if (desktopMode && objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [auth.phase, desktopMode]);

  useEffect(() => {
    if (!desktopMode || auth.phase !== 'ready') return;
    const intercept = (event: MouseEvent) => {
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      const target = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href^="/api/"]') : null;
      if (!target) return;
      event.preventDefault();
      const path = target.getAttribute('href');
      if (!path) return;
      const fallback = target.textContent?.replace(/^📎\s*/u, '').trim() || 'wpai-dosya';
      const fileName = target.getAttribute('download') || fallback;
      void downloadApiFile(path, fileName).catch(error => {
        notify(error instanceof Error ? error.message : 'Dosya indirilemedi.', 'error');
      });
    };
    document.addEventListener('click', intercept);
    return () => document.removeEventListener('click', intercept);
  }, [auth.phase, desktopMode, notify]);

  const authToast = toast && <div className={`toast ${toast.kind}`} role="status" aria-live="assertive">{toast.message}</div>;
  if (auth.phase === 'loading') return <><Centered><div className="loader" /><p>Güvenli panel hazırlanıyor…</p></Centered>{authToast}</>;
  if (auth.phase === 'unsupported') return <><Centered><section className="auth-card"><div className="auth-logo" aria-hidden="true">W</div><h1>WPAI Masaüstü Uygulaması</h1><p>Bu yönetim paneli cihaz oturumu ile çalışır. E-posta veya parola girişi kullanılmaz.</p></section></Centered>{authToast}</>;
  if (auth.phase === 'connections') return <><DesktopConnectionsPage
    connection={cloudflareConnection}
    online={online}
    notify={notify}
    onConnectionChange={setCloudflareConnection}
    onReady={admin => setAuth({ phase: 'ready', admin })}
  />{authToast}</>;

  const brandInitial = (branding.app_name || 'W').trim().slice(0, 1).toUpperCase();
  return <div className={`app-shell ${collapsed ? 'collapsed' : ''}`}>
    <aside className="sidebar">
      <div className="brand">
        {logoUrl ? <img className="brand-image" src={logoUrl} alt="" /> : <span className="brand-mark" aria-hidden="true">{brandInitial}</span>}
        {!collapsed && <div><strong>{branding.app_name}</strong><small>{branding.company_name || branding.short_description}</small></div>}
      </div>
      <nav aria-label="Ana menü">{NAV.map(item => <button key={item.id} aria-label={item.label} aria-current={page === item.id ? 'page' : undefined} className={page === item.id ? 'active' : ''} onClick={() => setPage(item.id)} title={item.label}><span aria-hidden="true">{item.icon}</span>{!collapsed && item.label}</button>)}</nav>
      <button className="collapse" aria-label={collapsed ? 'Menüyü genişlet' : 'Menüyü daralt'} onClick={() => setCollapsed(value => !value)}><span aria-hidden="true">{collapsed ? '›' : '‹'}</span>{!collapsed && ' Daralt'}</button>
    </aside>
    <main className="main">
      <header className="topbar">
        <div><h1>{NAV.find(item => item.id === page)?.label}</h1><p>{branding.company_name || 'Tek işletme'} · Kesin müşteri ayrımı · {desktopMode ? 'Windows uygulaması' : 'Güvenli Cloudflare altyapısı'}</p></div>
        <div className="top-actions"><span className={`pill ${health?.ok ? 'ready' : 'warn'}`}>{health?.ok ? 'Bağlı' : 'Bağlantı kontrol ediliyor'}</span><span className="admin-name">{auth.admin?.name}</span><button className="button ghost" onClick={() => openConnections(cloudflareConnection)}>Bağlantılar</button></div>
      </header>
      <section className="content">
        {page === 'dashboard' && <DashboardPage notify={notify} openPage={setPage} />}
        {page === 'whatsapp' && <WhatsAppPage notify={notify} />}
        {page === 'contacts' && <ContactsPage notify={notify} />}
        {page === 'knowledge' && <KnowledgePage notify={notify} />}
        {page === 'files' && <FilesPage notify={notify} />}
        {page === 'ai' && <AiPage notify={notify} />}
        {page === 'training' && <TrainingPage notify={notify} />}
        {page === 'notifications' && <NotificationsPage notify={notify} />}
        {page === 'reports' && <ReportsPage notify={notify} />}
        {page === 'settings' && <SettingsPage
          notify={notify}
          health={health}
          onCloudflareDisconnected={() => openConnections(DEFAULT_CONNECTION)}
        />}
      </section>
    </main>
    {toast && <div className={`toast ${toast.kind}`} role="status" aria-live="polite">{toast.message}</div>}
  </div>;
}

function DesktopConnectionsPage({
  connection,
  online,
  notify,
  onConnectionChange,
  onReady
}: {
  connection: CloudflareConnection;
  online: boolean;
  notify: Notify;
  onConnectionChange: (connection: CloudflareConnection) => void;
  onReady: (admin: Admin) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [showUpdate, setShowUpdate] = useState(connection.configured);

  async function refreshConnection() {
    const value = await desktop.cloudflareConnectionStatus();
    onConnectionChange(value);
    return value;
  }

  async function verifyConnection() {
    if (!online) {
      notify('İnternet bağlantısı yok. Kayıtlı bağlantı korunuyor.', 'info');
      return;
    }
    setBusy(true);
    try {
      await desktop.cloudflareScan(CLOUDFLARE_ACCOUNT_ID);
      await refreshConnection();
      notify('Cloudflare bağlantısı doğrulandı.', 'success');
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Cloudflare bağlantısı doğrulanamadı.', 'error');
    } finally { setBusy(false); }
  }

  async function connectWithToken(token: string) {
    const deviceId = await desktop.getOrCreateDeviceId();
    const result = await desktop.cloudflareSetup({
      accountId: CLOUDFLARE_ACCOUNT_ID,
      apiToken: token,
      deviceId
    });
    const refreshToken = result.session?.refreshToken;
    if (!refreshToken) throw new Error('Cloudflare bağlantısı kuruldu ancak cihaz oturumu oluşturulamadı [device-bootstrap-v6].');
    const session = await activateDesktopBootstrapSession(refreshToken);
    await refreshConnection();
    return session;
  }

  async function updateConnection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!online) {
      notify('İnternet bağlantısı olmadan bağlantı bilgisi güncellenemez.', 'error');
      return;
    }
    setBusy(true);
    try {
      const session = await connectWithToken(formValue(form, 'apiToken'));
      form.reset();
      setShowUpdate(false);
      notify('Cloudflare bağlantısı ve bu cihazın güvenli oturumu yenilendi.', 'success');
      onReady(session.admin);
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Cloudflare bağlantısı güncellenemedi.', 'error');
    } finally { setBusy(false); }
  }

  async function setupConnection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!online) {
      notify('İnternet bağlantısı olmadan yeni bağlantı kurulamaz.', 'error');
      return;
    }
    const form = event.currentTarget;
    setBusy(true);
    try {
      const session = await connectWithToken(formValue(form, 'apiToken'));
      notify('Cloudflare bağlantısı kuruldu. E-posta veya parola gerekmiyor.', 'success');
      onReady(session.admin);
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Cloudflare bağlantısı kurulamadı.', 'error');
    } finally { setBusy(false); }
  }

  async function removeConnection() {
    if (!window.confirm('Bu bilgisayardaki Cloudflare bağlantısı kaldırılsın mı? D1, R2 ve müşteri verileri silinmez.')) return;
    setBusy(true);
    try {
      await desktopLogout().catch(() => undefined);
      await desktop.cloudflareForget();
      const value = await refreshConnection();
      setShowUpdate(false);
      notify('Cloudflare bağlantısı bu bilgisayardan kaldırıldı. Buluttaki veriler korunuyor.', 'success');
      onConnectionChange(value);
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Cloudflare bağlantısı kaldırılamadı.', 'error');
    } finally { setBusy(false); }
  }

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark" aria-hidden="true">W</span><div><strong>WPAI Yönetim Paneli</strong><small>WhatsApp ve AI Yönetimi</small></div></div>
      <nav aria-label="Ana menü"><button className="active" aria-current="page"><span aria-hidden="true">⚙</span>Ayarlar</button></nav>
    </aside>
    <main className="main">
      <header className="topbar">
        <div><h1>Ayarlar</h1><p>Bağlantılar</p></div>
        <div className="top-actions"><span className={`pill ${connection.configured ? 'ready' : 'warn'}`}>{connection.configured ? 'Bağlı' : 'Bağlantı yok'}</span></div>
      </header>
      <section className="content">
        <div className="page-stack">
          {!online && <section className="panel"><div className="panel-heading"><div><h3>İnternet bağlantısı yok</h3><p>Kayıtlı bağlantı silinmedi. İnternet geldiğinde yeniden doğrulayabilirsiniz.</p></div><span className="pill warn">Çevrimdışı</span></div></section>}
          <section className="panel">
            <div className="panel-heading">
              <div><h3>Cloudflare Bağlantısı</h3><p>Yalnız Cloudflare API tokeni kullanılır. Yönetici e-postası, kullanıcı adı veya parola istenmez.</p></div>
              <span className={`pill ${connection.configured ? 'ready' : 'warn'}`}>{connection.configured ? 'Bağlı' : 'Bağlantı yok'}</span>
            </div>

            {connection.configured ? <>
              <div className="summary-grid">
                <div><span>Durum</span><strong>Bağlı</strong></div>
                <div><span>Kayıt</span><strong>Bu bilgisayarda güvenle saklanıyor</strong></div>
                <div><span>İnternet</span><strong>{online ? 'Kullanılabilir' : 'Bağlantı bekleniyor'}</strong></div>
              </div>
              <div className="form-actions">
                <button type="button" className="button secondary" disabled={busy || !online} onClick={() => void verifyConnection()}>{busy ? 'Doğrulanıyor…' : 'Bağlantıyı Doğrula'}</button>
                <button type="button" className="button secondary" disabled={busy} onClick={() => setShowUpdate(value => !value)}>{showUpdate ? 'Token Alanını Kapat' : 'Cihaz Oturumunu Yenile'}</button>
                <button type="button" className="button danger-button" disabled={busy} onClick={() => void removeConnection()}>Bağlantıyı Kaldır</button>
              </div>
              {showUpdate && <form className="form-stack" onSubmit={updateConnection}>
                <label>Cloudflare User veya Account API Token<input name="apiToken" type="password" required minLength={30} autoComplete="off" /></label>
                <p className="safe-note">Bu işlem yalnız tokeni doğrular ve bu cihaz için yeni güvenli oturum üretir. E-posta ve parola kullanılmaz.</p>
                <div className="form-actions"><button className="button primary" disabled={busy || !online}>{busy ? 'Bağlanıyor…' : 'Doğrula ve Panele Aç'}</button></div>
              </form>}
            </> : <form className="form-grid" onSubmit={setupConnection}>
              <label className="wide">Cloudflare User veya Account API Token<input name="apiToken" type="password" required minLength={30} autoComplete="off" /></label>
              <p className="safe-note wide">Token ID veya Global API Key kullanmayın. Bağlantı doğrulandığında token Windows Credential Manager'da, cihaz oturumu ise ayrı güvenli kayıtta saklanır. Yönetici e-postası veya parola oluşturmanız gerekmez.</p>
              <div className="form-actions wide"><button className="button primary" disabled={busy || !online}>{busy ? 'Bağlantı kuruluyor…' : 'Bağlantıyı Kur ve Panele Aç'}</button></div>
            </form>}
          </section>
        </div>
      </section>
    </main>
  </div>;
}

function Centered({ children }: { children: React.ReactNode }) { return <main className="centered">{children}</main>; }
