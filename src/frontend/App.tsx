import { FormEvent, useCallback, useEffect, useState } from 'react';
import {
  api,
  apiObjectUrl,
  desktopLogin,
  desktopLogout,
  downloadApiFile,
  formValue,
  isDesktop,
  jsonBody,
  publicApi,
  publicRawJson,
  restoreDesktopSession,
  setCsrfToken
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

type AuthState = { phase: 'loading' | 'setup' | 'connections' | 'login' | 'ready'; admin?: Admin };
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
    let currentConnection = DEFAULT_CONNECTION;
    if (desktopMode) {
      try {
        const connection = await desktop.cloudflareConnectionStatus();
        currentConnection = connection;
        setCloudflareConnection(connection);
        if (!connection.configured || !navigator.onLine) {
          openConnections(connection);
          return;
        }
      } catch {
        openConnections(DEFAULT_CONNECTION);
        return;
      }
    }

    try {
      const setup = await publicApi<{ required: boolean }>('/api/auth/setup-status');
      if (setup.required) {
        if (desktopMode) openConnections(currentConnection);
        else setAuth({ phase: 'setup' });
        return;
      }
      if (desktopMode) {
        try {
          const session = await restoreDesktopSession();
          setAuth({ phase: 'ready', admin: session.admin });
        } catch {
          setAuth({ phase: 'login' });
        }
        return;
      }
      try {
        const me = await api<{ admin: Admin; csrfToken: string }>('/api/auth/me');
        setCsrfToken(me.csrfToken);
        setAuth({ phase: 'ready', admin: me.admin });
      } catch {
        setAuth({ phase: 'login' });
      }
    } catch (error) {
      if (desktopMode) {
        openConnections(currentConnection);
        notify('Bulut bağlantısı doğrulanamadı. Ayarlar > Bağlantılar bölümünü kontrol edin.', 'info');
        return;
      }
      notify(error instanceof Error ? error.message : 'Uygulama başlatılamadı.', 'error');
      setAuth({ phase: 'login' });
    }
  }, [desktopMode, notify, openConnections]);

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

  const logout = useCallback(async () => {
    if (desktopMode) await desktopLogout();
    else {
      try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* clear locally */ }
      setCsrfToken('');
    }
    setHealth(null);
    setAuth({ phase: 'login' });
  }, [desktopMode]);

  const authToast = toast && <div className={`toast ${toast.kind}`} role="status" aria-live="assertive">{toast.message}</div>;
  if (auth.phase === 'loading') return <><Centered><div className="loader" /><p>Güvenli panel hazırlanıyor…</p></Centered>{authToast}</>;
  if (auth.phase === 'connections') return <><DesktopConnectionsPage
    connection={cloudflareConnection}
    online={online}
    notify={notify}
    onConnectionChange={setCloudflareConnection}
    onLogin={() => setAuth({ phase: 'login' })}
    onReady={admin => setAuth({ phase: 'ready', admin })}
  />{authToast}</>;
  if (auth.phase === 'setup') return <><AuthCard title="İlk Yönetici Kurulumu" description="Yönetici hesabınızı oluşturun. Kurulum bir kez tamamlandıktan sonra bu ekran kapanır."><SetupForm onReady={(admin, csrf) => { setCsrfToken(csrf); setAuth({ phase: 'ready', admin }); }} notify={notify} /></AuthCard>{authToast}</>;
  if (auth.phase === 'login') return <><AuthCard title="WPAI Yönetim Paneli" description={desktopMode ? 'Güvenli Windows oturumuyla giriş yapın' : 'WhatsApp görüşmeleri ve kontrollü AI yönetimi'}><LoginForm desktopMode={desktopMode} onReady={(admin, csrf) => { setCsrfToken(csrf); setAuth({ phase: 'ready', admin }); }} notify={notify} /></AuthCard>{authToast}</>;

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
        <div className="top-actions"><span className={`pill ${health?.ok ? 'ready' : 'warn'}`}>{health?.ok ? 'Bağlı' : 'Bağlantı kontrol ediliyor'}</span><span className="admin-name">{auth.admin?.name}</span><button className="button ghost" onClick={() => void logout()}>Çıkış</button></div>
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
  onLogin,
  onReady
}: {
  connection: CloudflareConnection;
  online: boolean;
  notify: Notify;
  onConnectionChange: (connection: CloudflareConnection) => void;
  onLogin: () => void;
  onReady: (admin: Admin) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [showUpdate, setShowUpdate] = useState(false);

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

  async function updateConnection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!online) {
      notify('İnternet bağlantısı olmadan bağlantı bilgisi güncellenemez.', 'error');
      return;
    }
    setBusy(true);
    try {
      await desktop.cloudflareScan(CLOUDFLARE_ACCOUNT_ID, formValue(form, 'apiToken'));
      form.reset();
      setShowUpdate(false);
      await refreshConnection();
      notify('Cloudflare bağlantısı güncellendi ve güvenli biçimde kaydedildi.', 'success');
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
    const password = formValue(form, 'password');
    if (password !== formValue(form, 'confirm')) {
      notify('Parolalar eşleşmiyor.', 'error');
      return;
    }
    setBusy(true);
    try {
      const email = formValue(form, 'email');
      await desktop.cloudflareSetup({
        accountId: CLOUDFLARE_ACCOUNT_ID,
        apiToken: formValue(form, 'apiToken'),
        adminName: formValue(form, 'name'),
        adminEmail: email,
        adminPassword: password
      });
      await refreshConnection();
      const session = await desktopLogin(email, password);
      notify('Cloudflare bağlantısı kuruldu ve bağlı olarak kaydedildi.', 'success');
      onReady(session.admin);
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Cloudflare bağlantısı kurulamadı.', 'error');
    } finally { setBusy(false); }
  }

  async function removeConnection() {
    if (!window.confirm('Bu bilgisayardaki Cloudflare bağlantısı kaldırılsın mı? D1, R2 ve müşteri verileri silinmez.')) return;
    setBusy(true);
    try {
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
              <div><h3>Cloudflare Bağlantısı</h3><p>Bağlantı yalnız bu Ayarlar ekranından kurulur, güncellenir veya kaldırılır.</p></div>
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
                <button type="button" className="button secondary" disabled={busy} onClick={() => setShowUpdate(value => !value)}>Bağlantı Bilgisini Güncelle</button>
                <button type="button" className="button primary" disabled={busy || !online} onClick={onLogin}>Panele Giriş Yap</button>
                <button type="button" className="button danger-button" disabled={busy} onClick={() => void removeConnection()}>Bağlantıyı Kaldır</button>
              </div>
              {showUpdate && <form className="form-stack" onSubmit={updateConnection}>
                <label>Yeni Cloudflare API Token<input name="apiToken" type="password" required minLength={30} autoComplete="off" /></label>
                <div className="form-actions"><button className="button primary" disabled={busy || !online}>Doğrula ve Güncelle</button><button type="button" className="button secondary" onClick={() => setShowUpdate(false)}>Vazgeç</button></div>
              </form>}
            </> : <form className="form-grid" onSubmit={setupConnection}>
              <label className="wide">Cloudflare API Token<input name="apiToken" type="password" required minLength={30} autoComplete="off" /></label>
              <label>Yönetici adı<input name="name" required minLength={2} /></label>
              <label>Yönetici e-postası<input name="email" type="email" required autoComplete="username" /></label>
              <label>Yeni parola<input name="password" type="password" required minLength={6} autoComplete="new-password" /></label>
              <label>Parola tekrarı<input name="confirm" type="password" required minLength={6} autoComplete="new-password" /></label>
              <p className="safe-note wide">Bağlantı doğrulandığında bu bilgisayarda güvenli biçimde saklanır. Uygulamayı kapatıp açtığınızda bağlı kalır.</p>
              <div className="form-actions wide"><button className="button primary" disabled={busy || !online}>{busy ? 'Bağlantı kuruluyor…' : 'Bağlantıyı Kur'}</button></div>
            </form>}
          </section>
        </div>
      </section>
    </main>
  </div>;
}

function SetupForm({ onReady, notify }: { onReady: (admin: Admin, csrf: string) => void; notify: Notify }) {
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const password = formValue(form, 'password');
    const confirm = formValue(form, 'confirm');
    if (password !== confirm) { notify('Parolalar eşleşmiyor.', 'error'); return; }
    setBusy(true);
    try {
      const result = await publicApi<{ admin: Admin; csrfToken: string }>('/api/auth/setup', {
        method: 'POST',
        ...jsonBody({ name: formValue(form, 'name'), email: formValue(form, 'email'), password, bootstrapToken: formValue(form, 'bootstrapToken') })
      });
      onReady(result.admin, result.csrfToken);
    } catch (error) { notify(error instanceof Error ? error.message : 'Kurulum tamamlanamadı.', 'error'); }
    finally { setBusy(false); }
  }
  return <form onSubmit={submit} className="auth-form"><label>Ad soyad<input name="name" required minLength={2} /></label><label>E-posta<input name="email" type="email" required /></label><label>Yeni parola<input name="password" type="password" required minLength={6} /></label><label>Parola tekrarı<input name="confirm" type="password" required minLength={6} /></label><label>Kurulum anahtarı<input name="bootstrapToken" type="password" required /></label><button className="button primary" disabled={busy}>{busy ? 'Kuruluyor…' : 'Yönetici Hesabını Oluştur'}</button></form>;
}

function LoginForm({ desktopMode, onReady, notify }: { desktopMode: boolean; onReady: (admin: Admin, csrf: string) => void; notify: Notify }) {
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const email = formValue(form, 'email');
    const password = formValue(form, 'password');
    setErrorMessage('');
    setBusy(true);
    try {
      if (desktopMode) {
        const session = await desktopLogin(email, password);
        onReady(session.admin, '');
      } else {
        const result = await publicApi<{ admin: Admin; csrfToken: string }>('/api/auth/login', {
          method: 'POST',
          ...jsonBody({ email, password })
        });
        onReady(result.admin, result.csrfToken);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Giriş başarısız.';
      setErrorMessage(message);
      notify(message, 'error');
    }
    finally { setBusy(false); }
  }
  return <form onSubmit={submit} className="auth-form"><label>E-posta<input name="email" type="email" required autoComplete="username" /></label><label>Parola<input name="password" type="password" required minLength={1} autoComplete="current-password" /></label>{errorMessage && <p className="safe-note" role="alert" aria-live="assertive">{errorMessage}</p>}<button className="button primary" disabled={busy}>{busy ? 'Giriş yapılıyor…' : 'Giriş Yap'}</button></form>;
}

function AuthCard({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return <Centered><section className="auth-card"><div className="auth-logo" aria-hidden="true">W</div><h1>{title}</h1><p>{description}</p>{children}</section></Centered>;
}
function Centered({ children }: { children: React.ReactNode }) { return <main className="centered">{children}</main>; }
