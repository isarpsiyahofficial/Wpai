import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, formValue, jsonBody } from '../api';
import type { Notify } from '../types';
import { Empty, formatDate } from './core';

type TrainingSession = {
  id: string;
  title: string;
  selected_conversation_id: string | null;
  status: 'active' | 'archived';
  message_count: number;
  item_count: number;
  updated_at: string;
};
type TrainingMessage = { id: string; role: 'admin' | 'assistant' | 'system'; content: string; created_at: string };
type TrainingItem = {
  id: string;
  thread_id: string;
  item_type: string;
  title: string;
  content: string;
  expected_response: string | null;
  status: 'draft' | 'approved' | 'disabled' | 'archived';
  usage_permission: string;
  scope: string;
  contact_id: string | null;
  conversation_id: string | null;
  priority: number;
  valid_from: string | null;
  valid_until: string | null;
  checksum: string;
  knowledge_id?: string | null;
  current_version?: number | null;
  updated_at: string;
};
type Source = {
  id: string;
  title: string;
  source_type: string;
  original_name: string | null;
  mime_type: string | null;
  status: string;
  checksum: string;
  extraction_status: string;
  extraction_error: string | null;
  updated_at: string;
};
type SyncJob = {
  id: string;
  knowledge_id: string | null;
  operation: string;
  target: string;
  status: string;
  knowledge_version: number | null;
  attempts: number;
  error_code: string | null;
  scheduled_at: string;
  completed_at: string | null;
};
type IndexStatus = {
  indexName: string;
  embeddingModel: string;
  dimensions: number;
  metric: string;
  totalSources: number;
  approvedKnowledge: number;
  totalChunks: number;
  activeChunks: number;
  localArtifacts: number;
  completedJobs: number;
  pendingJobs: number;
  failedJobs: number;
  progressPercent: number;
  estimatedEmbeddingTokens: number;
  estimatedNeurons: number;
  estimatedCostUsd: number;
  pricingBasis: string;
  estimatedRemainingSeconds: number | null;
  lastSyncAt: string | null;
};
type Overview = { sessions: TrainingSession[]; items: TrainingItem[]; sources: Source[]; jobs: SyncJob[]; index: IndexStatus };
type SessionDetail = { thread: TrainingSession; messages: TrainingMessage[]; items: TrainingItem[] };
type Version = {
  version: number;
  title: string;
  category: string;
  content: string;
  change_summary: string;
  checksum: string;
  created_at: string;
};

const ITEM_LABELS: Record<string, string> = {
  instruction: 'Talimat',
  correction: 'Düzeltme',
  positive_example: 'Doğru cevap örneği',
  negative_example: 'Yanlış cevap örneği',
  simulation: 'Senaryo',
  knowledge_draft: 'Bilgi taslağı'
};

export function TrainingPage({ notify }: { notify: Notify }) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [versions, setVersions] = useState<Version[]>([]);
  const [simulation, setSimulation] = useState('');
  const [impact, setImpact] = useState<{ before: string; after: string; changed: boolean; itemTitle: string } | null>(null);
  const [importPreview, setImportPreview] = useState<Record<string, unknown> | null>(null);
  const [importRecords, setImportRecords] = useState<unknown[]>([]);
  const [busy, setBusy] = useState(false);
  const sourceRef = useRef<HTMLInputElement>(null);
  const importRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const value = await api<Overview>('/api/training/overview');
      setOverview(value);
      setSelectedSessionId(current => current ?? value.sessions.find(item => item.status === 'active')?.id ?? value.sessions[0]?.id ?? null);
    } catch (error) {
      notify(error instanceof Error ? error.message : 'AI Eğitim Merkezi yüklenemedi.', 'error');
    }
  }, [notify]);

  const loadSession = useCallback(async (id: string) => {
    try {
      const value = await api<SessionDetail>(`/api/training/sessions/${id}`);
      setDetail(value);
      setSelectedItemId(current => current && value.items.some(item => item.id === current) ? current : value.items[0]?.id ?? null);
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Eğitim oturumu yüklenemedi.', 'error');
    }
  }, [notify]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (selectedSessionId) void loadSession(selectedSessionId); else setDetail(null); }, [selectedSessionId, loadSession]);

  const selectedItem = useMemo(
    () => detail?.items.find(item => item.id === selectedItemId) ?? overview?.items.find(item => item.id === selectedItemId) ?? null,
    [detail, overview, selectedItemId]
  );

  async function refreshCurrent() {
    await load();
    if (selectedSessionId) await loadSession(selectedSessionId);
  }

  async function createSession(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setBusy(true);
    try {
      const result = await api<{ id: string }>('/api/training/sessions', {
        method: 'POST',
        ...jsonBody({ title: formValue(form, 'title'), selectedConversationId: formValue(form, 'conversationId') || null })
      });
      form.reset();
      await load();
      setSelectedSessionId(result.id);
      notify('Kalıcı eğitim oturumu oluşturuldu.', 'success');
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Oturum oluşturulamadı.', 'error');
    } finally { setBusy(false); }
  }

  async function updateSession(status?: 'active' | 'archived') {
    if (!detail) return;
    const title = status ? undefined : window.prompt('Yeni oturum adı:', detail.thread.title)?.trim();
    if (!status && !title) return;
    try {
      await api(`/api/training/sessions/${detail.thread.id}`, {
        method: 'PATCH',
        ...jsonBody(status ? { status } : { title })
      });
      await refreshCurrent();
      notify(status === 'archived' ? 'Eğitim oturumu arşivlendi.' : 'Oturum adı güncellendi.', 'success');
    } catch (error) { notify(error instanceof Error ? error.message : 'Oturum güncellenemedi.', 'error'); }
  }

  async function deleteSession() {
    if (!detail || !window.confirm('Bu eğitim oturumu listeden kaldırılacak. Yayınlanmış bilgiler etkilenmez. Devam edilsin mi?')) return;
    try {
      await api(`/api/training/sessions/${detail.thread.id}`, { method: 'DELETE' });
      setSelectedSessionId(null);
      setDetail(null);
      await load();
      notify('Eğitim oturumu kaldırıldı.', 'success');
    } catch (error) { notify(error instanceof Error ? error.message : 'Oturum silinemedi.', 'error'); }
  }

  async function sendChat(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedSessionId) return;
    const form = event.currentTarget;
    const message = formValue(form, 'message');
    if (!message) return;
    setBusy(true);
    try {
      await api(`/api/training/sessions/${selectedSessionId}/messages`, { method: 'POST', ...jsonBody({ message }) });
      form.reset();
      await loadSession(selectedSessionId);
    } catch (error) { notify(error instanceof Error ? error.message : 'AI eğitim asistanı cevap veremedi.', 'error'); }
    finally { setBusy(false); }
  }

  async function createItem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedSessionId) return;
    const form = event.currentTarget;
    const scope = formValue(form, 'scope');
    setBusy(true);
    try {
      const result = await api<{ id: string }>('/api/training/items', {
        method: 'POST',
        ...jsonBody({
          threadId: selectedSessionId,
          itemType: formValue(form, 'itemType'),
          title: formValue(form, 'title'),
          content: formValue(form, 'content'),
          expectedResponse: formValue(form, 'expectedResponse') || null,
          usagePermission: formValue(form, 'permission'),
          scope,
          contactId: scope === 'global' ? null : formValue(form, 'contactId') || null,
          conversationId: scope === 'conversation' ? formValue(form, 'conversationId') || null : null,
          priority: Number(formValue(form, 'priority') || '100'),
          validFrom: dateTimeOrNull(formValue(form, 'validFrom')),
          validUntil: dateTimeOrNull(formValue(form, 'validUntil'))
        })
      });
      form.reset();
      await refreshCurrent();
      setSelectedItemId(result.id);
      notify('Eğitim kaydı taslak olarak oluşturuldu; canlı AI henüz kullanamaz.', 'success');
    } catch (error) { notify(error instanceof Error ? error.message : 'Eğitim taslağı oluşturulamadı.', 'error'); }
    finally { setBusy(false); }
  }

  async function publishItem(item: TrainingItem) {
    const category = window.prompt('Bilgi kategorisi:', 'Genel')?.trim();
    if (!category) return;
    const changeSummary = window.prompt('Bu sürümde ne değişti?', 'Yönetici onayıyla yayınlandı.')?.trim() || 'Yönetici onayıyla yayınlandı.';
    try {
      const result = await api<{ knowledgeId: string; version: number; vectorJobId: string }>(`/api/training/items/${item.id}/publish`, {
        method: 'POST', ...jsonBody({ category, changeSummary })
      });
      await refreshCurrent();
      notify(`Eğitim yayınlandı; sürüm ${result.version} indeksleme kuyruğuna alındı.`, 'success');
    } catch (error) { notify(error instanceof Error ? error.message : 'Eğitim yayınlanamadı.', 'error'); }
  }

  async function disableItem(item: TrainingItem) {
    if (!window.confirm('Bu eğitim kaydı canlı kullanımdan ve bulut indeksinden çıkarılacak. Devam edilsin mi?')) return;
    try {
      await api(`/api/training/items/${item.id}/disable`, { method: 'POST' });
      await refreshCurrent();
      notify('Eğitim kaydı canlı kullanımdan çıkarıldı.', 'success');
    } catch (error) { notify(error instanceof Error ? error.message : 'Eğitim devre dışı bırakılamadı.', 'error'); }
  }

  async function loadVersions(item: TrainingItem) {
    try {
      const result = await api<{ versions: Version[] }>(`/api/training/items/${item.id}/versions`);
      setSelectedItemId(item.id);
      setVersions(result.versions);
    } catch (error) { notify(error instanceof Error ? error.message : 'Sürümler yüklenemedi.', 'error'); }
  }

  async function rollback(version: number) {
    if (!selectedItem || !window.confirm(`İçerik sürüm ${version} durumuna döndürülecek ve yeni bir sürüm olarak yayınlanacak. Devam edilsin mi?`)) return;
    try {
      await api(`/api/training/items/${selectedItem.id}/rollback/${version}`, { method: 'POST' });
      await refreshCurrent();
      await loadVersions(selectedItem);
      notify('Seçilen sürüm yeni sürüm olarak yayınlandı.', 'success');
    } catch (error) { notify(error instanceof Error ? error.message : 'Sürüm geri alınamadı.', 'error'); }
  }

  async function uploadSource(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedSessionId || !sourceRef.current?.files?.[0]) return;
    const form = event.currentTarget;
    const data = new FormData();
    data.set('file', sourceRef.current.files[0]);
    data.set('title', formValue(form, 'title'));
    data.set('threadId', selectedSessionId);
    setBusy(true);
    try {
      const result = await api<{ extractionStatus: string; itemId: string | null }>('/api/training/sources', { method: 'POST', body: data });
      form.reset();
      sourceRef.current.value = '';
      await refreshCurrent();
      if (result.itemId) setSelectedItemId(result.itemId);
      notify(result.extractionStatus === 'ready' ? 'Belge yapısal metne çevrildi ve taslak oluşturuldu.' : 'Kaynak saklandı fakat metin çıkarımı başarısız oldu.', result.extractionStatus === 'ready' ? 'success' : 'info');
    } catch (error) { notify(error instanceof Error ? error.message : 'Kaynak yüklenemedi.', 'error'); }
    finally { setBusy(false); }
  }

  async function runSimulation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setBusy(true);
    try {
      const result = await api<{ answer: string }>('/api/training/simulate', {
        method: 'POST',
        ...jsonBody({
          scenario: formValue(form, 'scenario'),
          scope: formValue(form, 'scope'),
          contactId: formValue(form, 'contactId') || null,
          conversationId: formValue(form, 'conversationId') || null,
          draftItemIds: detail?.items.filter(item => item.status === 'draft').map(item => item.id) ?? []
        })
      });
      setSimulation(result.answer);
      notify('Simülasyon tamamlandı; müşteriye hiçbir mesaj gönderilmedi.', 'success');
    } catch (error) { notify(error instanceof Error ? error.message : 'Simülasyon çalıştırılamadı.', 'error'); }
    finally { setBusy(false); }
  }

  async function previewImpact(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedItem || selectedItem.status !== 'draft') {
      notify('Canlı AI etkisi için yayınlanmamış bir taslak seçin.', 'info');
      return;
    }
    const form = event.currentTarget;
    setBusy(true);
    try {
      const result = await api<{ before: string; after: string; changed: boolean; itemTitle: string }>(`/api/training/items/${selectedItem.id}/impact-preview`, {
        method: 'POST',
        ...jsonBody({
          scenario: formValue(form, 'scenario'),
          scope: formValue(form, 'scope'),
          contactId: formValue(form, 'contactId') || null,
          conversationId: formValue(form, 'conversationId') || null
        })
      });
      setImpact(result);
      notify('Taslağın canlı AI cevabına olası etkisi karşılaştırıldı; müşteriye mesaj gönderilmedi.', 'success');
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Canlı AI etki karşılaştırması yapılamadı.', 'error');
    } finally { setBusy(false); }
  }

  async function exportMemory() {
    try {
      const result = await api<Record<string, unknown>>('/api/training/export');
      downloadJson(`wpai-ai-egitim-${new Date().toISOString().slice(0, 10)}.json`, result);
      notify('AI eğitim hafızası denetlenebilir JSON olarak dışa aktarıldı.', 'success');
    } catch (error) { notify(error instanceof Error ? error.message : 'Dışa aktarma başarısız.', 'error'); }
  }

  async function previewImport(file: File) {
    try {
      const raw = JSON.parse(await file.text()) as Record<string, unknown>;
      const records = Array.isArray(raw.records) ? raw.records : Array.isArray(raw.items) ? raw.items.map(convertExportItem) : [];
      if (!records.length) throw new Error('Dosyada içe aktarılabilir eğitim kaydı yok.');
      const result = await api<Record<string, unknown>>('/api/training/import', {
        method: 'POST', ...jsonBody({ records, threadId: selectedSessionId ?? undefined, commit: false })
      });
      setImportRecords(records);
      setImportPreview(result);
      notify('İçe aktarma önizlemesi hazır; çakışmalar henüz yazılmadı.', 'info');
    } catch (error) { notify(error instanceof Error ? error.message : 'İçe aktarma dosyası okunamadı.', 'error'); }
  }

  async function commitImport() {
    if (!importRecords.length) return;
    try {
      const result = await api<{ committed: number }>('/api/training/import', {
        method: 'POST', ...jsonBody({ records: importRecords, threadId: selectedSessionId ?? undefined, commit: true })
      });
      setImportPreview(null);
      setImportRecords([]);
      if (importRef.current) importRef.current.value = '';
      await refreshCurrent();
      notify(`${result.committed} eğitim taslağı içe aktarıldı.`, 'success');
    } catch (error) { notify(error instanceof Error ? error.message : 'İçe aktarma tamamlanamadı.', 'error'); }
  }

  async function clearMemory(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!window.confirm('AI eğitim hafızası canlı kullanımdan kaldırılacak; müşteri konuşmaları ve audit kayıtları korunacak. Devam edilsin mi?')) return;
    try {
      await api('/api/training/memory/clear', {
        method: 'POST',
        ...jsonBody({ password: formValue(form, 'password'), confirmation: formValue(form, 'confirmation') })
      });
      form.reset();
      setDetail(null);
      setSelectedSessionId(null);
      await load();
      notify('AI eğitim hafızası kapatıldı ve indeks temizleme işi başlatıldı.', 'success');
    } catch (error) { notify(error instanceof Error ? error.message : 'AI hafızası temizlenemedi.', 'error'); }
  }

  return <div className="page-stack training-page">
    <section className="panel">
      <div className="panel-heading">
        <div><h3>AI Eğitim Merkezi</h3><p>Buradaki hiçbir taslak yönetici yayınlamadan müşteri AI’ına geçmez.</p></div>
        <div className="form-actions">
          <button className="button secondary" onClick={() => void exportMemory()}>Eğitimi Dışa Aktar</button>
          <label className="button secondary file-button">İçe Aktar<input ref={importRef} hidden type="file" accept="application/json,.json" onChange={event => { const file = event.target.files?.[0]; if (file) void previewImport(file); }} /></label>
        </div>
      </div>
      <div className="metrics">
        <article className="metric"><span>Toplam kaynak</span><strong>{overview?.index.totalSources ?? '—'}</strong><small>Onaylı bilgi: {overview?.index.approvedKnowledge ?? '—'}</small></article>
        <article className="metric"><span>Toplam bilgi parçası</span><strong>{overview?.index.totalChunks ?? '—'}</strong><small>Canlı kullanılan: {overview?.index.activeChunks ?? '—'}</small></article>
        <article className="metric"><span>Tamamlanan indeks işi</span><strong>{overview?.index.completedJobs ?? '—'}</strong><small>İlerleme %{overview?.index.progressPercent ?? '—'}</small></article>
        <article className="metric"><span>Bekleyen / başarısız</span><strong>{overview ? `${overview.index.pendingJobs} / ${overview.index.failedJobs}` : '—'}</strong></article>
        <article className="metric"><span>Tahmini indeks maliyeti</span><strong>{overview ? `$${Number(overview.index.estimatedCostUsd ?? 0).toFixed(6)}` : '—'}</strong><small>{overview?.index.estimatedNeurons ?? '—'} tahmini Neuron</small></article>
        <article className="metric"><span>Tahmini kalan süre</span><strong>{formatDuration(overview?.index.estimatedRemainingSeconds ?? null)}</strong><small>Son senkronizasyon: {overview?.index.lastSyncAt ? formatDate(overview.index.lastSyncAt) : 'Henüz yok'}</small></article>
      </div>
      <details className="advanced-status"><summary>Gelişmiş indeks durumu</summary><div className="summary-grid">
        <div><span>Bulut indeks</span><strong>{overview?.index.indexName ?? '—'}</strong></div>
        <div><span>Embedding modeli</span><strong>{overview?.index.embeddingModel ?? '—'}</strong></div>
        <div><span>Boyut / metrik</span><strong>{overview ? `${overview.index.dimensions} / ${overview.index.metric}` : '—'}</strong></div>
        <div><span>Yerel artifact</span><strong>{overview?.index.localArtifacts ?? '—'}</strong></div>
        <div><span>Embedding girdi tokenı</span><strong>{overview?.index.estimatedEmbeddingTokens ?? '—'}</strong></div>
      </div><p className="safe-note">{overview?.index.pricingBasis ?? 'Fiyat referansı yükleniyor.'}</p></details>
      {importPreview && <div className="summary-box"><strong>İçe aktarma önizlemesi</strong><pre>{JSON.stringify(importPreview, null, 2)}</pre><button className="button primary" onClick={() => void commitImport()}>Çakışmayan Taslakları İçe Aktar</button></div>}
    </section>

    <section className="training-layout">
      <aside className="panel training-sessions">
        <div className="panel-heading compact"><div><h3>Eğitim Oturumları</h3><p>Kalıcı ve devam edilebilir</p></div></div>
        <form className="form-stack" onSubmit={createSession}>
          <label>Oturum adı<input name="title" required placeholder="Örn. Fiyat ve pazarlık kuralları" /></label>
          <label>Konuşma ID — isteğe bağlı<input name="conversationId" placeholder="Müşteri bağlamıyla çalışmak için UUID" /></label>
          <button className="button primary" disabled={busy}>Yeni Oturum</button>
        </form>
        <div className="conversation-scroll">{overview?.sessions.map(item => <button key={item.id} className={`conversation-row ${selectedSessionId === item.id ? 'active' : ''}`} onClick={() => setSelectedSessionId(item.id)}>
          <div><strong>{item.title}</strong><span>{item.message_count} mesaj · {item.item_count} kayıt</span><small>{item.status} · {formatDate(item.updated_at)}</small></div>
        </button>)}</div>
        {!overview?.sessions.length && <Empty text="Henüz eğitim oturumu yok." />}
      </aside>

      <main className="page-stack">
        <section className="panel ai-console">
          <div className="panel-heading"><div><h3>{detail?.thread.title ?? 'Eğitim Asistanı'}</h3><p>AI ile kuralı netleştirin; sonra ayrı bir taslak oluşturun.</p></div>{detail && <div className="form-actions"><button className="text-button" onClick={() => void updateSession()}>Yeniden Adlandır</button><button className="text-button" onClick={() => void updateSession(detail.thread.status === 'archived' ? 'active' : 'archived')}>{detail.thread.status === 'archived' ? 'Aktifleştir' : 'Arşivle'}</button><button className="text-button danger" onClick={() => void deleteSession()}>Sil</button></div>}</div>
          <div className="console-messages">{detail?.messages.map(message => <article key={message.id} className={message.role === 'assistant' ? 'assistant' : 'admin'}><strong>{message.role === 'assistant' ? 'AI' : 'Siz'}</strong><p>{message.content}</p><small>{formatDate(message.created_at)}</small></article>)}{detail && !detail.messages.length && <Empty text="AI’a öğretmek istediğiniz kuralı yazın." />}</div>
          <form className="console-form" onSubmit={sendChat}><textarea name="message" rows={4} required disabled={!detail || detail.thread.status === 'archived'} placeholder="Örn: Müşteri ciddi fiyat pazarlığı yaparsa kesin indirim vermeden yöneticiye devret." /><button className="button primary" disabled={busy || !detail || detail.thread.status === 'archived'}>AI ile Çalış</button></form>
        </section>

        <section className="panel">
          <h3>Denetlenebilir Eğitim Taslağı</h3>
          <form className="form-grid" onSubmit={createItem}>
            <label>Tür<select name="itemType"><option value="instruction">Talimat</option><option value="correction">Düzeltme</option><option value="positive_example">Doğru cevap örneği</option><option value="negative_example">Yanlış cevap örneği</option><option value="simulation">Senaryo</option><option value="knowledge_draft">Bilgi taslağı</option></select></label>
            <label>Başlık<input name="title" required /></label>
            <label>Kullanım<select name="permission"><option value="both">İç + müşteri cevapları</option><option value="customer_answers">Müşteri cevapları</option><option value="internal">Yalnız iç kullanım</option></select></label>
            <label>Öncelik<input name="priority" type="number" min="0" max="1000" defaultValue="100" /></label>
            <label>Kapsam<select name="scope"><option value="global">Tüm işletme</option><option value="contact">Yalnız müşteri</option><option value="conversation">Yalnız konuşma</option></select></label>
            <label>Müşteri ID<input name="contactId" placeholder="Kapsam müşteri/konuşma ise UUID" /></label>
            <label>Konuşma ID<input name="conversationId" placeholder="Konuşma kapsamı ise UUID" /></label>
            <label>Başlangıç<input name="validFrom" type="datetime-local" /></label>
            <label>Bitiş<input name="validUntil" type="datetime-local" /></label>
            <label className="wide">Kural / bilgi / yanlış örnek<textarea name="content" rows={7} required /></label>
            <label className="wide">Beklenen doğru cevap — isteğe bağlı<textarea name="expectedResponse" rows={5} /></label>
            <div className="form-actions wide"><button className="button primary" disabled={!selectedSessionId || busy}>Taslak Oluştur</button></div>
          </form>
        </section>
      </main>
    </section>

    <section className="grid-two">
      <div className="panel">
        <div className="panel-heading"><div><h3>Eğitim Kayıtları</h3><p>Taslak, yayınlanmış ve devre dışı kayıtlar</p></div></div>
        <div className="knowledge-list">{detail?.items.map(item => <article key={item.id} className={selectedItemId === item.id ? 'selected' : ''}>
          <div onClick={() => setSelectedItemId(item.id)}><span>{ITEM_LABELS[item.item_type] ?? item.item_type} · {item.status} · {item.scope} · Öncelik {item.priority}</span><h4>{item.title}</h4><p>{item.content}</p><small>Checksum {item.checksum.slice(0, 12)}… · {formatDate(item.updated_at)}</small></div>
          <div className="form-actions">{item.status === 'draft' && <button className="text-button" onClick={() => void publishItem(item)}>İncele ve Yayınla</button>}{item.status === 'approved' && <button className="text-button danger" onClick={() => void disableItem(item)}>Canlı Kullanımdan Çıkar</button>}<button className="text-button" onClick={() => void loadVersions(item)}>Sürümler</button></div>
        </article>)}</div>
        {detail && !detail.items.length && <Empty text="Bu oturumda eğitim taslağı yok." />}
      </div>
      <div className="panel">
        <h3>Sürüm Geçmişi</h3>
        {selectedItem && <p><strong>{selectedItem.title}</strong> · mevcut sürüm {selectedItem.current_version ?? 'yayınlanmadı'}</p>}
        <div className="knowledge-list">{versions.map(version => <article key={version.version}><div><span>Sürüm {version.version} · {formatDate(version.created_at)}</span><h4>{version.change_summary}</h4><p>{version.content}</p><small>{version.checksum.slice(0, 16)}…</small></div><button className="text-button" onClick={() => void rollback(version.version)}>Bu Sürüme Dön</button></article>)}</div>
        {!versions.length && <Empty text="Bir kayıt seçip Sürümler düğmesine basın." />}
      </div>
    </section>

    <section className="grid-two">
      <div className="panel">
        <h3>Belgeden Eğitim Taslağı</h3><p>PDF, DOCX, XLSX, CSV, TXT ve görseller özel R2 alanında saklanır; Workers AI ile yapısal metne çevrilir.</p>
        <form className="form-stack" onSubmit={uploadSource}><label>Kaynak başlığı<input name="title" required /></label><label>Dosya<input ref={sourceRef} type="file" required accept=".pdf,.docx,.xlsx,.csv,.txt,image/png,image/jpeg,image/webp" /></label><button className="button primary" disabled={!selectedSessionId || busy}>Kaynağı İşle</button></form>
        <div className="knowledge-list">{overview?.sources.map(source => <article key={source.id}><div><span>{source.source_type} · {source.extraction_status}</span><h4>{source.title}</h4><p>{source.original_name ?? 'Manuel kaynak'}</p><small>{source.extraction_error ?? source.checksum.slice(0, 16)} · {formatDate(source.updated_at)}</small></div>{source.original_name && <a className="text-button" href={`/api/training/sources/${source.id}/download`}>İndir</a>}</article>)}</div>
      </div>
      <div className="panel">
        <h3>Müşteri Senaryosu Simülasyonu</h3><p>Yayınlanmış bilgi ve bu oturumdaki taslaklar birlikte denenebilir; müşteriye mesaj gönderilmez.</p>
        <form className="form-stack" onSubmit={runSimulation}><label>Senaryo<textarea name="scenario" rows={7} required placeholder="Müşteri 12.000 TL indirim ve yarın teslim istiyor..." /></label><label>Kapsam<select name="scope"><option value="global">Tüm işletme</option><option value="contact">Müşteri</option><option value="conversation">Konuşma</option></select></label><label>Müşteri ID<input name="contactId" /></label><label>Konuşma ID<input name="conversationId" /></label><button className="button secondary" disabled={busy}>Simülasyonu Çalıştır</button></form>
        {simulation && <div className="summary-box"><strong>Simülasyon sonucu</strong><p>{simulation}</p></div>}
      </div>
    </section>

    <section className="panel training-impact">
      <div className="panel-heading"><div><h3>Canlı AI’a Etkisi</h3><p>Seçili taslak yayınlanmadan önce aynı müşteri senaryosunda mevcut cevap ile taslak sonrası olası cevabı yan yana karşılaştırır. Hiçbir mesaj müşteriye gönderilmez.</p></div><span className={`pill ${selectedItem?.status === 'draft' ? 'ready' : 'warn'}`}>{selectedItem?.status === 'draft' ? selectedItem.title : 'Önce bir taslak seçin'}</span></div>
      <form className="form-grid" onSubmit={previewImpact}>
        <label className="wide">Test müşteri mesajı<textarea name="scenario" rows={5} required placeholder="Örn. Biraz indirim yaparsanız bugün başlayabiliriz. Ne kadar düşebilirsiniz?" /></label>
        <label>Kapsam<select name="scope"><option value="global">Tüm işletme</option><option value="contact">Müşteri</option><option value="conversation">Konuşma</option></select></label>
        <label>Müşteri ID<input name="contactId" /></label>
        <label>Konuşma ID<input name="conversationId" /></label>
        <div className="form-actions wide"><button className="button secondary" disabled={busy || selectedItem?.status !== 'draft'}>Eski ve Yeni Cevabı Karşılaştır</button></div>
      </form>
      {impact && <div className="impact-comparison">
        <article className="summary-box"><strong>Mevcut canlı cevap</strong><p>{impact.before}</p></article>
        <article className="summary-box"><strong>Taslak yayınlanırsa olası cevap</strong><p>{impact.after}</p></article>
        <p className="safe-note">{impact.changed ? 'Taslak cevabı değiştiriyor. Yayınlamadan önce kapsam, fiyat ve devir kurallarını kontrol edin.' : 'Bu senaryoda anlamlı cevap değişikliği görülmedi.'}</p>
      </div>}
    </section>

    <section className="grid-two">
      <div className="panel table-panel"><h3>İndeks Senkronizasyon İşleri</h3><table><thead><tr><th>İş</th><th>Hedef</th><th>Durum</th><th>Deneme</th><th>Tarih</th></tr></thead><tbody>{overview?.jobs.slice(0, 50).map(job => <tr key={job.id}><td>{job.operation}<small>{job.knowledge_id ?? 'tüm indeks'}</small></td><td>{job.target}</td><td>{job.status}<small>{job.error_code ?? '—'}</small></td><td>{job.attempts}</td><td>{formatDate(job.completed_at ?? job.scheduled_at)}</td></tr>)}</tbody></table></div>
      <div className="panel danger-panel training-clear"><div><h3>Tüm AI Eğitim Hafızasını Sil</h3><p>Canlı eğitimleri ve indeksleri kapatır. Müşteri konuşmaları ile audit geçmişini silmez. Parola ve tam onay metni gerekir.</p></div><form className="form-stack" onSubmit={clearMemory}><label>Yönetici parolası<input name="password" type="password" required autoComplete="current-password" /></label><label>Onay metni<input name="confirmation" required placeholder="TÜM AI EĞİTİM HAFIZASINI SİL" /></label><button className="button danger-button">Hafızayı Güvenli Biçimde Temizle</button></form></div>
    </section>
  </div>;
}

function formatDuration(value: number | null): string {
  if (value == null) return 'Hesaplanamıyor';
  if (value < 60) return `${value} sn`;
  const minutes = Math.ceil(value / 60);
  return minutes < 60 ? `${minutes} dk` : `${Math.floor(minutes / 60)} sa ${minutes % 60} dk`;
}

function dateTimeOrNull(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
function downloadJson(name: string, value: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click(); URL.revokeObjectURL(url);
}
function convertExportItem(value: unknown): Record<string, unknown> {
  const item = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return {
    itemType: String(item.item_type ?? 'knowledge_draft'),
    title: String(item.title ?? 'İçe aktarılan eğitim'),
    content: String(item.content ?? ''),
    expectedResponse: typeof item.expected_response === 'string' ? item.expected_response : null,
    usagePermission: String(item.usage_permission ?? 'both'),
    scope: String(item.scope ?? 'global'),
    contactId: typeof item.contact_id === 'string' ? item.contact_id : null,
    conversationId: typeof item.conversation_id === 'string' ? item.conversation_id : null,
    priority: Number(item.priority ?? 100),
    validFrom: typeof item.valid_from === 'string' ? item.valid_from : null,
    validUntil: typeof item.valid_until === 'string' ? item.valid_until : null
  };
}
