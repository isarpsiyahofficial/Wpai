import { useCallback, useEffect, useState } from 'react';
import {
  api,
  apiObjectUrl,
  desktopLogout,
  downloadApiFile,
  isDesktop,
  openCloudflareBrowserLogin,
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

type AuthState = { phase: 'loading' | 'connections' | 'ready' | 'unsupported'; admin?: Admin };
type Toast = { message: string; kind: 'success' | 'error' | 'info' } | null;
type CloudflareConnection = {
  configured: boolean;
  accountId: string;
  storage: string;
  mode?: 'device_session' | 'installer_activation' | 'cloudflare_api' | 'none' | string;
};
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
  accountId: '',
  storage: 'Windows Credential Manager',
  mode: 'none'
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
  const [connectionIssue, setConnectionIssue] = useState('');

  const notify: Notify = useCallback((message, kind = 'info') => {
    setToast({ message, kind });
    window.setTimeout(() => setToast(null), 6000);
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
    } catch (error) {
      openConnections(DEFAULT_CONNECTION);
      notify(error instanceof Error ? error.message : 'Cihaz bağlantı durumu okunamadı.', 'error');
      return;
    }

    if (!navigator.onLine) {
      openConnections(currentConnection);
      return;
    }

    try {
      const session = await restoreDesktopSession();
      const refreshed = await desktop.cloudflareConnectionStatus().catch(() => currentConnection);
      setCloudflareConnection(refreshed);
      setConnectionIssue('');
      setAuth({ phase: 'ready', admin: session.admin });
    } catch (error) {
    const message = error instanceof Error ? error.message : 'Otomatik cihaz bağlantısı kurulamadı.';
    setConnectionIssue(message);
    openConnections(currentConnection);
    notify(`Otomatik cihaz bağlantısı kurulamadı: ${message}`, 'error');
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
  if (auth.phase === 'loading') return <><Centered><div className="loader" /><p>WPAI cihaz bağlantısı hazırlanıyor…</p></Centered>{authToast}</>;
  if (auth.phase === 'unsupported') return <><Centered><section className="auth-card"><div className="auth-logo" aria-hidden="true">W</div><h1>WPAI Masaüstü Uygulaması</h1><p>Bu yönetim paneli güvenli cihaz oturumu ile çalışır. Kullanıcı adı, e-posta veya parola girişi kullanılmaz.</p></section></Centered>{authToast}</>;
  if (auth.phase === 'connections') return <><DesktopConnectionsPage
    connection={cloudflareConnection}
    online={online}
    notify={notify}
    onConnectionChange={setCloudflareConnection}
    initialError={connectionIssue}
    onReady={admin => { setConnectionIssue(''); setAuth({ phase: 'ready', admin }); }}
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
        <div><h1>{NAV.find(item => item.id === page)?.label}</h1><p>{branding.company_name || 'Tek işletme'} · Kesin müşteri ayrımı · Windows cihaz oturumu</p></div>
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
  initialError,
  onReady
}: {
  connection: CloudflareConnection;
  online: boolean;
  notify: Notify;
  onConnectionChange: (connection: CloudflareConnection) => void;
  initialError: string;
  onReady: (admin: Admin) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [connectionError, setConnectionError] = useState(initialError);
  useEffect(() => { setConnectionError(initialError); }, [initialError]);

  async function refreshConnection() {
    const value = await desktop.cloudflareConnectionStatus();
    onConnectionChange(value);
    return value;
  }

  async function retryAutomaticConnection() {
    if (!online) {
      notify('İnternet bağlantısı yok. Cihaz kaydı korunuyor.', 'info');
      return;
    }
    setBusy(true);
    setConnectionError('');
    try {
      const session = await restoreDesktopSession();
      await refreshConnection();
      notify('Cihaz bağlantısı hazır.', 'success');
      onReady(session.admin);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Otomatik cihaz bağlantısı kurulamadı.';
      setConnectionError(message);
      notify(message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function openOauthLogin() {
    if (!online) {
      notify('İnternet bağlantısı yok. Cloudflare oturumu açılamıyor.', 'info');
      return;
    }
    setBusy(true);
    setConnectionError('');
    try {
      await openCloudflareBrowserLogin();
      const session = await restoreDesktopSession();
      await refreshConnection();
      notify('Cloudflare tarayıcı oturumu doğrulandı ve cihaz bağlantısı hazır.', 'success');
      onReady(session.admin);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Cloudflare tarayıcı oturumu tamamlanamadı.';
      setConnectionError(message);
      notify(message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function removeConnection() {
    if (!window.confirm('Bu bilgisayardaki cihaz bağlantısı kaldırılsın mı? D1, R2 ve müşteri verileri silinmez.')) return;
    setBusy(true);
    try {
      await desktopLogout().catch(() => undefined);
      await desktop.cloudflareForget();
      const value = await refreshConnection();
      setConnectionError('');
      notify('Bu bilgisayarın cihaz bağlantısı kaldırıldı. Buluttaki veriler korunuyor.', 'success');
      onConnectionChange(value);
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Cihaz bağlantısı kaldırılamadı.', 'error');
    } finally {
      setBusy(false);
    }
  }

  const needsOauthLogin = connectionError.includes('WRANGLER_OAUTH_REQUIRED');
  const modeText = connection.mode === 'device_session'
    ? 'Güvenli cihaz oturumu'
    : connection.mode === 'installer_activation'
      ? 'Kurulum etkinleştirmesi hazır'
      : needsOauthLogin
        ? 'Cloudflare tarayıcı oturumu gerekli'
        : connection.configured
          ? 'Cihaz bağlantısı hazır'
          : 'Otomatik bağlantı hazırlanıyor';

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark" aria-hidden="true">W</span><div><strong>WPAI Yönetim Paneli</strong><small>WhatsApp ve AI Yönetimi</small></div></div>
      <nav aria-label="Ana menü"><button className="active" aria-current="page"><span aria-hidden="true">⚙</span>Ayarlar</button></nav>
    </aside>
    <main className="main">
      <header className="topbar">
        <div><h1>Ayarlar</h1><p>Cihaz bağlantısı</p></div>
        <div className="top-actions"><span className={`pill ${connection.configured ? 'ready' : 'warn'}`}>{connection.configured ? 'Hazır' : 'Bağlantı bekleniyor'}</span></div>
      </header>
      <section className="content">
        <div className="page-stack">
          {!online && <section className="panel"><div className="panel-heading"><div><h3>İnternet bağlantısı yok</h3><p>Kayıtlı cihaz bağlantısı silinmedi. İnternet geldiğinde otomatik olarak yeniden denenecek.</p></div><span className="pill warn">Çevrimdışı</span></div></section>}
          <section className="panel">
            <div className="panel-heading">
              <div><h3>WPAI Cihaz Bağlantısı</h3><p>Uygulama önce bu bilgisayardaki mevcut Wrangler OAuth oturumunu kullanır. Kullanıcı adı, e-posta, parola veya Cloudflare API tokeni uygulamaya girilmez.</p></div>
              <span className={`pill ${connection.configured ? 'ready' : 'warn'}`}>{connection.configured ? 'Hazır' : 'Bağlantı bekleniyor'}</span>
            </div>
            <div className="summary-grid">
              <div><span>Durum</span><strong>{modeText}</strong></div>
              <div><span>Kimlik doğrulama</span><strong>Cihaza bağlı OAuth oturumu</strong></div>
              <div><span>İnternet</span><strong>{online ? 'Kullanılabilir' : 'Bağlantı bekleniyor'}</strong></div>
            </div>
            {needsOauthLogin && <p className="safe-note">Cloudflare oturumu bulunamadı. Aşağıdaki düğme Cloudflare’ın resmî giriş sayfasını varsayılan tarayıcıda açar; WPAI içine e-posta, parola veya API token girilmez.</p>}
            {!needsOauthLogin && !connection.configured && <p className="safe-note">WPAI kayıtlı Wrangler oturumunu, production D1 migrasyonlarını ve Worker bağlantısını otomatik olarak doğruluyor.</p>}
            {connectionError && !needsOauthLogin && <p className="safe-note" role="alert">{connectionError}</p>}
            <div className="form-actions">
              {needsOauthLogin
                ? <button type="button" className="button primary" disabled={busy || !online} onClick={() => void openOauthLogin()}>{busy ? 'Cloudflare açılıyor…' : 'Cloudflare Oturumunu Aç'}</button>
                : <button type="button" className="button primary" disabled={busy || !online} onClick={() => void retryAutomaticConnection()}>{busy ? 'Bağlanıyor…' : 'Cihaz Bağlantısını Yeniden Dene'}</button>}
              {connection.configured && <button type="button" className="button danger-button" disabled={busy} onClick={() => void removeConnection()}>Bu Cihazın Bağlantısını Kaldır</button>}
            </div>
          </section>
        </div>
      </section>
    </main>
  </div>;
}

function Centered({ children }: { children: React.ReactNode }) { return <main className="centered">{children}</main>; }
