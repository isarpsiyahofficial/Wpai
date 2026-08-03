import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { AppContext } from './types';
import { all, audit, first, setSetting, setting } from './db';
import { ok, requireAuth } from './http';

type UsageBreakdown = {
  key: string;
  estimatedNeurons: number;
  inputTokens: number;
  outputTokens: number;
  requests: number;
  successfulRequests: number;
  failedRequests: number;
};

type DailyUsage = {
  date: string;
  estimatedNeurons: number;
  inputTokens: number;
  outputTokens: number;
  requests: number;
  successfulRequests: number;
  failedRequests: number;
};

type QuotaLevel = 'normal' | 'warning' | 'critical' | 'stopped';

export type NeuronUsageSummary = {
  /** Backward-compatible alias for effectiveUsedNeurons. */
  usedNeurons: number;
  /** Backward-compatible alias for configuredSafetyLimitNeurons. */
  entitlementNeurons: number;
  /** Backward-compatible alias for officialDailyAllocationNeurons. */
  freeAllocationNeurons: number;
  /** Backward-compatible alias for safetyLimitRemainingNeurons. */
  remainingNeurons: number;
  /** Backward-compatible safety-limit overage. */
  overageNeurons: number;
  /** Percentage of the configured safety limit consumed. */
  usagePercent: number;
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
  source: 'recorded_workers_ai_usage';
  usageSource: 'estimated_from_recorded_tokens';
  providerUsageAvailable: false;
  providerUsageMessage: string;
  quota: {
    warningThresholdPercent: 70;
    criticalThresholdPercent: 90;
    stopThresholdPercent: 100;
    level: QuotaLevel;
    configuredFallbackMode: string;
    currentGlobalMode: string;
    autoReplyEnabled: boolean;
    safeModeApplied: boolean;
  };
};

const UsageLimitSchema = z.object({
  entitlementNeurons: z.number().int().min(1).max(100_000_000)
});

const OFFICIAL_DAILY_ALLOCATION = 10_000;

export const usageApiRoutes = new Hono<AppContext>();
usageApiRoutes.use('*', requireAuth);

usageApiRoutes.get('/ai/usage', async c => ok(c, await neuronUsageSummary(c.env.DB)));

usageApiRoutes.put('/ai/usage-limit', zValidator('json', UsageLimitSchema), async c => {
  const { entitlementNeurons } = c.req.valid('json');
  await setSetting(c.env.DB, 'ai_daily_neuron_limit', entitlementNeurons, c.get('adminId'));
  await audit(
    c.env.DB,
    c.get('adminId')!,
    'ai.neuron_limit_changed',
    'system',
    null,
    { entitlementNeurons, meaning: 'configured_safety_limit' },
    c.get('requestId')
  );
  return ok(c, await neuronUsageSummary(c.env.DB));
});

export async function neuronUsageSummary(db: D1Database, now = new Date()): Promise<NeuronUsageSummary> {
  const date = now.toISOString().slice(0, 10);
  const periodStart = `${date}T00:00:00.000Z`;
  const resetAt = nextUtcDay(date);
  const historyStartDate = shiftUtcDate(date, -29);
  const historyStart = `${historyStartDate}T00:00:00.000Z`;

  const row = await first<{
    neurons: number | null;
    input_tokens: number | null;
    output_tokens: number | null;
    requests: number | null;
    successful: number | null;
    failed: number | null;
    last_updated_at: string | null;
  }>(db,
    `SELECT COALESCE(SUM(estimated_neurons),0) AS neurons,
            COALESCE(SUM(input_tokens),0) AS input_tokens,
            COALESCE(SUM(output_tokens),0) AS output_tokens,
            COUNT(*) AS requests,
            COALESCE(SUM(CASE WHEN success=1 THEN 1 ELSE 0 END),0) AS successful,
            COALESCE(SUM(CASE WHEN success=0 THEN 1 ELSE 0 END),0) AS failed,
            MAX(created_at) AS last_updated_at
       FROM ai_usage_records
      WHERE created_at >= ? AND created_at < ?`,
    periodStart, resetAt);

  const byModelRows = await all<{
    key: string;
    neurons: number | null;
    input_tokens: number | null;
    output_tokens: number | null;
    requests: number | null;
    successful: number | null;
    failed: number | null;
  }>(db,
    `SELECT model AS key,
            COALESCE(SUM(estimated_neurons),0) AS neurons,
            COALESCE(SUM(input_tokens),0) AS input_tokens,
            COALESCE(SUM(output_tokens),0) AS output_tokens,
            COUNT(*) AS requests,
            COALESCE(SUM(CASE WHEN success=1 THEN 1 ELSE 0 END),0) AS successful,
            COALESCE(SUM(CASE WHEN success=0 THEN 1 ELSE 0 END),0) AS failed
       FROM ai_usage_records
      WHERE created_at >= ? AND created_at < ?
      GROUP BY model
      ORDER BY neurons DESC, model ASC`,
    periodStart, resetAt);

  const byOperationRows = await all<{
    key: string;
    neurons: number | null;
    input_tokens: number | null;
    output_tokens: number | null;
    requests: number | null;
    successful: number | null;
    failed: number | null;
  }>(db,
    `SELECT operation_type AS key,
            COALESCE(SUM(estimated_neurons),0) AS neurons,
            COALESCE(SUM(input_tokens),0) AS input_tokens,
            COALESCE(SUM(output_tokens),0) AS output_tokens,
            COUNT(*) AS requests,
            COALESCE(SUM(CASE WHEN success=1 THEN 1 ELSE 0 END),0) AS successful,
            COALESCE(SUM(CASE WHEN success=0 THEN 1 ELSE 0 END),0) AS failed
       FROM ai_usage_records
      WHERE created_at >= ? AND created_at < ?
      GROUP BY operation_type
      ORDER BY neurons DESC, operation_type ASC`,
    periodStart, resetAt);

  const dailyRows = await all<{
    date: string;
    neurons: number | null;
    input_tokens: number | null;
    output_tokens: number | null;
    requests: number | null;
    successful: number | null;
    failed: number | null;
  }>(db,
    `SELECT substr(created_at,1,10) AS date,
            COALESCE(SUM(estimated_neurons),0) AS neurons,
            COALESCE(SUM(input_tokens),0) AS input_tokens,
            COALESCE(SUM(output_tokens),0) AS output_tokens,
            COUNT(*) AS requests,
            COALESCE(SUM(CASE WHEN success=1 THEN 1 ELSE 0 END),0) AS successful,
            COALESCE(SUM(CASE WHEN success=0 THEN 1 ELSE 0 END),0) AS failed
       FROM ai_usage_records
      WHERE created_at >= ? AND created_at < ?
      GROUP BY substr(created_at,1,10)
      ORDER BY date ASC`,
    historyStart, resetAt);

  const configured = Number(await setting(db, 'ai_daily_neuron_limit') ?? String(OFFICIAL_DAILY_ALLOCATION));
  const safetyLimit = Number.isFinite(configured) && configured > 0 ? configured : OFFICIAL_DAILY_ALLOCATION;
  const estimatedUsed = Math.max(0, Number(row?.neurons ?? 0));
  const effectiveUsed = estimatedUsed;
  const safetyPercent = Math.round((effectiveUsed / safetyLimit) * 10_000) / 100;
  const fallbackMode = await setting(db, 'ai_quota_fallback_mode') ?? 'suggestion';
  const currentGlobalMode = await setting(db, 'ai_global_mode') ?? 'off';
  const autoReplyEnabled = (await setting(db, 'ai_auto_reply_enabled')) === 'true';
  const quotaLevel = levelFor(safetyPercent);

  return {
    usedNeurons: roundNeuron(effectiveUsed),
    entitlementNeurons: roundNeuron(safetyLimit),
    freeAllocationNeurons: OFFICIAL_DAILY_ALLOCATION,
    remainingNeurons: roundNeuron(Math.max(0, safetyLimit - effectiveUsed)),
    overageNeurons: roundNeuron(Math.max(0, effectiveUsed - safetyLimit)),
    usagePercent: safetyPercent,
    estimatedUsedNeurons: roundNeuron(estimatedUsed),
    providerReportedUsedNeurons: null,
    effectiveUsedNeurons: roundNeuron(effectiveUsed),
    officialDailyAllocationNeurons: OFFICIAL_DAILY_ALLOCATION,
    officialAllocationRemainingEstimate: roundNeuron(Math.max(0, OFFICIAL_DAILY_ALLOCATION - estimatedUsed)),
    configuredSafetyLimitNeurons: roundNeuron(safetyLimit),
    safetyLimitRemainingNeurons: roundNeuron(Math.max(0, safetyLimit - effectiveUsed)),
    safetyLimitOverageNeurons: roundNeuron(Math.max(0, effectiveUsed - safetyLimit)),
    safetyLimitUsagePercent: safetyPercent,
    inputTokens: Number(row?.input_tokens ?? 0),
    outputTokens: Number(row?.output_tokens ?? 0),
    requests: Number(row?.requests ?? 0),
    successfulRequests: Number(row?.successful ?? 0),
    failedRequests: Number(row?.failed ?? 0),
    byModel: byModelRows.map(toBreakdown),
    byOperation: byOperationRows.map(toBreakdown),
    dailyHistory: fillDailyHistory(historyStartDate, date, dailyRows),
    periodStart,
    resetAt,
    historyStart,
    lastUpdatedAt: row?.last_updated_at ?? null,
    source: 'recorded_workers_ai_usage',
    usageSource: 'estimated_from_recorded_tokens',
    providerUsageAvailable: false,
    providerUsageMessage: 'Cloudflare sağlayıcı hesabından gerçek zamanlı Neuron toplamı okunamadığı için bu değer, uygulamanın kaydettiği tokenlar ve resmî model katsayılarından hesaplanan tahmindir.',
    quota: {
      warningThresholdPercent: 70,
      criticalThresholdPercent: 90,
      stopThresholdPercent: 100,
      level: quotaLevel,
      configuredFallbackMode: fallbackMode,
      currentGlobalMode,
      autoReplyEnabled,
      safeModeApplied: quotaLevel === 'stopped' && (currentGlobalMode === fallbackMode || !autoReplyEnabled)
    }
  };
}

function toBreakdown(row: {
  key: string;
  neurons: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  requests: number | null;
  successful: number | null;
  failed: number | null;
}): UsageBreakdown {
  return {
    key: row.key,
    estimatedNeurons: roundNeuron(Number(row.neurons ?? 0)),
    inputTokens: Number(row.input_tokens ?? 0),
    outputTokens: Number(row.output_tokens ?? 0),
    requests: Number(row.requests ?? 0),
    successfulRequests: Number(row.successful ?? 0),
    failedRequests: Number(row.failed ?? 0)
  };
}

function fillDailyHistory(
  firstDate: string,
  lastDate: string,
  rows: Array<{
    date: string;
    neurons: number | null;
    input_tokens: number | null;
    output_tokens: number | null;
    requests: number | null;
    successful: number | null;
    failed: number | null;
  }>
): DailyUsage[] {
  const byDate = new Map(rows.map(row => [row.date, row]));
  const result: DailyUsage[] = [];
  let date = firstDate;
  while (date <= lastDate) {
    const row = byDate.get(date);
    result.push({
      date,
      estimatedNeurons: roundNeuron(Number(row?.neurons ?? 0)),
      inputTokens: Number(row?.input_tokens ?? 0),
      outputTokens: Number(row?.output_tokens ?? 0),
      requests: Number(row?.requests ?? 0),
      successfulRequests: Number(row?.successful ?? 0),
      failedRequests: Number(row?.failed ?? 0)
    });
    date = shiftUtcDate(date, 1);
  }
  return result;
}

function levelFor(percent: number): QuotaLevel {
  if (percent >= 100) return 'stopped';
  if (percent >= 90) return 'critical';
  if (percent >= 70) return 'warning';
  return 'normal';
}

function nextUtcDay(date: string): string {
  return `${shiftUtcDate(date, 1)}T00:00:00.000Z`;
}

function shiftUtcDate(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function roundNeuron(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
