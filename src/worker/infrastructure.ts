import type { InfrastructureComponent, InfrastructureReport } from '../shared/contracts';

const manifest = {
  worker: 'wa-ai-panel',
  d1: 'wa-ai-prod',
  r2: 'wa-ai-files-prod',
  queues: ['wa-inbound-ai', 'wa-outbound', 'wa-admin-notify', 'wa-ai-dlq', 'wa-outbound-dlq'],
  vectorize: 'wpai-knowledge'
} as const;

type CfEnvelope<T> = { success: boolean; errors?: Array<{ code: number; message: string }>; result: T };

async function cf<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init?.headers ?? {}) }
  });
  const body = await response.json<CfEnvelope<T>>();
  if (!response.ok || !body.success) throw new Error(`CLOUDFLARE_API_${response.status}_${body.errors?.[0]?.code ?? 'UNKNOWN'}`);
  return body.result;
}

export async function scanInfrastructure(accountId: string, token: string): Promise<InfrastructureReport> {
  const verified = await cf<{ status: string }>('/user/tokens/verify', token);
  if (verified.status !== 'active') throw new Error('CLOUDFLARE_TOKEN_INACTIVE');
  const account = await cf<{ id: string; name: string }>(token, `/accounts/${accountId}`);
  if (account.id !== accountId) throw new Error('CLOUDFLARE_ACCOUNT_MISMATCH');

  const [d1, r2, queues, scripts, indexes] = await Promise.all([
    cf<Array<{ uuid: string; name: string }>>(token, `/accounts/${accountId}/d1/database`),
    cf<{ buckets: Array<{ name: string }> } | Array<{ name: string }>>(token, `/accounts/${accountId}/r2/buckets`),
    cf<Array<{ queue_id: string; queue_name: string }>>(token, `/accounts/${accountId}/queues`),
    cf<Array<{ id: string }>>(token, `/accounts/${accountId}/workers/scripts`),
    cf<Array<{ name: string; config?: { dimensions?: number; metric?: string } }>>(token, `/accounts/${accountId}/vectorize/v2/indexes`)
  ]);
  const buckets = Array.isArray(r2) ? r2 : r2.buckets;
  const components: InfrastructureComponent[] = [];
  const d1Item = d1.find(item => item.name === manifest.d1);
  components.push(component('d1', 'D1 veritabanı', Boolean(d1Item), d1Item?.uuid, manifest.d1, true));
  const r2Item = buckets.find(item => item.name === manifest.r2);
  components.push(component('r2', 'R2 dosya alanı', Boolean(r2Item), r2Item?.name, manifest.r2, true));
  for (const name of manifest.queues) {
    const item = queues.find(queue => queue.queue_name === name);
    components.push(component(`queue:${name}`, `Queue: ${name}`, Boolean(item), item?.queue_id, name, true));
  }
  const worker = scripts.find(script => script.id === manifest.worker);
  components.push(component('worker', 'Worker uygulaması', Boolean(worker), worker?.id, manifest.worker, false, worker ? undefined : 'Worker deploy işlemi imzalı uygulama paketi gerektirir.'));
  const vector = indexes.find(index => index.name === manifest.vectorize);
  const vectorCorrect = Boolean(vector && vector.config?.dimensions === 1024 && (!vector.config.metric || vector.config.metric === 'cosine'));
  components.push({ key: 'vectorize', label: 'Vectorize bilgi indeksi', status: !vector ? 'missing' : vectorCorrect ? 'ready' : 'misconfigured', current: vector ? `${vector.name} / ${vector.config?.dimensions ?? '?'} / ${vector.config?.metric ?? '?'}` : undefined, expected: `${manifest.vectorize} / 1024 / cosine`, repairable: !vector, details: vector && !vectorCorrect ? 'Yanlış boyutlu indeks otomatik silinmez; yeni isim için açık onay gerekir.' : undefined });
  const plan = components.filter(item => item.status !== 'ready').map(item => ({ action: item.status === 'missing' ? 'create' : 'review', resource: item.key, destructive: false, paid: false }));
  return { accountId, accountName: account.name, checkedAt: new Date().toISOString(), overall: components.every(item => item.status === 'ready') ? 'ready' : components.some(item => item.status === 'blocked') ? 'blocked' : 'repair_required', components, plan };
}

function component(key: string, label: string, exists: boolean, current: string | undefined, expected: string, repairable: boolean, details?: string): InfrastructureComponent {
  return { key, label, status: exists ? 'ready' : 'missing', ...(current ? { current } : {}), expected, repairable, ...(details ? { details } : {}) };
}

export async function repairInfrastructure(accountId: string, token: string, selectedActions: string[]): Promise<{ applied: string[]; report: InfrastructureReport }> {
  const before = await scanInfrastructure(accountId, token);
  const allowed = new Set(selectedActions);
  const applied: string[] = [];
  for (const item of before.components) {
    if (item.status !== 'missing' || !item.repairable || !allowed.has(item.key)) continue;
    if (item.key === 'd1') {
      await cf(token, `/accounts/${accountId}/d1/database`, { method: 'POST', body: JSON.stringify({ name: manifest.d1 }) });
    } else if (item.key === 'r2') {
      await cf(token, `/accounts/${accountId}/r2/buckets/${manifest.r2}`, { method: 'PUT', body: JSON.stringify({}) });
    } else if (item.key.startsWith('queue:')) {
      const name = item.key.slice('queue:'.length);
      if (!manifest.queues.includes(name as typeof manifest.queues[number])) throw new Error('RESOURCE_OUTSIDE_PROJECT_SCOPE');
      await cf(token, `/accounts/${accountId}/queues`, { method: 'POST', body: JSON.stringify({ queue_name: name }) });
    } else if (item.key === 'vectorize') {
      await cf(token, `/accounts/${accountId}/vectorize/v2/indexes`, { method: 'POST', body: JSON.stringify({ name: manifest.vectorize, config: { dimensions: 1024, metric: 'cosine' } }) });
    } else {
      throw new Error('UNSUPPORTED_REPAIR');
    }
    applied.push(item.key);
  }
  return { applied, report: await scanInfrastructure(accountId, token) };
}

export { manifest as projectInfrastructureManifest };
