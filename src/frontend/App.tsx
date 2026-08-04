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
import { AiPage, ContactsPage, DashboardPage, DesktopIndexPanel, FilesPage, KnowledgePage, NotificationsPage, ReportsPage, SettingsPage, TrainingPage, WhatsAppPage } from './pages';
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

type AuthState = { phase: 'loading' | 'setup' | 'cloudflareSetup' | 'login' | 'offline' | 'ready'; admin?: Admin };
type Toast = { message: string; kind: 'success' | 'error' | 'info' } | null;
type Branding = {
  app_name: string;
  company_name: string;
  short_description: string;
  logo_key: string | null;
  primary_color: string;
  secondary_color: string;
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

  const notify: Notify = useCallback((message, kind = 'info') => {
    setToast({ message, kind });
    window.setTimeout(() => setToast(null), 4500);
    if (desktopMode && document.hidden) {
      void desktop.notify(kind === 'error' ? 'WPAI uyarısı' : 'WPAI bildirimi', message).catch(() => undefined);
    }
  }, [desktopMode]);

  const boot = useCallback(async () => {
    if (desktopMode && !navigator.onLine) {
      setAuth({ phase: 'offline' });
      return;
    }
    try {
      const setup = await publicApi<{ required: boolean }>('/api/auth/setup-status');
      if (setup.required) {
        setAuth({ phase: desktopMode ? 'cloudflareSetup' : 'setup' });
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
      if (desktopMode && isNetworkFailure(error)) {
        setAuth({ phase: 'offline' });
        notify('Bulut bağlantısı kurulamadı. Yalnız yerel, onaylı bilgiler çevrimdışı kullanılabilir.', 'info');
        return;
      }
      notify(error instanceof Error ? error.message : 'Uygulama başlatılamadı.', 'error');
      setAuth({ phase: desktopMode ? 'cloudflareSetup' : 'login' });
    }
  }, [desktopMode, notify]);

  useEffect(() => { void boot(); }, [boot]);
  useEffect(() => {
    if (!desktopMode) return;
    const becameOnline = () => { setOnline(true); void boot(); };
    const becameOffline = () => { setOnline(false); setAuth({ phase: 'offline' }); };
    window.addEventListener('online', becameOnline);
    window.addEventListener('offline', becameOffline);
    return () => {
      window.removeEventListener('online', becameOnline);
      window.removeEventListener('offline', becameOffline);
    };
  }, [boot, desktopMode]);
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
  if (auth.phase === 'cloudflareSetup') return <><AuthCard title="WPAI İlk Kurulum" description="Cloudflare hesabını bağlayın. Uygulama eksikleri güvenli sınırlar içinde kuracak, ilk yönetici hesabını oluşturacak ve gerçek Windows girişini doğrulayacak."><CloudflareSetupForm onReady={admin => setAuth({ phase: 'ready', admin })} onLogin={() => setAuth({ phase: 'login' })} notify={notify} /></AuthCard>{authToast}</>;
  if (auth.phase === 'setup') return <><AuthCard title="İlk Yönetici Kurulumu" description="Yönetici hesabınızı oluşturun. Kurulum bir kez tamamlandıktan sonra bu ekran kapanır."><SetupForm onReady={(admin, csrf) => { setCsrfToken(csrf); setAuth({ phase: 'ready', admin }); }} notify={notify} /></AuthCard>{authToast}</>;
  if (auth.phase === 'offline') return <><OfflineDesktopPage online={online} onRetry={() => void boot()} notify={notify} />{authToast}</>;
  if (auth.phase === 'login') return <><AuthCard title="WPAI Yönetim Paneli" description={desktopMode ? 'Güvenli Windows oturumuyla giriş yapın' : 'WhatsApp görüşmeleri ve kontrollü AI yönetimi'}><LoginForm desktopMode={desktopMode} onCloudflareSetup={desktopMode ? () => setAuth({ phase: 'cloudflareSetup' }) : undefined} onReady={(admin, csrf) => { setCsrfToken(csrf); setAuth({ phase: 'ready', admin }); }} notify={notify} /></AuthCard>{authToast}</>;

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
        <div><h1>{NAV.find(item => item.id === page)?.label}</h1><p>{branding.company_name || 'Tek işletme'} · Kesin müşteri ayrımı · {desktopMode ? 'Paketlenmiş Windows istemcisi' : 'Güvenli Cloudflare altyapısı'}</p></div>
        <div className="top-actions"><span className={`pill ${health?.ok ? 'ready' : 'warn'}`}>{health?.ok ? 'Cloudflare hazır' : 'Kontrol ediliyor'}</span><span className="admin-name">{auth.admin?.name}</span><button className="button ghost" onClick={() => void logout()}>Çıkış</button></div>
      </header>
      <section className="content">
        {page === 'dashboard' && <DashboardPage notify={notify} openPage={setPage} />}
        {page === 'whatsapp' && <WhatsAppPage notify={notify} />}
        {page === 'contacts' && <ContactsPage notify={notify} />}
        {page === 'knowledge' && <KnowledgePage notify={notify} />}
        {page === 'files' && <FilesPage notify={notify} />}
        {page === 'ai' && <AiPage notify={notify} />}
        {page === 'training' && <div className="page-stack"><TrainingPage notify={notify} /><DesktopIndexPanel notify={notify} /></div>}
        {page === 'notifications' && <NotificationsPage notify={notify} />}
        {page === 'reports' && <ReportsPage notify={notify} />}
        {page === 'settings' && <SettingsPage notify={notify} health={health} />}
      </section>
    </main>
    {toast && <div className={`toast ${toast.kind}`} role="status" aria-live="polite">{toast.message}</div>}
  </div>;
}

function OfflineDesktopPage({ online, onRetry, notify }: { online: boolean; onRetry: () => void; notify: Notify }) {
  return <div className="offline-shell">
    <header className="offline-header">
      <div><span className="pill warn">Çevrimdışı</span><h1>Yerel Bilgi Modu</h1><p>Bulut verilerinin güncel olduğu iddia edilmez. Müşteri mesajı gönderme, kayıt değiştirme ve senkronizasyon işlemleri kapalıdır.</p></div>
      <button className="button primary" disabled={!online} onClick={onRetry}>{online ? 'Buluta Yeniden Bağlan' : 'İnternet Bekleniyor'}</button>
    </header>
    <main className="offline-content"><DesktopIndexPanel notify={notify} offlineOnly /></main>
  </div>;
}

function isNetworkFailure(error: unknown): boolean {
  if (typeof navigator !== 'undefined' && !navigator.onLine) return true;
  if (error instanceof TypeError) return true;
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return message.includes('failed to fetch') || message.includes('network') || message.includes('bağlantı') || message.includes('istek başarısız (0)');
}

const CLOUDFLARE_ACCOUNT_ID = 'ad8e99c82c6c17d823f6877ff1efade4';

function CloudflareSetupForm({ onReady, onLogin, notify }: { onReady: (admin: Admin) => void; onLogin: () => void; notify: Notify }) {
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState('Cloudflare hesabı henüz bağlı değil.');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const password = formValue(form, 'password');
    const confirm = formValue(form, 'confirm');
    if (password !== confirm) { notify('Parolalar eşleşmiyor.', 'error'); return; }
    setBusy(true);
    setStage('Hesap doğrulanıyor, eksik kaynaklar kuruluyor ve WPAI dağıtılıyor…');
    try {
      const email = formValue(form, 'email');
      await desktop.cloudflareSetup({
        accountId: CLOUDFLARE_ACCOUNT_ID,
        apiToken: formValue(form, 'apiToken'),
        adminName: formValue(form, 'name'),
        adminEmail: email,
        adminPassword: password
      });
      setStage('Cloudflare hazır. Gerçek Windows oturumu doğrulanıyor…');
      const session = await desktopLogin(email, password);
      await api('/api/dashboard');
      notify('Cloudflare bağlantısı, yönetici hesabı ve otomatik Windows girişi başarıyla tamamlandı.', 'success');
      onReady(session.admin);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'WPAI ilk kurulumu tamamlanamadı.';
      setStage(message);
      notify(message, 'error');
    } finally { setBusy(false); }
  }
  return <form onSubmit={submit} className="auth-form cloudflare-onboarding">
    <label>Cloudflare Account ID<input value={CLOUDFLARE_ACCOUNT_ID} readOnly /></label>
    <label>Sınırlı Cloudflare API Token<input name="apiToken" type="password" required minLength={30} autoComplete="off" placeholder="Token yalnız Windows Credential Manager'da saklanır" /></label>
    <label>Yönetici adı<input name="name" required minLength={2} /></label>
    <label>Yönetici e-postası / ID<input name="email" type="email" required autoComplete="username" /></label>
    <label>Yeni parola<input name="password" type="password" required minLength={6} autoComplete="new-password" /></label>
    <label>Parola tekrarı<input name="confirm" type="password" required minLength={6} autoComplete="new-password" /></label>
    <p className="safe-note">Token Worker'a, D1'e veya loglara yazılmaz. Yanlış D1 kimliği görülürse veri kaybını önlemek için kurulum durur.</p>
    <p role="status">{stage}</p>
    <button className="button primary" disabled={busy}>{busy ? 'Kurulum yapılıyor…' : 'Cloudflare’ı Bağla, Eksikleri Kur ve Giriş Yap'}</button>
    <button type="button" className="button secondary" disabled={busy} onClick={onLogin}>Mevcut Hesapla Giriş Yap</button>
  </form>;
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

function LoginForm({ desktopMode, onCloudflareSetup, onReady, notify }: { desktopMode: boolean; onCloudflareSetup?: (() => void) | undefined; onReady: (admin: Admin, csrf: string) => void; notify: Notify }) {
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
  return <form onSubmit={submit} className="auth-form"><label>E-posta<input name="email" type="email" required autoComplete="username" /></label><label>Parola<input name="password" type="password" required minLength={1} autoComplete="current-password" /></label>{errorMessage && <p className="safe-note" role="alert" aria-live="assertive">{errorMessage}</p>}<button className="button primary" disabled={busy}>{busy ? 'Giriş yapılıyor…' : 'Giriş Yap'}</button>{desktopMode && onCloudflareSetup && <button type="button" className="button secondary" disabled={busy} onClick={onCloudflareSetup}>Cloudflare Kurulumu ve Onarımı</button>}</form>;
}

function AuthCard({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return <Centered><section className="auth-card"><div className="auth-logo" aria-hidden="true">W</div><h1>{title}</h1><p>{description}</p>{children}</section></Centered>;
}
function Centered({ children }: { children: React.ReactNode }) { return <main className="centered">{children}</main>; }
