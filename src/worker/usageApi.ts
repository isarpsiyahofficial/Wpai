import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { AppContext } from './types';
import { audit, first, setSetting, setting } from './db';
import { ok, requireAuth } from './http';

export type NeuronUsageSummary = {
  usedNeurons: number;
  entitlementNeurons: number;
  freeAllocationNeurons: number;
  remainingNeurons: number;
  overageNeurons: number;
  usagePercent: number;
  inputTokens: number;
  outputTokens: number;
  requests: number;
  successfulRequests: number;
  failedRequests: number;
  periodStart: string;
  resetAt: string;
  source: 'recorded_workers_ai_usage';
};

const UsageLimitSchema = z.object({
  entitlementNeurons: z.number().int().min(1).max(100_000_000)
});

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
    { entitlementNeurons },
    c.get('requestId')
  );
  return ok(c, await neuronUsageSummary(c.env.DB));
});

export async function neuronUsageSummary(db: D1Database, now = new Date()): Promise<NeuronUsageSummary> {
  const date = now.toISOString().slice(0, 10);
  const row = await first<{
    neurons: number;
    input_tokens: number;
    output_tokens: number;
    requests: number;
    successful: number;
    failed: number;
  }>(db,
    `SELECT COALESCE(SUM(estimated_neurons),0) AS neurons,
            COALESCE(SUM(input_tokens),0) AS input_tokens,
            COALESCE(SUM(output_tokens),0) AS output_tokens,
            COUNT(*) AS requests,
            COALESCE(SUM(CASE WHEN success=1 THEN 1 ELSE 0 END),0) AS successful,
            COALESCE(SUM(CASE WHEN success=0 THEN 1 ELSE 0 END),0) AS failed
       FROM ai_usage_records
      WHERE created_at >= ? AND created_at < ?`,
    `${date}T00:00:00.000Z`, nextUtcDay(date));
  const configured = Number(await setting(db, 'ai_daily_neuron_limit') ?? '10000');
  const entitlement = Number.isFinite(configured) && configured > 0 ? configured : 10_000;
  const used = Math.max(0, Number(row?.neurons ?? 0));
  return {
    usedNeurons: roundNeuron(used),
    entitlementNeurons: roundNeuron(entitlement),
    freeAllocationNeurons: 10_000,
    remainingNeurons: roundNeuron(Math.max(0, entitlement - used)),
    overageNeurons: roundNeuron(Math.max(0, used - entitlement)),
    usagePercent: Math.round((used / entitlement) * 10_000) / 100,
    inputTokens: Number(row?.input_tokens ?? 0),
    outputTokens: Number(row?.output_tokens ?? 0),
    requests: Number(row?.requests ?? 0),
    successfulRequests: Number(row?.successful ?? 0),
    failedRequests: Number(row?.failed ?? 0),
    periodStart: `${date}T00:00:00.000Z`,
    resetAt: nextUtcDay(date),
    source: 'recorded_workers_ai_usage'
  };
}

function nextUtcDay(date: string): string {
  const next = new Date(`${date}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString();
}

function roundNeuron(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
