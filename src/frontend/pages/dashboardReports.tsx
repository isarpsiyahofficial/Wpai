import { useEffect, useState } from 'react';
import { api } from '../api';
import type { Notify, PageId } from '../types';
import { Empty, formatNumber } from './core';

type AiUsage = {
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
  lastUpdatedAt: string | null;
  providerUsageAvailable: boolean;
  usageSource: 'estimated_from_recorded_tokens';
  quota: {
    level: 'normal' | 'warning' | 'critical' | 'stopped';
    configuredFallbackMode: string;
    safeModeApplied: boolean;
  };
};

type DashboardData = {
  contacts: number;
  activeConversations: number;
  unreadMessages: number;
  openHandoffs: number;
  failedMessages: number;
  unreadNotifications: number;
};

export function DashboardPage({ notify, openPage }: { notify: Notify; openPage: (page: PageId) => void }) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [usage, setUsage] = useState<AiUsage | null>(null);

  useEffect(() => {
    void Promise.all([api<DashboardData>('/api/dashboard'), api<AiUsage>('/api/ai/usage')])
      .then(([dashboard, neuron]) => { setData(dashboard); setUsage(neuron); })
      .catch((error: Error) => notify(error.message, 'error'));
  }, [notify]);

  const cards: Array<[string, string | number | undefined]> = [
    ['Toplam kişi', data?.contacts],
    ['Aktif konuşma', data?.activeConversations],
    ['Okunmamış mesaj', data?.unreadMessages],
    ['İnsan devri', data?.openHandoffs],
    ['Başarısız mesaj', data?.failedMessages],
    ['Bildirim', data?.unreadNotifications],
    ['Bugün kullanılan tahmini Neuron', usage?.estimatedUsedNeurons],
    ['Resmî günlük tahsis', usage?.officialDailyAllocationNeurons],
    ['Resmî tahsise kalan (uygulama tahmini)', usage?.officialAllocationRemainingEstimate],
    ['Yönetici güvenlik limiti', usage?.configuredSafetyLimitNeurons],
    ['Güvenlik limitine kalan', usage?.safetyLimitRemainingNeurons],
    ['Güvenlik limiti kullanımı', usage ? `%${formatNumber(usage.safetyLimitUsagePercent)}` : undefined]
  ];

  return <div className="page-stack">
    <section className="hero">
      <div>
        <span className="eyebrow">Canlı işletme görünümü</span>
        <h2>Mesajları, müşterileri ve AI kararlarını tek yerden yönetin.</h2>
        <p>Bilgisayar kapalı olsa da Cloudflare mesajları almaya ve güvenli şekilde saklamaya devam eder.</p>
      </div>
      <div className="hero-actions">
        <button className="button primary" onClick={() => openPage('whatsapp')}>WhatsApp Gelen Kutusu</button>
        <button className="button secondary" onClick={() => openPage('ai')}>Neuron Ayrıntıları</button>
      </div>
    </section>
    <section className="metrics">
      {cards.map(([label, value]) => <article className="metric" key={label}>
        <span>{label}</span>
        <strong>{value === undefined ? '—' : typeof value === 'number' ? formatNumber(value) : value}</strong>
      </article>)}
    </section>
    <section className="panel">
      <h3>Neuron verisinin anlamı</h3>
      <div className="check-list">
        <span>✓ Kullanım, uygulamanın kaydettiği tokenlardan hesaplanan tahmindir.</span>
        <span>✓ Resmî günlük tahsis ile yönetici güvenlik limiti birbirinden ayrıdır.</span>
        <span>✓ Sağlayıcı hesap raporu okunamadığında gerçek hesap bakiyesi gösterilmez.</span>
        <span>✓ Güvenlik limiti dolduğunda otomatik yanıt güvenli moda alınır.</span>
      </div>
    </section>
    <section className="panel">
      <h3>Güvenli başlangıç</h3>
      <div className="check-list">
        <span>✓ AI varsayılan olarak kapalıdır.</span>
        <span>✓ Müşteri bağlamları contact_id + conversation_id ile ayrılır.</span>
        <span>✓ Fiyat ve işletme bilgisi yalnız onaylı kayıtlardan alınır.</span>
        <span>✓ Manuel yönetici mesajı AI’ı insan devri moduna alır.</span>
      </div>
    </section>
  </div>;
}

type ReportOverview = {
  daily: Array<{ day: string; total: number }>;
  delivery: Array<{ status: string; total: number }>;
  openHandoffs: number;
  leadStages: Array<{ stage: string; total: number }>;
  ai: { total: number; neurons: number };
};

export function ReportsPage({ notify }: { notify: Notify }) {
  const [data, setData] = useState<ReportOverview | null>(null);
  const [usage, setUsage] = useState<AiUsage | null>(null);

  useEffect(() => {
    void Promise.all([api<ReportOverview>('/api/reports/overview'), api<AiUsage>('/api/ai/usage')])
      .then(([overview, neuron]) => { setData(overview); setUsage(neuron); })
      .catch((error: Error) => notify(error.message, 'error'));
  }, [notify]);

  return <div className="page-stack">
    <section className="metrics">
      <article className="metric"><span>Açık insan devri</span><strong>{data?.openHandoffs ?? '—'}</strong></article>
      <article className="metric"><span>30 günlük AI işlemi</span><strong>{data?.ai?.total ?? '—'}</strong></article>
      <article className="metric"><span>Bugün kullanılan tahmini Neuron</span><strong>{formatNumber(usage?.estimatedUsedNeurons)}</strong></article>
      <article className="metric"><span>Resmî günlük tahsis</span><strong>{formatNumber(usage?.officialDailyAllocationNeurons)}</strong></article>
      <article className="metric"><span>Resmî tahsise kalan (uygulama tahmini)</span><strong>{formatNumber(usage?.officialAllocationRemainingEstimate)}</strong></article>
      <article className="metric"><span>Yönetici güvenlik limiti</span><strong>{formatNumber(usage?.configuredSafetyLimitNeurons)}</strong></article>
      <article className="metric"><span>Güvenlik limitine kalan</span><strong>{formatNumber(usage?.safetyLimitRemainingNeurons)}</strong></article>
      <article className="metric"><span>Güvenlik limiti aşımı</span><strong>{formatNumber(usage?.safetyLimitOverageNeurons)}</strong></article>
      <article className="metric"><span>Güvenlik limiti kullanımı</span><strong>%{formatNumber(usage?.safetyLimitUsagePercent)}</strong></article>
      <article className="metric"><span>Giriş / çıkış tokenı</span><strong>{formatNumber(usage?.inputTokens)} / {formatNumber(usage?.outputTokens)}</strong></article>
      <article className="metric"><span>Sağlayıcı raporu</span><strong>{usage?.providerUsageAvailable ? formatNumber(usage.providerReportedUsedNeurons) : 'Mevcut değil'}</strong></article>
      <article className="metric"><span>Güvenli mod</span><strong>{usage?.quota.safeModeApplied ? 'Uygulandı' : usage?.quota.level ?? '—'}</strong></article>
    </section>
    <section className="panel">
      <h3>30 Günlük Mesaj Trafiği</h3>
      <div className="bar-list">
        {(data?.daily ?? []).map(row => <div key={row.day}><span>{row.day}</span><div><i style={{ width: `${Math.min(100, Number(row.total) * 3)}%` }} /></div><strong>{row.total}</strong></div>)}
      </div>
      {!data?.daily?.length && <Empty text="Rapor oluşturmak için henüz veri yok." />}
    </section>
    <section className="grid-two">
      <div className="panel"><h3>Teslim Durumları</h3>{(data?.delivery ?? []).map(row => <p className="key-value" key={row.status}><span>{row.status}</span><strong>{row.total}</strong></p>)}</div>
      <div className="panel"><h3>Müşteri Aşamaları</h3>{(data?.leadStages ?? []).map(row => <p className="key-value" key={row.stage}><span>{row.stage}</span><strong>{row.total}</strong></p>)}</div>
    </section>
  </div>;
}
