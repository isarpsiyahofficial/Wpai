import { FormEvent, useCallback, useEffect, useState } from 'react';
import { api, apiObjectUrl, formValue, jsonBody, publicRawJson } from '../api';
import { desktop } from '../desktop';
import type { Health, Notify } from '../types';
import { Empty, formatDate } from './core';

interface MetaStatus {
  configured: boolean;
  status: string;
  verifiedAt: string | null;
  phoneNumberIdMasked?: string;
}
interface CloudflareConnection {
  configured: boolean;
  accountId: string;
  storage: string;
}
interface Branding {
  app_name: string;
  company_name: string;
  short_description: string;
  logo_key: string | null;
  primary_color: string;
  secondary_color: string;
  updated_at: string;
}
interface CannedReply { id: string; title: string; body: string; status: string; updated_at: string }
interface DeadLetter {
  id: string;
  source_queue: string;
  payload_json: string;
  error_code: string;
  status: string;
  attempts: number;
  failed_at: string;
  retried_at: string | null;
  resolved_at: string | null;
}
interface AppSettings { aiModel?: string; embeddingModel?: string; timezone?: string }

const ACCOUNT_ID = 'ad8e99c82c6c17d823f6877ff1efade4';
const PRODUCTION_ORIGIN = 'https://wa-ai-panel.wa-ai-panel.workers.dev';

export function SettingsPage({
  notify,
  health,
  onCloudflareDisconnected
}: {
  notify: Notify;
  health: Health | null;
  onCloudflareDisconnected?: () => void;
}) {
  const isDesktop = desktop.available();
  const [meta, setMeta] = useState<MetaStatus | null>(null);
  const [cloudflare, setCloudflare] = useState<CloudflareConnection | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [branding, setBranding] = useState<Branding | null>(null);
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [replies, setReplies] = useState<CannedReply[]>([]);
  const [deadLetters, setDeadLetters] = useState<DeadLetter[]>([]);
  const [token, setToken] = useState('');
  const [showCloudflareUpdate, setShowCloudflareUpdate] = useState(false);
  const [editMeta, setEditMeta] = useState(false);
  const [deepHealth, setDeepHealth] = useState<Health | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    void Promise.all([
      api<MetaStatus>('/api/meta/status'),
      api<AppSettings>('/api/settings'),
      api<Branding>('/api/branding'),
      api<CannedReply[]>('/api/canned-replies'),
      api<DeadLetter[]>('/api/dead-letters')
    ]).then(([metaValue, settingsValue, brandingValue, replyRows, dlqRows]) => {
      setMeta(metaValue);
      setSettings(settingsValue);
      setBranding(brandingValue);
      setReplies(replyRows);
      setDeadLetters(dlqRows);
    }).catch((error: Error) => notify(error.message, 'error'));
  }, [notify]);

  const refreshCloudflareConnection = useCallback(async () => {
    if (!isDesktop) return;
    try {
      setCloudflare(await desktop.cloudflareConnectionStatus());
    } catch (error) {
      setCloudflare(null);
      notify(error instanceof Error ? error.message : 'Cloudflare bağlantı durumu okunamadı.', 'error');
    }
  }, [isDesktop, notify]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { void refreshCloudflareConnection(); }, [refreshCloudflareConnection]);
  useEffect(() => {
    let disposed = false;
    let objectUrl: string | null = null;
    if (!branding?.logo_key) {
      setLogoUrl(null);
      return;
    }
    if (!isDesktop) {
      setLogoUrl('/api/branding/logo');
      return;
    }
    void apiObjectUrl('/api/branding/logo').then(value => {
      objectUrl = value;
      if (!disposed) setLogoUrl(value);
    }).catch(() => {
      if (!disposed) setLogoUrl(null);
    });
    return () => {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [branding?.logo_key, isDesktop]);

  async function saveCloudflareConnection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!isDesktop) return;
    const apiToken = formValue(form, 'apiToken');
    setBusy(true);
    try {
      await desktop.cloudflareScan(ACCOUNT_ID, apiToken);
      form.reset();
      setToken('');
      setShowCloudflareUpdate(false);
      await refreshCloudflareConnection();
      notify('Cloudflare bağlantısı doğrulandı ve bu bilgisayarda güvenli biçimde kaydedildi.', 'success');
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Cloudflare bağlantısı kurulamadı.', 'error');
    } finally { setBusy(false); }
  }

  async function verifyCloudflareConnection() {
    if (!isDesktop) return;
    setBusy(true);
    try {
      await desktop.cloudflareScan(ACCOUNT_ID);
      await refreshCloudflareConnection();
      notify('Cloudflare bağlantısı doğrulandı.', 'success');
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Cloudflare bağlantısı doğrulanamadı.', 'error');
    } finally { setBusy(false); }
  }

  async function forgetCloudflare() {
    if (!isDesktop || !window.confirm('Bu bilgisayardaki Cloudflare bağlantısı kaldırılsın mı? D1, R2 ve müşteri verileri silinmez.')) return;
    setBusy(true);
    try {
      await desktop.cloudflareForget();
      setToken('');
      setShowCloudflareUpdate(false);
      await refreshCloudflareConnection();
      notify('Cloudflare bağlantısı kaldırıldı. Buluttaki işletme ve müşteri verileri korunuyor.', 'success');
      onCloudflareDisconnected?.();
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Cloudflare bağlantısı kaldırılamadı.', 'error');
    } finally { setBusy(false); }
  }

  async function saveMeta(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setBusy(true);
    try {
      await api('/api/meta/credentials', {
        method: 'PUT',
        ...jsonBody({
          accessToken: formValue(form, 'accessToken'),
          appSecret: formValue(form, 'appSecret'),
          phoneNumberId: formValue(form, 'phoneNumberId'),
          businessAccountId: formValue(form, 'businessAccountId'),
          verifyToken: formValue(form, 'verifyToken'),
          adminWhatsAppPhone: formValue(form, 'adminPhone') || undefined
        })
      });
      const result = await api<Record<string, string>>('/api/meta/verify', { method: 'POST' });
      form.reset();
      setEditMeta(false);
      load();
      notify(`Meta bağlantısı doğrulandı${result.displayPhoneNumber ? `: ${result.displayPhoneNumber}` : ''}.`, 'success');
    } catch (error) { notify(error instanceof Error ? error.message : 'Meta bağlantısı kurulamadı.', 'error'); }
    finally { setBusy(false); }
  }

  async function verifyMeta() {
    setBusy(true);
    try {
      const result = await api<Record<string, string>>('/api/meta/verify', { method: 'POST' });
      load();
      notify(`Meta bağlantısı doğrulandı${result.displayPhoneNumber ? `: ${result.displayPhoneNumber}` : ''}.`, 'success');
    } catch (error) { notify(error instanceof Error ? error.message : 'Meta bağlantısı doğrulanamadı.', 'error'); }
    finally { setBusy(false); }
  }

  async function pauseMeta(paused: boolean) {
    try {
      await api('/api/meta/pause', { method: 'POST', ...jsonBody({ paused }) });
      load();
      notify(paused ? 'WhatsApp gönderimi durduruldu.' : 'WhatsApp bağlantısı yeniden açıldı.', 'success');
    } catch (error) { notify(error instanceof Error ? error.message : 'Bağlantı değiştirilemedi.', 'error'); }
  }

  async function removeMeta() {
    if (!window.confirm('Meta bağlantısı kaldırılsın mı? Müşteriler ve konuşma geçmişi silinmez.')) return;
    try {
      await api('/api/meta/credentials', { method: 'DELETE' });
      setEditMeta(false);
      load();
      notify('Meta bağlantısı kaldırıldı. Müşteri ve konuşma verileri korunuyor.', 'success');
    } catch (error) { notify(error instanceof Error ? error.message : 'Meta bağlantısı kaldırılamadı.', 'error'); }
  }

  async function saveBranding(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      await api('/api/branding', {
        method: 'PUT',
        ...jsonBody({
          appName: formValue(form, 'appName'),
          companyName: formValue(form, 'companyName'),
          shortDescription: formValue(form, 'description'),
          primaryColor: formValue(form, 'primaryColor'),
          secondaryColor: formValue(form, 'secondaryColor')
        })
      });
      const value = await api<Branding>('/api/branding');
      setBranding(value);
      document.documentElement.style.setProperty('--purple', value.primary_color);
      document.documentElement.style.setProperty('--cyan', value.secondary_color);
      document.title = value.app_name;
      notify('Uygulama adı, firma bilgisi ve renkler merkezi olarak güncellendi.', 'success');
    } catch (error) { notify(error instanceof Error ? error.message : 'Marka ayarları kaydedilemedi.', 'error'); }
  }

  async function uploadLogo(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const file = (form.elements.namedItem('logo') as HTMLInputElement | null)?.files?.[0];
    if (!file) return;
    const data = new FormData(); data.set('file', file);
    try {
      await api('/api/branding/logo', { method: 'POST', body: data });
      form.reset(); load();
      notify('Logo özel R2 alanına kaydedildi.', 'success');
    } catch (error) { notify(error instanceof Error ? error.message : 'Logo yüklenemedi.', 'error'); }
  }

  async function saveReply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      await api('/api/canned-replies', {
        method: 'POST', ...jsonBody({ title: formValue(form, 'title'), body: formValue(form, 'body'), status: 'active' })
      });
      form.reset(); load(); notify('Hazır cevap oluşturuldu.', 'success');
    } catch (error) { notify(error instanceof Error ? error.message : 'Hazır cevap oluşturulamadı.', 'error'); }
  }

  async function editReply(reply: CannedReply) {
    const title = window.prompt('Hazır cevap başlığı:', reply.title)?.trim();
    if (!title) return;
    const body = window.prompt('Hazır cevap metni:', reply.body)?.trim();
    if (!body) return;
    try {
      await api(`/api/canned-replies/${reply.id}`, { method: 'PUT', ...jsonBody({ title, body, status: reply.status }) });
      load(); notify('Hazır cevap güncellendi.', 'success');
    } catch (error) { notify(error instanceof Error ? error.message : 'Hazır cevap güncellenemedi.', 'error'); }
  }

  async function disableReply(reply: CannedReply) {
    try {
      await api(`/api/canned-replies/${reply.id}`, { method: 'DELETE' });
      load(); notify('Hazır cevap devre dışı bırakıldı.', 'success');
    } catch (error) { notify(error instanceof Error ? error.message : 'Hazır cevap devre dışı bırakılamadı.', 'error'); }
  }

  async function retryDeadLetter(item: DeadLetter) {
    try {
      await api(`/api/dead-letters/${item.id}/retry`, { method: 'POST' });
      load(); notify('Başarısız iş kaynak kuyruğuna kontrollü olarak yeniden gönderildi.', 'success');
    } catch (error) { notify(error instanceof Error ? error.message : 'İş yeniden gönderilemedi.', 'error'); }
  }

  async function discardDeadLetter(item: DeadLetter) {
    if (!window.confirm('Bu başarısız iş yeniden gönderilmeden kapatılsın mı?')) return;
    try {
      await api(`/api/dead-letters/${item.id}/discard`, { method: 'POST' });
      load(); notify('Başarısız iş kapatıldı.', 'success');
    } catch (error) { notify(error instanceof Error ? error.message : 'İş kapatılamadı.', 'error'); }
  }

  async function runDeepHealth() {
    setBusy(true);
    try {
      const value = await publicRawJson<Health>('/health?deep=1');
      setDeepHealth(value);
      notify(value.ok ? 'D1, R2 ve Vectorize operasyonel sağlık kontrolü geçti.' : 'Derin sağlık kontrolünde hata bulundu.', value.ok ? 'success' : 'error');
    } catch { notify('Derin sağlık kontrolü çalıştırılamadı.', 'error'); }
    finally { setBusy(false); }
  }

  const webhook = `${isDesktop ? PRODUCTION_ORIGIN : window.location.origin}/webhooks/whatsapp`;
  const metaConnected = Boolean(meta?.configured);
  const metaPaused = meta?.status === 'paused';

  return <div className="page-stack">
    <section className="panel">
      <div className="panel-heading">
        <div><h3>Cloudflare Bağlantısı</h3><p>Cloudflare bağlantısı yalnız bu bölümden yönetilir. Kayıtlı bağlantı uygulama kapatılıp açılsa da korunur.</p></div>
        <span className={`pill ${cloudflare?.configured ? 'ready' : 'warn'}`}>{cloudflare?.configured ? 'Bağlı' : 'Bağlantı yok'}</span>
      </div>
      {!isDesktop ? <p className="safe-note">Cloudflare hesap bağlantısı WPAI Windows uygulamasındaki Ayarlar bölümünden yönetilir.</p> : cloudflare?.configured ? <>
        <div className="summary-grid">
          <div><span>Durum</span><strong>Bağlı</strong></div>
          <div><span>Saklama</span><strong>Windows güvenli depolama</strong></div>
          <div><span>Son kontrol</span><strong>{health?.ok ? 'Çalışıyor' : 'Doğrulama bekleniyor'}</strong></div>
        </div>
        <div className="form-actions">
          <button type="button" className="button secondary" disabled={busy} onClick={() => void verifyCloudflareConnection()}>{busy ? 'Doğrulanıyor…' : 'Bağlantıyı Doğrula'}</button>
          <button type="button" className="button secondary" disabled={busy} onClick={() => setShowCloudflareUpdate(value => !value)}>Bağlantı Bilgisini Güncelle</button>
          <button type="button" className="button danger-button" disabled={busy} onClick={() => void forgetCloudflare()}>Bağlantıyı Kaldır</button>
        </div>
        {showCloudflareUpdate && <form className="form-stack" onSubmit={saveCloudflareConnection}>
          <label>Yeni Cloudflare API Token<input name="apiToken" type="password" required minLength={30} autoComplete="off" value={token} onChange={event => setToken(event.target.value)} /></label>
          <p className="safe-note">Bu bağlantı cihaz oturumu ile çalışır; yönetici e-postası veya panel parolası kullanılmaz.</p>
          <div className="form-actions"><button className="button primary" disabled={busy}>Doğrula ve Güncelle</button><button type="button" className="button secondary" onClick={() => { setToken(''); setShowCloudflareUpdate(false); }}>Vazgeç</button></div>
        </form>}
      </> : <form className="form-stack" onSubmit={saveCloudflareConnection}>
        <label>Cloudflare API Token<input name="apiToken" type="password" required minLength={30} autoComplete="off" value={token} onChange={event => setToken(event.target.value)} /></label>
        <p className="safe-note">Bağlantı doğrulanınca bu bilgisayarda güvenli biçimde saklanır. Account ID ve diğer teknik kimlikler kullanıcı ekranında gösterilmez; yönetici e-postası veya panel parolası kullanılmaz.</p>
        <button className="button primary" disabled={busy}>{busy ? 'Bağlantı kuruluyor…' : 'Bağlantıyı Kur'}</button>
      </form>}
    </section>

    <section className="panel">
      <div className="panel-heading">
        <div><h3>WhatsApp / Meta Bağlantısı</h3><p>Meta bilgileri yalnız bu bölümden kurulur, güncellenir veya kaldırılır.</p></div>
        <span className={`pill ${metaConnected && !metaPaused ? 'ready' : 'warn'}`}>{metaConnected ? (metaPaused ? 'Durduruldu' : 'Bağlı') : 'Bağlantı yok'}</span>
      </div>
      <div className="webhook"><span>Webhook URL</span><code>{webhook}</code><button className="text-button" onClick={() => void navigator.clipboard.writeText(webhook)}>Kopyala</button></div>
      {metaConnected && !editMeta && <>
        <div className="summary-grid">
          <div><span>Durum</span><strong>{metaPaused ? 'Durduruldu' : 'Bağlı'}</strong></div>
          <div><span>Telefon kimliği</span><strong>{meta?.phoneNumberIdMasked || 'Kayıtlı'}</strong></div>
          <div><span>Son doğrulama</span><strong>{meta?.verifiedAt ? formatDate(meta.verifiedAt) : 'Doğrulama bekleniyor'}</strong></div>
        </div>
        <div className="form-actions">
          <button type="button" className="button secondary" disabled={busy} onClick={() => void verifyMeta()}>Bağlantıyı Doğrula</button>
          <button type="button" className="button secondary" disabled={busy} onClick={() => setEditMeta(true)}>Bağlantı Bilgisini Güncelle</button>
          {!metaPaused && <button type="button" className="button secondary" onClick={() => void pauseMeta(true)}>Bağlantıyı Durdur</button>}
          {metaPaused && <button type="button" className="button secondary" onClick={() => void pauseMeta(false)}>Yeniden Aç</button>}
          <button type="button" className="button danger-button" onClick={() => void removeMeta()}>Bağlantıyı Kaldır</button>
        </div>
      </>}
      {(!metaConnected || editMeta) && <form className="form-grid" onSubmit={saveMeta}>
        <label className="wide">Meta Access Token<input name="accessToken" type="password" required autoComplete="new-password" /></label>
        <label>App Secret<input name="appSecret" type="password" required /></label>
        <label>Webhook Verify Token<input name="verifyToken" type="password" required /></label>
        <label>Phone Number ID<input name="phoneNumberId" required /></label>
        <label>Business Account ID<input name="businessAccountId" required /></label>
        <label className="wide">Yönetici WhatsApp numarası<input name="adminPhone" placeholder="+905…" /></label>
        <div className="form-actions wide"><button className="button primary" disabled={busy}>{metaConnected ? 'Doğrula ve Güncelle' : 'Bağlantıyı Kur'}</button>{editMeta && <button type="button" className="button secondary" onClick={() => setEditMeta(false)}>Vazgeç</button>}</div>
      </form>}
    </section>

    <section className="grid-two">
      <div className="panel"><h3>Merkezi Marka Ayarları</h3>{branding && <form className="form-stack" key={branding.updated_at} onSubmit={saveBranding}><label>Uygulama adı<input name="appName" defaultValue={branding.app_name} required /></label><label>Firma adı<input name="companyName" defaultValue={branding.company_name} /></label><label>Kısa açıklama<textarea name="description" rows={3} defaultValue={branding.short_description} /></label><div className="inline-fields"><label>Ana renk<input name="primaryColor" type="color" defaultValue={branding.primary_color} /></label><label>İkinci renk<input name="secondaryColor" type="color" defaultValue={branding.secondary_color} /></label></div><button className="button primary">Markayı Kaydet</button></form>}</div>
      <div className="panel"><h3>Logo</h3><p>Logo R2’nin özel alanında saklanır; public bucket açılmaz.</p>{logoUrl && <img className="settings-logo-preview" src={logoUrl} alt="Mevcut logo" />}<form className="form-stack" onSubmit={uploadLogo}><label>Yeni logo<input name="logo" type="file" accept="image/png,image/jpeg,image/webp" required /></label><button className="button secondary">Logoyu Yükle</button></form></div>
    </section>

    <section className="panel"><h3>Hazır Cevaplar</h3><form className="form-stack" onSubmit={saveReply}><label>Başlık<input name="title" required /></label><label>Mesaj<textarea name="body" rows={5} required /></label><button className="button primary">Hazır Cevap Ekle</button></form><div className="knowledge-list">{replies.map(reply => <article key={reply.id}><div><span>{reply.status} · {formatDate(reply.updated_at)}</span><h4>{reply.title}</h4><p>{reply.body}</p></div><div className="form-actions"><button className="text-button" onClick={() => void editReply(reply)}>Düzenle</button><button className="text-button danger" onClick={() => void disableReply(reply)}>Devre Dışı</button></div></article>)}</div>{!replies.length && <Empty text="Hazır cevap yok." />}</section>

    <section className="panel"><div className="panel-heading"><div><h3>Başarısız Kuyruk İşleri</h3><p>Payload secret alanları redakte edilir. Yalnız doğrulanmış kaynak kuyruğuna kontrollü yeniden deneme yapılır.</p></div></div><div className="knowledge-list">{deadLetters.map(item => <article key={item.id}><div><span>{item.source_queue} · {item.status} · {formatDate(item.failed_at)}</span><h4>{item.error_code}</h4><pre>{safePayload(item.payload_json)}</pre><small>{item.attempts} yeniden deneme</small></div>{item.status === 'pending' && <div className="form-actions"><button className="text-button" onClick={() => void retryDeadLetter(item)}>Yeniden Dene</button><button className="text-button danger" onClick={() => void discardDeadLetter(item)}>Kapat</button></div>}</article>)}</div>{!deadLetters.length && <Empty text="Bekleyen başarısız kuyruk işi yok." />}</section>

    <section className="grid-two"><div className="panel"><div className="panel-heading"><div><h3>Sistem Durumu</h3><p>Normal health binding ve D1 durumunu gösterir.</p></div><button className="button secondary" disabled={busy} onClick={() => void runDeepHealth()}>Derin Sağlık Kontrolü</button></div><div className="key-list">{health && Object.entries(health.components).map(([key, value]) => <p key={key}><span>{key}</span><strong>{displayHealth(value)}</strong></p>)}<p><span>AI modeli</span><strong>{settings?.aiModel ?? '—'}</strong></p><p><span>Embedding modeli</span><strong>{settings?.embeddingModel ?? '—'}</strong></p><p><span>Zaman dilimi</span><strong>{settings?.timezone ?? 'Europe/Istanbul'}</strong></p></div></div>
      <div className="panel"><h3>Derin Sağlık Sonucu</h3>{deepHealth ? <><span className={`pill ${deepHealth.ok ? 'ready' : 'warn'}`}>{deepHealth.ok ? 'Operasyonel' : 'Hata var'}</span><pre>{JSON.stringify(deepHealth.components, null, 2)}</pre></> : <Empty text="R2 ve Vectorize operasyonel kontrolü henüz çalıştırılmadı." />}</div></section>
  </div>;
}

function safePayload(value: string) {
  try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return '[Payload okunamadı]'; }
}
function displayHealth(value: unknown): string {
  if (value === null) return 'Kontrol edilmedi';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
