import { FormEvent, useCallback, useEffect, useState } from 'react';
import { api, formValue, jsonBody } from '../api';
import { desktop } from '../desktop';
import type { Health, Notify } from '../types';
import { Empty, formatDate } from './core';

interface MetaStatus { configured: boolean; status: string; verifiedAt: string | null; phoneNumberIdMasked?: string }
interface InfraComponent { key: string; label: string; status: 'ready' | 'missing' | 'misconfigured' | 'unknown' | 'blocked'; current?: string; expected?: string; repairable: boolean; details?: string }
interface InfraReport { accountId: string; accountName: string; checkedAt: string; overall: 'ready' | 'repair_required' | 'blocked'; components: InfraComponent[]; plan: Array<{ action: string; resource: string; destructive: boolean; paid: boolean }> }
interface Branding { app_name: string; company_name: string; short_description: string; logo_key: string | null; primary_color: string; secondary_color: string; updated_at: string }
interface CannedReply { id: string; title: string; body: string; status: string; updated_at: string }
interface DeadLetter { id: string; source_queue: string; payload_json: string; error_code: string; status: string; attempts: number; failed_at: string; retried_at: string | null; resolved_at: string | null }
interface AppSettings { aiModel?: string; embeddingModel?: string; timezone?: string }

const ACCOUNT_ID = 'ad8e99c82c6c17d823f6877ff1efade4';

export function SettingsPage({ notify, health }: { notify: Notify; health: Health | null }) {
  const isDesktop = desktop.available();
  const [meta, setMeta] = useState<MetaStatus | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [branding, setBranding] = useState<Branding | null>(null);
  const [replies, setReplies] = useState<CannedReply[]>([]);
  const [deadLetters, setDeadLetters] = useState<DeadLetter[]>([]);
  const [token, setToken] = useState('');
  const [infra, setInfra] = useState<InfraReport | null>(null);
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

  useEffect(() => { load(); }, [load]);

  async function saveMeta(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isDesktop) return;
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
      load();
      notify(`Meta bağlantısı doğrulandı${result.displayPhoneNumber ? `: ${result.displayPhoneNumber}` : ''}.`, 'success');
    } catch (error) { notify(error instanceof Error ? error.message : 'Meta bağlantısı kurulamadı.', 'error'); }
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
    if (isDesktop || !window.confirm('Kayıtlı Meta bilgileri kalıcı olarak silinsin mi?')) return;
    try {
      await api('/api/meta/credentials', { method: 'DELETE' });
      load();
      notify('Meta bağlantı bilgileri kaldırıldı.', 'success');
    } catch (error) { notify(error instanceof Error ? error.message : 'Meta bilgileri silinemedi.', 'error'); }
  }

  async function scan() {
    if (isDesktop) { notify('Cloudflare yönetim tokeni Windows uygulamasında kabul edilmez. Bu işlem web yönetim panelinden yapılmalıdır.', 'info'); return; }
    if (!token) { notify('Cloudflare API tokeni gerekli.', 'error'); return; }
    setBusy(true);
    try {
      const result = await api<InfraReport>('/api/cloudflare/scan', {
        method: 'POST', ...jsonBody({ accountId: ACCOUNT_ID, apiToken: token })
      });
      setInfra(result);
      notify(result.overall === 'ready' ? 'Cloudflare altyapısı hazır.' : 'Eksik veya yanlış ayarlar bulundu.', result.overall === 'ready' ? 'success' : 'info');
    } catch (error) { notify(error instanceof Error ? error.message : 'Tarama başarısız.', 'error'); }
    finally { setBusy(false); }
  }

  async function repair() {
    if (isDesktop || !infra || !token) return;
    const actions = infra.components.filter(item => item.status === 'missing' && item.repairable).map(item => item.key);
    if (!actions.length) { notify('Yalnız wa-ai-knowledge-prod veya wa-knowledge-index için güvenli oluşturma işi yok.', 'info'); return; }
    setBusy(true);
    try {
      const result = await api<{ report: InfraReport; applied: string[]; skipped: string[] }>('/api/cloudflare/repair', {
        method: 'POST', ...jsonBody({ accountId: ACCOUNT_ID, apiToken: token, actions })
      });
      setInfra(result.report);
      notify(`${result.applied.length} izinli Cloudflare bileşeni oluşturuldu.`, 'success');
    } catch (error) { notify(error instanceof Error ? error.message : 'Onarım tamamlanamadı.', 'error'); }
    finally { setBusy(false); }
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

  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const currentPassword = formValue(form, 'current');
    const newPassword = formValue(form, 'next');
    const confirm = formValue(form, 'confirm');
    if (newPassword !== confirm) { notify('Yeni parolalar eşleşmiyor.', 'error'); return; }
    try {
      await api('/api/auth/change-password', {
        method: 'POST', ...jsonBody({ currentPassword, newPassword, revokeOtherSessions: true })
      });
      form.reset(); notify('Parola değiştirildi ve diğer oturumlar kapatıldı.', 'success');
    } catch (error) { notify(error instanceof Error ? error.message : 'Parola değiştirilemedi.', 'error'); }
  }

  async function runDeepHealth() {
    setBusy(true);
    try {
      const response = await fetch('/health?deep=1', { credentials: 'include' });
      const value = await response.json() as Health;
      setDeepHealth(value);
      notify(value.ok ? 'D1, R2 ve Vectorize operasyonel sağlık kontrolü geçti.' : 'Derin sağlık kontrolünde hata bulundu.', value.ok ? 'success' : 'error');
    } catch { notify('Derin sağlık kontrolü çalıştırılamadı.', 'error'); }
    finally { setBusy(false); }
  }

  const webhook = `${window.location.origin}/webhooks/whatsapp`;
  return <div className="page-stack">
    <section className="grid-two">
      <div className="panel"><h3>Merkezi Marka Ayarları</h3>{branding && <form className="form-stack" key={branding.updated_at} onSubmit={saveBranding}><label>Uygulama adı<input name="appName" defaultValue={branding.app_name} required /></label><label>Firma adı<input name="companyName" defaultValue={branding.company_name} /></label><label>Kısa açıklama<textarea name="description" rows={3} defaultValue={branding.short_description} /></label><div className="inline-fields"><label>Ana renk<input name="primaryColor" type="color" defaultValue={branding.primary_color} /></label><label>İkinci renk<input name="secondaryColor" type="color" defaultValue={branding.secondary_color} /></label></div><button className="button primary">Markayı Kaydet</button></form>}</div>
      <div className="panel"><h3>Logo</h3><p>Logo R2’nin özel alanında saklanır; public bucket açılmaz.</p>{branding?.logo_key && <img className="settings-logo-preview" src="/api/branding/logo" alt="Mevcut logo" />}<form className="form-stack" onSubmit={uploadLogo}><label>Yeni logo<input name="logo" type="file" accept="image/png,image/jpeg,image/webp" required /></label><button className="button secondary">Logoyu Yükle</button></form></div>
    </section>

    <section className="panel"><div className="panel-heading"><div><h3>Cloudflare Kurulum ve Onarım</h3><p>Yalnız sabit hesaptaki wa-ai-knowledge-prod ve wa-knowledge-index eksikse oluşturabilir. D1, R2, Worker, mevcut Queue, DNS veya plan değiştirilmez.</p></div><span className={`pill ${infra?.overall === 'ready' ? 'ready' : 'warn'}`}>{infra?.overall === 'ready' ? 'Hazır' : infra ? 'İnceleme gerekiyor' : 'Taranmadı'}</span></div>
      {isDesktop ? <div className="summary-box"><strong>Masaüstü güvenlik sınırı</strong><p>Windows uygulaması Cloudflare API tokeni kabul etmez, saklamaz veya Worker’a iletmez. Kurulum/onarım yalnız web yönetim panelinden yapılır.</p></div> : <div className="form-grid"><label>Account ID<input value={ACCOUNT_ID} readOnly /></label><label className="wide">Sınırlı Cloudflare API Token<input type="password" value={token} onChange={event => setToken(event.target.value)} autoComplete="off" placeholder="Yalnız izinli WPAI kaynakları için" /></label><div className="form-actions wide"><button type="button" className="button secondary" onClick={() => setToken('')}>Tokeni Bellekten Sil</button><button type="button" className="button secondary" disabled={busy} onClick={() => void scan()}>{busy ? 'İşleniyor…' : 'Tam Sistem Taraması'}</button><button type="button" className="button primary" disabled={busy || !infra || infra.overall === 'ready'} onClick={() => void repair()}>Eksikleri Kur ve Onar</button></div></div>}
      <p className="safe-note">Web sürümünde token yalnız bu sayfanın belleğinde tutulur; D1, R2, log veya masaüstü credential alanına yazılmaz.</p>
      {infra && <div className="infra-grid">{infra.components.map(item => <article key={item.key} className={item.status}><span>{item.label}</span><strong>{labelStatus(item.status)}</strong>{item.current && <small>Mevcut: {item.current}</small>}{item.expected && <small>Beklenen: {item.expected}</small>}{item.details && <p>{item.details}</p>}</article>)}</div>}
    </section>

    <section className="panel"><div className="panel-heading"><div><h3>WhatsApp Business API</h3><p>Meta bağlantısı ve gönderim durumu. Secret girişi Windows uygulamasında kapalıdır.</p></div><span className={`pill ${meta?.configured && meta.status === 'configured' ? 'ready' : 'warn'}`}>{meta?.configured ? meta.status : 'Bağlantı yok'}</span></div><div className="webhook"><span>Webhook URL</span><code>{webhook}</code><button className="text-button" onClick={() => void navigator.clipboard.writeText(webhook)}>Kopyala</button></div>
      {isDesktop ? <div className="summary-box"><strong>Secret girişi devre dışı</strong><p>Meta access token, app secret ve verify token masaüstü uygulamasına girilemez. Bağlantı bilgileri yalnız web yönetim panelinden şifreli biçimde kaydedilir.</p><div className="form-actions">{meta?.configured && meta.status === 'configured' && <button className="button secondary" onClick={() => void pauseMeta(true)}>Gönderimi Durdur</button>}{meta?.configured && meta.status === 'paused' && <button className="button secondary" onClick={() => void pauseMeta(false)}>Yeniden Aç</button>}</div></div> : <form className="form-grid" onSubmit={saveMeta}><label className="wide">Meta Access Token<input name="accessToken" type="password" required autoComplete="new-password" /></label><label>App Secret<input name="appSecret" type="password" required /></label><label>Webhook Verify Token<input name="verifyToken" type="password" required /></label><label>Phone Number ID<input name="phoneNumberId" required /></label><label>Business Account ID<input name="businessAccountId" required /></label><label className="wide">Yönetici WhatsApp numarası<input name="adminPhone" placeholder="+905…" /></label><div className="form-actions wide"><button className="button primary" disabled={busy}>Kaydet ve Bağlantıyı Doğrula</button>{meta?.configured && meta.status === 'configured' && <button type="button" className="button secondary" onClick={() => void pauseMeta(true)}>Bağlantıyı Durdur</button>}{meta?.configured && meta.status === 'paused' && <button type="button" className="button secondary" onClick={() => void pauseMeta(false)}>Yeniden Aç</button>}{meta?.configured && <button type="button" className="button danger-button" onClick={() => void removeMeta()}>Bilgileri Sil</button>}</div></form>}
    </section>

    <section className="grid-two"><div className="panel"><h3>Hazır Cevaplar</h3><form className="form-stack" onSubmit={saveReply}><label>Başlık<input name="title" required /></label><label>Mesaj<textarea name="body" rows={5} required /></label><button className="button primary">Hazır Cevap Ekle</button></form><div className="knowledge-list">{replies.map(reply => <article key={reply.id}><div><span>{reply.status} · {formatDate(reply.updated_at)}</span><h4>{reply.title}</h4><p>{reply.body}</p></div><div className="form-actions"><button className="text-button" onClick={() => void editReply(reply)}>Düzenle</button><button className="text-button danger" onClick={() => void disableReply(reply)}>Devre Dışı</button></div></article>)}</div>{!replies.length && <Empty text="Hazır cevap yok." />}</div>
      <div className="panel"><h3>Parola Değiştir</h3><form className="form-stack" onSubmit={changePassword}><label>Mevcut parola<input name="current" type="password" required /></label><label>Yeni parola<input name="next" type="password" minLength={12} required /></label><label>Yeni parola tekrarı<input name="confirm" type="password" minLength={12} required /></label><button className="button primary">Parolayı Değiştir</button></form></div></section>

    <section className="panel"><div className="panel-heading"><div><h3>Başarısız Kuyruk İşleri</h3><p>Payload secret alanları redakte edilir. Yalnız doğrulanmış kaynak kuyruğuna kontrollü yeniden deneme yapılır.</p></div></div><div className="knowledge-list">{deadLetters.map(item => <article key={item.id}><div><span>{item.source_queue} · {item.status} · {formatDate(item.failed_at)}</span><h4>{item.error_code}</h4><pre>{safePayload(item.payload_json)}</pre><small>{item.attempts} yeniden deneme</small></div>{item.status === 'pending' && <div className="form-actions"><button className="text-button" onClick={() => void retryDeadLetter(item)}>Yeniden Dene</button><button className="text-button danger" onClick={() => void discardDeadLetter(item)}>Kapat</button></div>}</article>)}</div>{!deadLetters.length && <Empty text="Bekleyen başarısız kuyruk işi yok." />}</section>

    <section className="grid-two"><div className="panel"><div className="panel-heading"><div><h3>Sistem Durumu</h3><p>Normal health binding ve D1 durumunu gösterir.</p></div><button className="button secondary" disabled={busy} onClick={() => void runDeepHealth()}>Derin Sağlık Kontrolü</button></div><div className="key-list">{health && Object.entries(health.components).map(([key, value]) => <p key={key}><span>{key}</span><strong>{displayHealth(value)}</strong></p>)}<p><span>AI modeli</span><strong>{settings?.aiModel ?? '—'}</strong></p><p><span>Embedding modeli</span><strong>{settings?.embeddingModel ?? '—'}</strong></p><p><span>Zaman dilimi</span><strong>{settings?.timezone ?? 'Europe/Istanbul'}</strong></p></div></div>
      <div className="panel"><h3>Derin Sağlık Sonucu</h3>{deepHealth ? <><span className={`pill ${deepHealth.ok ? 'ready' : 'warn'}`}>{deepHealth.ok ? 'Operasyonel' : 'Hata var'}</span><pre>{JSON.stringify(deepHealth.components, null, 2)}</pre></> : <Empty text="R2 ve Vectorize operasyonel kontrolü henüz çalıştırılmadı." />}</div></section>
  </div>;
}

function labelStatus(status: InfraComponent['status']) {
  return status === 'ready' ? 'Hazır' : status === 'missing' ? 'Eksik' : status === 'misconfigured' ? 'Yanlış ayar' : status === 'blocked' ? 'Yetki gerekli' : 'Doğrulanamadı';
}
function safePayload(value: string) {
  try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return '[Payload okunamadı]'; }
}
function displayHealth(value: unknown): string {
  if (value === null) return 'Kontrol edilmedi';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
