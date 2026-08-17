import { FormEvent, useCallback, useEffect, useState } from 'react';
import { api, formValue, jsonBody } from '../api';
import type { Notify } from '../types';
import { Empty, formatDate, formatNumber } from './core';

type AiSettings = {
  globalMode: 'off' | 'suggestion' | 'auto' | 'business_hours';
  autoReplyEnabled: boolean;
  suggestionMode: boolean;
  businessInstructions: string;
  handoffRules: string[];
  minimumConfidence: number;
  recentMessageCount: number;
  debounceSeconds: number;
};

type UsageBreakdown = {
  key: string;
  estimatedNeurons: number;
  inputTokens: number;
  outputTokens: number;
  requests: number;
  successfulRequests: number;
  failedRequests: number;
};

type DailyUsage = UsageBreakdown & { date: string };

type AiUsage = {
  usedNeurons: number;
  estimatedUsedNeurons: number;
  providerReportedUsedNeurons: number | null;
  effectiveUsedNeurons: number;
  officialDailyAllocationNeurons: number;
  officialAllocationRemainingEstimate: number;
  configuredSafetyLimitNeurons: number;
  safetyLimitRemainingNeurons: number;
  safetyLimitOverageNeurons: number;
  safetyLimitUsagePercent: number;
  inputTokens: number;
  outputTokens: number;
  requests: number;
  successfulRequests: number;
  failedRequests: number;
  byModel: UsageBreakdown[];
  byOperation: UsageBreakdown[];
  dailyHistory: DailyUsage[];
  periodStart: string;
  resetAt: string;
  historyStart: string;
  lastUpdatedAt: string | null;
  usageSource: 'estimated_from_recorded_tokens';
  providerUsageAvailable: false;
  providerUsageMessage: string;
  quota: {
    warningThresholdPercent: number;
    criticalThresholdPercent: number;
    stopThresholdPercent: number;
    level: 'normal' | 'warning' | 'critical' | 'stopped';
    configuredFallbackMode: string;
    currentGlobalMode: string;
    autoReplyEnabled: boolean;
    safeModeApplied: boolean;
  };
};

type AssistantMessage = { role: 'admin' | 'assistant'; text: string };

const quotaLabel: Record<AiUsage['quota']['level'], string> = {
  normal: 'Normal',
  warning: 'Uyarı',
  critical: 'Kritik',
  stopped: 'Güvenli mod'
};

export function AiPage({ notify }: { notify: Notify }) {
  const [settings, setSettings] = useState<AiSettings | null>(null);
  const [usage, setUsage] = useState<AiUsage | null>(null);
  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [threadId, setThreadId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [training, setTraining] = useState({ title: '', category: 'Genel', content: '', approve: false });

  const load = useCallback(() => {
    void Promise.all([api<AiSettings>('/api/ai/settings'), api<AiUsage>('/api/ai/usage')])
      .then(([settingsValue, usageValue]) => {
        setSettings(settingsValue);
        setUsage(usageValue);
      })
      .catch(error => notify(error.message, 'error'));
  }, [notify]);

  useEffect(() => { load(); }, [load]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!settings) return;
    const form = event.currentTarget;
    const input = {
      ...settings,
      globalMode: formValue(form, 'globalMode'),
      autoReplyEnabled: new FormData(form).get('autoReplyEnabled') === 'on',
      suggestionMode: new FormData(form).get('suggestionMode') === 'on',
      businessInstructions: formValue(form, 'instructions'),
      handoffRules: formValue(form, 'handoffRules').split('\n').map(value => value.trim()).filter(Boolean),
      minimumConfidence: Number(formValue(form, 'confidence')),
      recentMessageCount: Number(formValue(form, 'messages')),
      debounceSeconds: Number(formValue(form, 'debounce'))
    };
    try {
      await api('/api/ai/settings', { method: 'PUT', ...jsonBody(input) });
      setSettings(input as AiSettings);
      notify('AI talimatları ve güvenlik kuralları kaydedildi.', 'success');
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Ayarlar kaydedilemedi.', 'error');
    }
  }

  async function saveNeuronLimit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      const result = await api<AiUsage>('/api/ai/usage-limit', {
        method: 'PUT',
        ...jsonBody({ entitlementNeurons: Number(formValue(form, 'entitlementNeurons')) })
      });
      setUsage(result);
      notify('Yapılandırılmış Neuron güvenlik limiti güncellendi.', 'success');
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Neuron güvenlik limiti güncellenemedi.', 'error');
    }
  }

  async function emergency() {
    if (!window.confirm('AI otomatik cevapları hemen durdurulsun mu?')) return;
    try {
      await api('/api/ai/emergency-stop', { method: 'POST' });
      load();
      notify('AI acil olarak durduruldu.', 'success');
    } catch (error) {
      notify(error instanceof Error ? error.message : 'AI durdurulamadı.', 'error');
    }
  }

  async function chat(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const message = formValue(form, 'message');
    if (!message) return;
    setBusy(true);
    setMessages(current => [...current, { role: 'admin', text: message }]);
    form.reset();
    try {
      const result = await api<{ threadId: string; answer: string }>('/api/ai/assistant', {
        method: 'POST',
        ...jsonBody({ threadId, message })
      });
      setThreadId(result.threadId);
      setMessages(current => [...current, { role: 'assistant', text: result.answer }]);
      setTraining(current => ({ ...current, content: result.answer }));
    } catch (error) {
      notify(error instanceof Error ? error.message : 'AI cevap veremedi.', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function saveTraining(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      await api('/api/ai/training', {
        method: 'POST',
        ...jsonBody({ ...training, usagePermission: 'both', sourceThreadId: threadId })
      });
      notify(training.approve ? 'Eğitim onaylandı ve Vectorize kuyruğuna alındı.' : 'Eğitim taslak olarak kaydedildi.', 'success');
      setTraining({ title: '', category: 'Genel', content: '', approve: false });
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Eğitim kaydedilemedi.', 'error');
    }
  }

  if (!settings) return <section className="panel"><div className="loader" /></section>;

  return <div className="page-stack">
    <section className="panel">
      <div className="panel-heading">
        <div>
          <h3>Workers AI / Neuron Muhasebesi</h3>
          <p>Sağlayıcı hesabından kesin değer okunamadığında uygulama yalnız kendi kaydettiği tokenlardan hesaplanan tahmini gösterir.</p>
        </div>
        <span className={`pill ${(usage?.safetyLimitUsagePercent ?? 0) >= 90 ? 'warn' : 'ready'}`}>
          %{formatNumber(usage?.safetyLimitUsagePercent ?? 0)} · {usage ? quotaLabel[usage.quota.level] : '—'}
        </span>
      </div>

      <section className="metrics neuron-metrics">
        <article className="metric"><span>Bugün kullanılan</span><strong>{formatNumber(usage?.effectiveUsedNeurons)}</strong><small>Tahmini Neuron</small></article>
        <article className="metric"><span>Resmî günlük tahsis</span><strong>{formatNumber(usage?.officialDailyAllocationNeurons ?? 10000)}</strong><small>Cloudflare ücretsiz dahil hak</small></article>
        <article className="metric"><span>Resmî tahsise kalan</span><strong>{formatNumber(usage?.officialAllocationRemainingEstimate)}</strong><small>Yalnız bu uygulamaya göre tahmin</small></article>
        <article className="metric"><span>Güvenlik limiti</span><strong>{formatNumber(usage?.configuredSafetyLimitNeurons)}</strong><small>Yönetici yapılandırması</small></article>
        <article className="metric"><span>Güvenlik limitine kalan</span><strong>{formatNumber(usage?.safetyLimitRemainingNeurons)}</strong><small>Aşım: {formatNumber(usage?.safetyLimitOverageNeurons)}</small></article>
        <article className="metric"><span>Girdi / çıktı tokenı</span><strong>{formatNumber(usage?.inputTokens)} / {formatNumber(usage?.outputTokens)}</strong></article>
        <article className="metric"><span>Başarılı / toplam</span><strong>{usage ? `${usage.successfulRequests}/${usage.requests}` : '—'}</strong></article>
        <article className="metric"><span>Son güncelleme</span><strong>{usage?.lastUpdatedAt ? formatDate(usage.lastUpdatedAt) : 'Henüz kullanım yok'}</strong></article>
      </section>

      <div className="neuron-progress" aria-label="Yapılandırılmış güvenlik limiti kullanım oranı">
        <i style={{ width: `${Math.min(100, usage?.safetyLimitUsagePercent ?? 0)}%` }} />
      </div>

      <div className="neuron-source-note">
        <strong>Veri kaynağı: Hesaplanan tahmin</strong>
        <p>{usage?.providerUsageMessage ?? 'Kullanım kaynağı yükleniyor.'}</p>
        <small>Sonraki günlük sıfırlanma: {usage ? formatDate(usage.resetAt) : '—'} · Dönem başlangıcı: {usage ? formatDate(usage.periodStart) : '—'}</small>
      </div>

      <div className="neuron-quota-row">
        <span>Uyarı eşiği: %{usage?.quota.warningThresholdPercent ?? 70}</span>
        <span>Kritik eşik: %{usage?.quota.criticalThresholdPercent ?? 90}</span>
        <span>Durdurma eşiği: %{usage?.quota.stopThresholdPercent ?? 100}</span>
        <span>Kota dolunca güvenli mod: <b>{usage?.quota.configuredFallbackMode ?? 'suggestion'}</b></span>
        <span>Mevcut global mod: <b>{usage?.quota.currentGlobalMode ?? '—'}</b></span>
      </div>

      <form className="inline-fields" onSubmit={saveNeuronLimit}>
        <label>Yapılandırılmış günlük güvenlik limiti
          <input name="entitlementNeurons" type="number" min="1" max="100000000" defaultValue={usage?.configuredSafetyLimitNeurons ?? 10000} required />
        </label>
        <div className="form-actions"><button className="button secondary">Güvenlik Limitini Kaydet</button></div>
      </form>
    </section>

    <section className="grid-two">
      <UsageList title="Modele göre bugünkü kullanım" items={usage?.byModel ?? []} />
      <UsageList title="İşlem türüne göre bugünkü kullanım" items={usage?.byOperation ?? []} />
    </section>

    <section className="panel">
      <div className="panel-heading"><div><h3>30 Günlük Neuron Geçmişi</h3><p>Eksik günler sıfır değerle gösterilir; tüm değerler uygulama içi tahmindir.</p></div></div>
      <div className="neuron-history-wrap">
        <table className="neuron-history">
          <thead><tr><th>Gün</th><th>Neuron</th><th>Girdi</th><th>Çıktı</th><th>Başarılı</th><th>Başarısız</th></tr></thead>
          <tbody>{(usage?.dailyHistory ?? []).map(day => <tr key={day.date}>
            <td>{day.date}</td><td>{formatNumber(day.estimatedNeurons)}</td><td>{formatNumber(day.inputTokens)}</td><td>{formatNumber(day.outputTokens)}</td><td>{day.successfulRequests}</td><td>{day.failedRequests}</td>
          </tr>)}</tbody>
        </table>
      </div>
    </section>

    <section className="panel danger-panel">
      <div><h3>ACİL AI DURDUR</h3><p>Kuyruktaki AI işleri iptal edilir ve otomatik yanıt kapatılır.</p></div>
      <button className="button danger-button" onClick={() => void emergency()}>AI’ı Hemen Durdur</button>
    </section>

    <section className="grid-two">
      <div className="panel">
        <h3>AI Davranış ve Devir Kuralları</h3>
        <form className="form-stack" onSubmit={save}>
          <label>Global mod<select name="globalMode" defaultValue={settings.globalMode}><option value="off">Tamamen kapalı</option><option value="suggestion">Yalnız öneri</option><option value="auto">Otomatik cevap</option><option value="business_hours">Mesai saatlerinde otomatik</option></select></label>
          <label className="check"><input name="autoReplyEnabled" type="checkbox" defaultChecked={settings.autoReplyEnabled} />Otomatik cevap açık</label>
          <label className="check"><input name="suggestionMode" type="checkbox" defaultChecked={settings.suggestionMode} />Öneri modu açık</label>
          <label>İşletme talimatları<textarea name="instructions" rows={10} defaultValue={settings.businessInstructions} placeholder="AI’ın bilmesi gereken işletme kuralları…" /></label>
          <label>İnsan devri kuralları<textarea name="handoffRules" rows={8} defaultValue={settings.handoffRules.join('\n')} placeholder="Her satıra bir devir kuralı" /></label>
          <div className="inline-fields">
            <label>Minimum güven<input name="confidence" type="number" min="0.1" max="1" step="0.01" defaultValue={settings.minimumConfidence} /></label>
            <label>Son mesaj sayısı<input name="messages" type="number" min="4" max="20" defaultValue={settings.recentMessageCount} /></label>
            <label>Bekleme saniyesi<input name="debounce" type="number" min="1" max="60" defaultValue={settings.debounceSeconds} /></label>
          </div>
          <button className="button primary">AI Ayarlarını Kaydet</button>
        </form>
      </div>

      <div className="panel ai-console">
        <div><h3>Yönetici AI Asistanı</h3><p>AI ile konuşun, müşteri görüşmelerini analiz ettirin ve eğitim taslağı hazırlayın.</p></div>
        <div className="console-messages">
          {messages.map((item, index) => <article key={index} className={item.role}><strong>{item.role === 'admin' ? 'Siz' : 'AI'}</strong><p>{item.text}</p></article>)}
          {!messages.length && <Empty text="AI’a bir soru sorun veya öğretmek istediğiniz kuralı yazın." />}
        </div>
        <form className="console-form" onSubmit={chat}>
          <textarea name="message" required rows={4} placeholder="Örn: Fiyat pazarlığı olduğunda beni devreye sok ve kesin rakam verme." />
          <button className="button primary" disabled={busy}>{busy ? 'Yanıt hazırlanıyor…' : 'AI ile Konuş'}</button>
        </form>
        <hr />
        <h3>Eğitimi Bilgi Bankasına Kaydet</h3>
        <form className="form-stack" onSubmit={saveTraining}>
          <label>Başlık<input value={training.title} onChange={event => setTraining({ ...training, title: event.target.value })} required /></label>
          <label>Kategori<input value={training.category} onChange={event => setTraining({ ...training, category: event.target.value })} required /></label>
          <label>İçerik<textarea value={training.content} onChange={event => setTraining({ ...training, content: event.target.value })} rows={7} required /></label>
          <label className="check"><input type="checkbox" checked={training.approve} onChange={event => setTraining({ ...training, approve: event.target.checked })} />Doğrudan onayla ve Vectorize’a işle</label>
          <button className="button secondary">Eğitim Kaydını Oluştur</button>
        </form>
      </div>
    </section>
  </div>;
}

function UsageList({ title, items }: { title: string; items: UsageBreakdown[] }) {
  return <section className="panel">
    <h3>{title}</h3>
    <div className="knowledge-list">
      {items.map(item => <article key={item.key}>
        <div><span>{item.requests} işlem · {item.failedRequests} başarısız</span><h4>{item.key}</h4><p>{formatNumber(item.estimatedNeurons)} tahmini Neuron</p><small>Girdi {formatNumber(item.inputTokens)} · Çıktı {formatNumber(item.outputTokens)}</small></div>
      </article>)}
    </div>
    {!items.length && <Empty text="Bugün için kullanım kaydı yok." />}
  </section>;
}
