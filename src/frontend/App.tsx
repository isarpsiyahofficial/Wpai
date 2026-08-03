import { FormEvent, useCallback, useEffect, useState } from 'react';
import {
  api,
  apiObjectUrl,
  desktopLogin,
  desktopLogout,
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

type AuthState = { phase: 'loading' | 'setup' | 'desktopSetup' | 'login' | 'ready'; admin?: Admin };
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

  const notify: Notify = useCallback((message, kind = 'info') => {
    setToast({ message, kind });
    window.setTimeout(() => setToast(null), 4500);
  }, []);

  const boot = useCallback(async () => {
    try {
      const setup = await publicApi<{ required: boolean }>('/api/auth/setup-status');
      if (setup.required) {
        setAuth({ phase: desktopMode ? 'desktopSetup' : 'setup' });
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
      notify(error instanceof Error ? error.message : 'Uygulama başlatılamadı.', 'error');
      setAuth({ phase: 'login' });
    }
  }, [desktopMode, notify]);

  useEffect(() => { void boot(); }, [boot]);
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

  const logout = useCallback(async () => {
    if (desktopMode) await desktopLogout();
    else {
      try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* clear locally */ }
      setCsrfToken('');
    }
    setHealth(null);
    setAuth({ phase: 'login' });
  }, [desktopMode]);

  if (auth.phase === 'loading') return <Centered><div className="loader" /><p>Güvenli panel hazırlanıyor…</p></Centered>;
  if (auth.phase === 'desktopSetup') return <AuthCard title="İlk Kurulum Web Panelinde Yapılır" description="Güvenlik nedeniyle ilk yönetici hesabı ve kurulum anahtarı Windows uygulamasına girilemez. Önce WPAI web yönetim panelinde ilk yöneticiyi oluşturun; sonra bu uygulamada e-posta ve parolanızla giriş yapın."><button className="button secondary" onClick={() => void boot()}>Kurulum Durumunu Yeniden Kontrol Et</button></AuthCard>;
  if (auth.phase === 'setup') return <AuthCard title="İlk Yönetici Kurulumu" description="Yönetici hesabınızı oluşturun. Kurulum bir kez tamamlandıktan sonra bu ekran kapanır."><SetupForm onReady={(admin, csrf) => { setCsrfToken(csrf); setAuth({ phase: 'ready', admin }); }} notify={notify} /></AuthCard>;
  if (auth.phase === 'login') return <AuthCard title="WPAI Yönetim Paneli" description={desktopMode ? 'Güvenli Windows oturumuyla giriş yapın' : 'WhatsApp görüşmeleri ve kontrollü AI yönetimi'}><LoginForm desktopMode={desktopMode} onReady={(admin, csrf) => { setCsrfToken(csrf); setAuth({ phase: 'ready', admin }); }} notify={notify} /></AuthCard>;

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
        {page === 'training' && <TrainingPage notify={notify} />}
        {page === 'notifications' && <NotificationsPage notify={notify} />}
        {page === 'reports' && <ReportsPage notify={notify} />}
        {page === 'settings' && <SettingsPage notify={notify} health={health} />}
      </section>
    </main>
    {toast && <div className={`toast ${toast.kind}`} role="status" aria-live="polite">{toast.message}</div>}
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
  return <form onSubmit={submit} className="auth-form"><label>Ad soyad<input name="name" required minLength={2} /></label><label>E-posta<input name="email" type="email" required /></label><label>Yeni parola<input name="password" type="password" required minLength={12} /></label><label>Parola tekrarı<input name="confirm" type="password" required minLength={12} /></label><label>Kurulum anahtarı<input name="bootstrapToken" type="password" required /></label><button className="button primary" disabled={busy}>{busy ? 'Kuruluyor…' : 'Yönetici Hesabını Oluştur'}</button></form>;
}

function LoginForm({ desktopMode, onReady, notify }: { desktopMode: boolean; onReady: (admin: Admin, csrf: string) => void; notify: Notify }) {
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const email = formValue(form, 'email');
    const password = formValue(form, 'password');
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
    } catch (error) { notify(error instanceof Error ? error.message : 'Giriş başarısız.', 'error'); }
    finally { setBusy(false); }
  }
  return <form onSubmit={submit} className="auth-form"><label>E-posta<input name="email" type="email" required autoComplete="username" /></label><label>Parola<input name="password" type="password" required minLength={12} autoComplete="current-password" /></label><button className="button primary" disabled={busy}>{busy ? 'Giriş yapılıyor…' : 'Giriş Yap'}</button></form>;
}

function AuthCard({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return <Centered><section className="auth-card"><div className="auth-logo" aria-hidden="true">W</div><h1>{title}</h1><p>{description}</p>{children}</section></Centered>;
}
function Centered({ children }: { children: React.ReactNode }) { return <main className="centered">{children}</main>; }
