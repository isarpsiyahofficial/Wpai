import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, jsonBody } from '../api';
import type { ConversationDetail, ConversationListItem, Notify } from '../types';
import { Empty, formatDate } from './core';
import { desktop } from '../desktop';

type Template = { id: string; meta_name: string; language_code: string; category: string | null; status: string; components_json: string };
type CannedReply = { id: string; title: string; body: string; status: string };
type Note = { id: string; source: string; note_text: string; created_at: string; updated_at: string };
type Requirements = {
  sector?: string | null;
  website_type?: string | null;
  requested_pages_json?: string;
  admin_panel_required?: number | null;
  catalog_required?: number | null;
  ecommerce_required?: number | null;
  multilanguage_required?: number | null;
  domain_status?: string | null;
  hosting_status?: string | null;
  design_preferences?: string | null;
  reference_websites_json?: string;
  budget_min?: number | null;
  budget_max?: number | null;
  currency_code?: string | null;
  delivery_expectation?: string | null;
  quoted_price?: number | null;
  discount_amount?: number | null;
  payment_expectation?: string | null;
  next_action?: string | null;
  lead_stage?: string | null;
};
type Suggestion = { action: string; reply: string; confidence: number; needsHuman: boolean; intent: string; sent: false };

export function WhatsAppPage({ notify }: { notify: Notify }) {
  const [items, setItems] = useState<ConversationListItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [cannedReplies, setCannedReplies] = useState<CannedReply[]>([]);
  const [messageText, setMessageText] = useState('');
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const loadList = useCallback(() => {
    void api<ConversationListItem[]>(`/api/conversations?q=${encodeURIComponent(query)}`)
      .then(rows => {
        setItems(rows);
        setSelectedId(current => current ?? rows[0]?.id ?? null);
      })
      .catch((error: Error) => notify(error.message, 'error'));
  }, [query, notify]);

  const loadDetail = useCallback((id: string) => {
    void api<ConversationDetail>(`/api/conversations/${id}`)
      .then(value => {
        setDetail(value);
        void api(`/api/conversations/${id}/read`, { method: 'POST' }).catch(() => undefined);
      })
      .catch((error: Error) => notify(error.message, 'error'));
  }, [notify]);

  const loadTools = useCallback(() => {
    void Promise.all([
      api<Template[]>('/api/templates'),
      api<CannedReply[]>('/api/canned-replies')
    ]).then(([templateRows, replies]) => {
      setTemplates(templateRows);
      setCannedReplies(replies.filter(item => item.status === 'active'));
    }).catch(() => undefined);
  }, []);

  useEffect(() => {
    loadList();
    const timer = window.setInterval(loadList, 5000);
    return () => window.clearInterval(timer);
  }, [loadList]);
  useEffect(() => {
    if (!selectedId) { setDetail(null); return; }
    setSuggestion(null);
    setMessageText('');
    loadDetail(selectedId);
    const timer = window.setInterval(() => loadDetail(selectedId), 5000);
    return () => window.clearInterval(timer);
  }, [selectedId, loadDetail]);
  useEffect(() => { loadTools(); }, [loadTools]);

  const selected = useMemo(() => items.find(item => item.id === selectedId) ?? null, [items, selectedId]);
  const approvedTemplates = useMemo(() => templates.filter(item => item.status === 'APPROVED'), [templates]);
  const notes = (detail?.notes ?? []) as unknown as Note[];
  const requirements = (detail?.requirements ?? {}) as Requirements;

  async function sendText(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedId || !messageText.trim()) return;
    setBusy(true);
    try {
      await api('/api/messages/text', {
        method: 'POST',
        ...jsonBody({ conversationId: selectedId, text: messageText.trim(), clientRequestId: crypto.randomUUID() })
      });
      setMessageText('');
      setSuggestion(null);
      loadDetail(selectedId);
      loadList();
      notify('Mesaj gönderim kuyruğuna alındı ve konuşma insan devrine geçti.', 'success');
    } catch (error) { notify(error instanceof Error ? error.message : 'Mesaj gönderilemedi.', 'error'); }
    finally { setBusy(false); }
  }

  async function upload(file: File) {
    if (!selectedId) return;
    setBusy(true);
    try {
      const data = new FormData();
      data.set('file', file);
      await api(`/api/conversations/${selectedId}/attachments`, { method: 'POST', body: data });
      loadDetail(selectedId);
      notify('Dosya gönderim kuyruğuna alındı.', 'success');
    } catch (error) { notify(error instanceof Error ? error.message : 'Dosya gönderilemedi.', 'error'); }
    finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function chooseAttachment() {
    if (desktop.available()) {
      try {
        const selected = await desktop.pickFile();
        if (!selected) return;
        await upload(new File([new Uint8Array(selected.bytes)], selected.name, { type: selected.mimeType }));
      } catch (error) {
        notify(error instanceof Error ? error.message : 'Native dosya seçici açılamadı.', 'error');
      }
      return;
    }
    fileRef.current?.click();
  }

  async function changeMode(mode: string, pausedUntil: string | null = null) {
    if (!selectedId) return;
    try {
      await api(`/api/conversations/${selectedId}/ai-mode`, { method: 'PUT', ...jsonBody({ mode, pausedUntil }) });
      loadDetail(selectedId);
      notify(pausedUntil ? `AI ${formatDate(pausedUntil)} tarihine kadar durduruldu.` : 'Konuşma AI modu güncellendi.', 'success');
    } catch (error) { notify(error instanceof Error ? error.message : 'AI modu değiştirilemedi.', 'error'); }
  }

  function pauseFor(minutes: number) {
    const mode = String(detail?.conversation.ai_mode ?? 'suggestion');
    void changeMode(mode === 'human' ? 'suggestion' : mode, new Date(Date.now() + minutes * 60_000).toISOString());
  }

  async function generateSuggestion() {
    if (!selectedId) return;
    setBusy(true);
    try {
      const result = await api<Suggestion>(`/api/conversations/${selectedId}/ai-suggestion`, { method: 'POST' });
      setSuggestion(result);
      setMessageText(result.reply);
      notify(result.needsHuman ? 'AI insan devri önerdi; cevap otomatik gönderilmedi.' : 'AI önerisi hazır. Düzenleyip yalnız siz gönderebilirsiniz.', 'info');
    } catch (error) { notify(error instanceof Error ? error.message : 'AI önerisi üretilemedi.', 'error'); }
    finally { setBusy(false); }
  }

  async function syncTemplates() {
    try {
      const result = await api<{ count: number }>('/api/templates/sync', { method: 'POST' });
      setTemplates(await api('/api/templates'));
      notify(`${result.count} şablon Meta’dan senkronize edildi.`, 'success');
    } catch (error) { notify(error instanceof Error ? error.message : 'Şablonlar alınamadı.', 'error'); }
  }

  async function sendTemplate(event: FormEvent<HTMLFormElement>, activeConversation: boolean) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const templateName = String(data.get('template') ?? '');
    const template = approvedTemplates.find(item => item.meta_name === templateName);
    const phone = activeConversation ? String(detail?.conversation.phone_e164 ?? '') : String(data.get('phone') ?? '').trim();
    const displayName = activeConversation ? String(detail?.conversation.display_name ?? phone) : String(data.get('name') ?? '').trim();
    const languageCode = String(data.get('language') ?? template?.language_code ?? 'tr').trim();
    const variables = String(data.get('variables') ?? '').split('\n').map(value => value.trim()).filter(Boolean);
    if (!phone || !displayName || !templateName) return;
    setBusy(true);
    try {
      const result = await api<{ conversationId: string }>('/api/messages/template', {
        method: 'POST',
        ...jsonBody({ phone, displayName, templateName, languageCode, variables })
      });
      form.reset();
      loadList();
      setSelectedId(result.conversationId);
      notify(activeConversation ? 'Meta şablonu aktif konuşmaya kuyruğa alındı.' : 'İlk şablon mesajı kuyruğa alındı.', 'success');
    } catch (error) { notify(error instanceof Error ? error.message : 'Şablon mesajı gönderilemedi.', 'error'); }
    finally { setBusy(false); }
  }

  async function saveRequirements(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedId) return;
    const data = new FormData(event.currentTarget);
    const numberOrNull = (name: string) => {
      const value = String(data.get(name) ?? '').trim();
      return value ? Number(value) : null;
    };
    const boolOrNull = (name: string) => {
      const value = String(data.get(name) ?? '');
      return value === '' ? null : value === 'true';
    };
    try {
      await api(`/api/conversations/${selectedId}/requirements`, {
        method: 'PUT',
        ...jsonBody({
          sector: nullableString(data.get('sector')),
          websiteType: nullableString(data.get('websiteType')),
          requestedPages: lines(data.get('requestedPages')),
          adminPanelRequired: boolOrNull('adminPanelRequired'),
          catalogRequired: boolOrNull('catalogRequired'),
          ecommerceRequired: boolOrNull('ecommerceRequired'),
          multilanguageRequired: boolOrNull('multilanguageRequired'),
          domainStatus: nullableString(data.get('domainStatus')),
          hostingStatus: nullableString(data.get('hostingStatus')),
          designPreferences: nullableString(data.get('designPreferences')),
          referenceWebsites: lines(data.get('referenceWebsites')),
          budgetMin: numberOrNull('budgetMin'),
          budgetMax: numberOrNull('budgetMax'),
          currencyCode: nullableString(data.get('currencyCode')),
          deliveryExpectation: nullableString(data.get('deliveryExpectation')),
          quotedPrice: numberOrNull('quotedPrice'),
          discountAmount: numberOrNull('discountAmount'),
          paymentExpectation: nullableString(data.get('paymentExpectation')),
          nextAction: nullableString(data.get('nextAction')),
          leadStage: nullableString(data.get('leadStage'))
        })
      });
      loadDetail(selectedId);
      notify('Müşteri gereksinimleri ve teklif bilgileri güncellendi.', 'success');
    } catch (error) { notify(error instanceof Error ? error.message : 'Gereksinimler kaydedilemedi.', 'error'); }
  }

  async function addNote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedId) return;
    const form = event.currentTarget;
    const text = String(new FormData(form).get('note') ?? '').trim();
    if (!text) return;
    try {
      await api(`/api/conversations/${selectedId}/notes`, { method: 'POST', ...jsonBody({ text }) });
      form.reset();
      loadDetail(selectedId);
      notify('Müşteri notu eklendi.', 'success');
    } catch (error) { notify(error instanceof Error ? error.message : 'Not eklenemedi.', 'error'); }
  }

  async function editNote(note: Note) {
    if (!selectedId || note.source !== 'admin') return;
    const text = window.prompt('Notu düzenleyin:', note.note_text)?.trim();
    if (!text) return;
    try {
      await api(`/api/conversations/${selectedId}/notes/${note.id}`, { method: 'PATCH', ...jsonBody({ text }) });
      loadDetail(selectedId);
      notify('Not güncellendi.', 'success');
    } catch (error) { notify(error instanceof Error ? error.message : 'Not güncellenemedi.', 'error'); }
  }

  async function deleteNote(note: Note) {
    if (!selectedId || note.source !== 'admin' || !window.confirm('Bu müşteri notu silinsin mi?')) return;
    try {
      await api(`/api/conversations/${selectedId}/notes/${note.id}`, { method: 'DELETE' });
      loadDetail(selectedId);
      notify('Not silindi.', 'success');
    } catch (error) { notify(error instanceof Error ? error.message : 'Not silinemedi.', 'error'); }
  }

  return <div className="wa-layout">
    <aside className="conversation-list panel">
      <div className="panel-heading compact"><div><h3>Konuşmalar</h3><p>{items.length} kayıt</p></div><input className="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="İsim, telefon veya firma" /></div>
      <div className="conversation-scroll">{items.map(item => <button key={item.id} className={`conversation-row ${selectedId === item.id ? 'active' : ''}`} onClick={() => setSelectedId(item.id)}>
        <div className="avatar">{(item.display_name || '?').slice(0, 1).toUpperCase()}</div>
        <div><strong>{item.display_name || item.phone_e164}</strong><span>{item.last_message || 'Henüz mesaj yok'}</span><small>{formatDate(item.last_message_at)} · {item.human_takeover ? 'İnsan devri' : `AI ${item.ai_mode}`}</small></div>
        {item.unread_count > 0 && <b>{item.unread_count}</b>}
      </button>)}</div>
      {!items.length && <Empty text="Henüz WhatsApp konuşması yok." />}
    </aside>

    <section className="chat-panel panel">{detail ? <>
      <header className="chat-header"><div><h3>{detail.conversation.display_name}</h3><p>{detail.conversation.phone_e164} {detail.conversation.company_name ? `· ${detail.conversation.company_name}` : ''}</p></div><span className={`pill ${detail.conversation.human_takeover ? 'warn' : 'ready'}`}>{detail.conversation.human_takeover ? 'İnsan devraldı' : `AI: ${detail.conversation.ai_mode}`}</span></header>
      <div className="messages">{detail.messages.map(message => <article key={message.id} className={`bubble ${message.direction}`}><div>{message.original_name && message.attachment_id && <a href={`/api/conversations/${detail.conversation.id}/attachments/${String(message.attachment_id)}`}>📎 {message.original_name}</a>}{message.text_content && <p>{message.text_content}</p>}</div><small>{message.sender_type}{message.ai_generated ? ' · AI' : ''} · {message.delivery_status} · {formatDate(message.created_at)}</small></article>)}</div>
      <form className="composer" onSubmit={sendText}>
        {suggestion && <div className="suggestion-banner"><strong>AI önerisi · %{Math.round(suggestion.confidence * 100)} · {suggestion.intent}</strong><span>{suggestion.needsHuman ? 'İnsan kontrolü zorunlu' : 'Göndermeden önce düzenleyin'}</span></div>}
        <textarea name="message" required value={messageText} onChange={event => setMessageText(event.target.value)} placeholder="Müşteriye manuel mesaj yazın…" rows={4} />
        <div className="composer-tools"><select aria-label="Hazır cevap" defaultValue="" onChange={event => { const reply = cannedReplies.find(item => item.id === event.target.value); if (reply) setMessageText(current => current ? `${current}\n${reply.body}` : reply.body); event.target.value = ''; }}><option value="">Hazır cevap seç</option>{cannedReplies.map(reply => <option key={reply.id} value={reply.id}>{reply.title}</option>)}</select><button type="button" className="button secondary" onClick={() => void generateSuggestion()} disabled={busy}>AI Önerisi</button><input ref={fileRef} hidden type="file" accept="image/png,image/jpeg,image/webp,application/pdf,.docx,.xlsx,.csv,.txt" onChange={event => { const file = event.target.files?.[0]; if (file) void upload(file); }} /><button type="button" className="button secondary" onClick={() => void chooseAttachment()} disabled={busy}>Dosya Ekle</button><button className="button primary" disabled={busy || !messageText.trim()}>{busy ? 'İşleniyor…' : 'Gönder'}</button></div>
      </form>
    </> : <Empty text="Bir konuşma seçin." />}</section>

    <aside className="customer-panel page-stack">
      <section className="panel"><h3>Müşteri ve AI Kontrolü</h3>{selected && <div className="key-list"><p><span>İsim</span><strong>{selected.display_name}</strong></p><p><span>Telefon</span><strong>{selected.phone_e164}</strong></p><p><span>Firma</span><strong>{selected.company_name || '—'}</strong></p></div>}
        <label>Konuşma AI modu<select value={String(detail?.conversation.ai_mode ?? 'off')} onChange={event => void changeMode(event.target.value)}><option value="off">Kapalı</option><option value="suggestion">Yalnız öneri</option><option value="auto">Otomatik cevap</option><option value="business_hours">Mesai saatlerinde otomatik</option><option value="human">İnsan devraldı</option></select></label>
        <div className="pause-actions"><button className="text-button" onClick={() => pauseFor(30)}>30 dk durdur</button><button className="text-button" onClick={() => pauseFor(120)}>2 saat durdur</button><button className="text-button" onClick={() => pauseFor(1440)}>24 saat durdur</button><button className="text-button" onClick={() => void changeMode(String(detail?.conversation.ai_mode ?? 'suggestion'), null)}>Duraklatmayı kaldır</button></div>
        {detail?.summary && <div className="summary-box"><strong>Konuşma özeti</strong><p>{String(detail.summary.summary_text ?? '')}</p></div>}
        {detail?.lastDecision && <div className="summary-box"><strong>Son AI kararı</strong><p>{String(detail.lastDecision.intent ?? '—')} · %{Math.round(Number(detail.lastDecision.confidence ?? 0) * 100)}</p></div>}
      </section>

      <section className="panel"><h3>Müşteri Gereksinimleri ve Teklif</h3><form className="form-stack" key={`${selectedId}-${JSON.stringify(requirements)}`} onSubmit={saveRequirements}>
        <label>Sektör<input name="sector" defaultValue={requirements.sector ?? ''} /></label><label>Site türü<input name="websiteType" defaultValue={requirements.website_type ?? ''} /></label><label>İstenen sayfalar<textarea name="requestedPages" rows={3} defaultValue={jsonLines(requirements.requested_pages_json)} /></label>
        <div className="inline-fields"><TriState name="adminPanelRequired" label="Admin paneli" value={requirements.admin_panel_required} /><TriState name="catalogRequired" label="Katalog" value={requirements.catalog_required} /><TriState name="ecommerceRequired" label="E-ticaret" value={requirements.ecommerce_required} /></div>
        <TriState name="multilanguageRequired" label="Çok dil" value={requirements.multilanguage_required} /><label>Domain durumu<input name="domainStatus" defaultValue={requirements.domain_status ?? ''} /></label><label>Hosting durumu<input name="hostingStatus" defaultValue={requirements.hosting_status ?? ''} /></label><label>Tasarım tercihleri<textarea name="designPreferences" rows={3} defaultValue={requirements.design_preferences ?? ''} /></label><label>Referans siteler<textarea name="referenceWebsites" rows={3} defaultValue={jsonLines(requirements.reference_websites_json)} /></label>
        <div className="inline-fields"><label>Bütçe alt<input name="budgetMin" type="number" min="0" step="0.01" defaultValue={requirements.budget_min ?? ''} /></label><label>Bütçe üst<input name="budgetMax" type="number" min="0" step="0.01" defaultValue={requirements.budget_max ?? ''} /></label><label>Para birimi<input name="currencyCode" maxLength={3} defaultValue={requirements.currency_code ?? 'TRY'} /></label></div>
        <div className="inline-fields"><label>Teklif<input name="quotedPrice" type="number" min="0" step="0.01" defaultValue={requirements.quoted_price ?? ''} /></label><label>İndirim<input name="discountAmount" type="number" min="0" step="0.01" defaultValue={requirements.discount_amount ?? ''} /></label><label>Aşama<input name="leadStage" defaultValue={requirements.lead_stage ?? ''} /></label></div>
        <label>Teslim beklentisi<input name="deliveryExpectation" defaultValue={requirements.delivery_expectation ?? ''} /></label><label>Ödeme beklentisi<input name="paymentExpectation" defaultValue={requirements.payment_expectation ?? ''} /></label><label>Sonraki adım<textarea name="nextAction" rows={3} defaultValue={requirements.next_action ?? ''} /></label><button className="button primary" disabled={!selectedId}>Gereksinimleri Kaydet</button>
      </form></section>

      <section className="panel"><h3>Müşteri Notları</h3><form className="form-stack" onSubmit={addNote}><label>Yeni not<textarea name="note" rows={3} required /></label><button className="button secondary" disabled={!selectedId}>Not Ekle</button></form><div className="knowledge-list">{notes.map(note => <article key={note.id}><div><span>{note.source} · {formatDate(note.updated_at || note.created_at)}</span><p>{note.note_text}</p></div>{note.source === 'admin' && <div className="form-actions"><button className="text-button" onClick={() => void editNote(note)}>Düzenle</button><button className="text-button danger" onClick={() => void deleteNote(note)}>Sil</button></div>}</article>)}</div>{detail && !notes.length && <Empty text="Müşteri notu yok." />}</section>

      <section className="panel"><div className="panel-heading compact"><div><h3>Aktif Konuşmada Meta Şablonu</h3><p>24 saat penceresi kapalı olsa da yalnız onaylı şablon.</p></div><button className="text-button" onClick={() => void syncTemplates()}>Yenile</button></div><form className="form-stack" onSubmit={event => void sendTemplate(event, true)}><label>Şablon<select name="template" required defaultValue=""><option value="" disabled>Seçin</option>{approvedTemplates.map(item => <option key={item.id} value={item.meta_name}>{item.meta_name} · {item.language_code}</option>)}</select></label><label>Dil kodu<input name="language" defaultValue={approvedTemplates[0]?.language_code ?? 'tr'} required /></label><label>Değişkenler<textarea name="variables" rows={3} placeholder="Her satıra bir değişken" /></label><button className="button secondary" disabled={!detail || busy}>Şablonu Gönder</button></form></section>

      <section className="panel"><div className="panel-heading compact"><div><h3>Yeni Müşteriye İlk Mesaj</h3><p>Yalnız Meta onaylı şablon.</p></div><button className="text-button" onClick={() => void syncTemplates()}>Şablonları Yenile</button></div><form className="form-stack" onSubmit={event => void sendTemplate(event, false)}><label>İsim<input name="name" required /></label><label>Telefon<input name="phone" required placeholder="+905…" /></label><label>Şablon<select name="template" required defaultValue=""><option value="" disabled>Seçin</option>{approvedTemplates.map(item => <option key={item.id} value={item.meta_name}>{item.meta_name}</option>)}</select></label><label>Dil kodu<input name="language" required defaultValue={approvedTemplates[0]?.language_code ?? 'tr'} /></label><label>Değişkenler<textarea name="variables" rows={3} placeholder="Her satıra bir değişken" /></label><button className="button primary" disabled={busy}>Şablon Mesajını Gönder</button></form></section>
    </aside>
  </div>;
}

function TriState({ name, label, value }: { name: string; label: string; value: number | null | undefined }) {
  return <label>{label}<select name={name} defaultValue={value == null ? '' : value ? 'true' : 'false'}><option value="">Belirsiz</option><option value="true">Evet</option><option value="false">Hayır</option></select></label>;
}
function nullableString(value: FormDataEntryValue | null): string | null {
  const text = String(value ?? '').trim();
  return text || null;
}
function lines(value: FormDataEntryValue | null): string[] {
  return String(value ?? '').split('\n').map(item => item.trim()).filter(Boolean);
}
function jsonLines(value: string | undefined): string {
  if (!value) return '';
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter(item => typeof item === 'string').join('\n') : '';
  } catch { return ''; }
}
