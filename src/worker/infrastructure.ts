import type { InfrastructureComponent, InfrastructureReport } from '../shared/contracts';

const manifest = {
  accountId: 'ad8e99c82c6c17d823f6877ff1efade4',
  worker: 'wa-ai-panel',
  d1: 'wa-ai-prod',
  d1Id: '81983219-f57b-487b-8144-7c70bf9b1fe2',
  r2: 'wa-ai-files-prod',
  existingQueues: ['wa-inbound-ai', 'wa-outbound', 'wa-admin-notify', 'wa-ai-dlq', 'wa-outbound-dlq'],
  knowledgeQueue: 'wa-knowledge-index',
  vectorize: 'wa-ai-knowledge-prod',
  vectorDimensions: 1024,
  vectorMetric: 'cosine'
} as const;

const allQueues = [...manifest.existingQueues, manifest.knowledgeQueue] as const;
type CfEnvelope<T> = { success: boolean; errors?: Array<{ code?: number; message?: string }>; result: T };
type QueueRecord = { queue_id?: string; queue_name?: string; id?: string; name?: string };

async function cf<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...(init?.headers ?? {}) }
  });
  let body: CfEnvelope<T> | null = null;
  try { body = await response.json<CfEnvelope<T>>(); } catch { /* safe */ }
  if (!response.ok || !body?.success) throw new Error(`CLOUDFLARE_API_${response.status}_${body?.errors?.[0]?.code ?? 'UNKNOWN'}`);
  return body.result;
}

function list<T>(value: T[] | Record<string, T[]> | null | undefined, keys: string[]): T[] {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  for (const key of keys) {
    const found = (value as Record<string, unknown>)[key];
    if (Array.isArray(found)) return found as T[];
  }
  return [];
}

export async function scanInfrastructure(accountId: string, token: string): Promise<InfrastructureReport> {
  if (accountId !== manifest.accountId) throw new Error('CLOUDFLARE_ACCOUNT_MISMATCH');
  const verified = await cf<{ status: string }>(token, '/user/tokens/verify');
  if (verified.status !== 'active') throw new Error('CLOUDFLARE_TOKEN_INACTIVE');
  const account = await cf<{ id: string; name: string }>(token, `/accounts/${accountId}`);
  if (account.id !== accountId) throw new Error('CLOUDFLARE_ACCOUNT_MISMATCH');

  const [d1Raw, r2Raw, queuesRaw, scriptsRaw, indexesRaw] = await Promise.all([
    cf<Array<{ uuid: string; name: string }> | { databases: Array<{ uuid: string; name: string }> }>(token, `/accounts/${accountId}/d1/database`),
    cf<Array<{ name: string }> | { buckets: Array<{ name: string }> }>(token, `/accounts/${accountId}/r2/buckets`),
    cf<QueueRecord[] | { queues: QueueRecord[] }>(token, `/accounts/${accountId}/queues`),
    cf<Array<{ id?: string; name?: string }> | { scripts: Array<{ id?: string; name?: string }> }>(token, `/accounts/${accountId}/workers/scripts`),
    cf<Array<{ name: string; config?: { dimensions?: number; metric?: string } }> | { indexes: Array<{ name: string; config?: { dimensions?: number; metric?: string } }> }>(token, `/accounts/${accountId}/vectorize/v2/indexes`)
  ]);

  const d1 = list(d1Raw, ['databases']);
  const buckets = list(r2Raw, ['buckets']);
  const queues = list(queuesRaw, ['queues']).map(queue => ({ id: queue.queue_id ?? queue.id, name: queue.queue_name ?? queue.name }));
  const scripts = list(scriptsRaw, ['scripts']);
  const indexes = list(indexesRaw, ['indexes']);
  const components: InfrastructureComponent[] = [];

  const database = d1.find(item => item.name === manifest.d1);
  components.push(component(
    'd1', 'D1 veritabanı', Boolean(database), database?.uuid,
    `${manifest.d1} / ${manifest.d1Id}`, false,
    database && database.uuid !== manifest.d1Id
      ? 'Aynı adlı D1 beklenen kimlikle eşleşmiyor. Veri kaybı riski nedeniyle otomatik değiştirilmez.'
      : database ? undefined : 'Mevcut production D1 otomatik yeniden oluşturulmaz.',
    database && database.uuid !== manifest.d1Id ? 'misconfigured' : undefined
  ));

  const bucket = buckets.find(item => item.name === manifest.r2);
  components.push(component('r2', 'R2 özel dosya alanı', Boolean(bucket), bucket?.name, manifest.r2, false,
    bucket ? undefined : 'Mevcut production R2 otomatik yeniden oluşturulmaz.'));

  for (const name of allQueues) {
    const queue = queues.find(item => item.name === name);
    const isAllowedNewQueue = name === manifest.knowledgeQueue;
    components.push(component(
      `queue:${name}`, `Queue: ${name}`, Boolean(queue), queue?.id, name,
      isAllowedNewQueue,
      !queue && !isAllowedNewQueue ? 'Mevcut production Queue otomatik yeniden oluşturulmaz.' : undefined
    ));
  }

  const worker = scripts.find(script => (script.id ?? script.name) === manifest.worker);
  components.push(component('worker', 'Worker uygulaması', Boolean(worker), worker?.id ?? worker?.name, manifest.worker, false,
    worker ? undefined : 'Worker yalnız test edilmiş deployment workflow’u ile dağıtılır.'));

  const vector = indexes.find(index => index.name === manifest.vectorize);
  const vectorCorrect = Boolean(vector
    && vector.config?.dimensions === manifest.vectorDimensions
    && (vector.config.metric ?? manifest.vectorMetric) === manifest.vectorMetric);
  components.push({
    key: 'vectorize',
    label: 'Bulut bilgi indeksi',
    status: !vector ? 'missing' : vectorCorrect ? 'ready' : 'misconfigured',
    ...(vector ? { current: `${vector.name} / ${vector.config?.dimensions ?? '?'} / ${vector.config?.metric ?? '?'}` } : {}),
    expected: `${manifest.vectorize} / ${manifest.vectorDimensions} / ${manifest.vectorMetric}`,
    repairable: !vector,
    ...(vector && !vectorCorrect ? { details: 'Yanlış boyutlu indeks silinmez veya üzerine yazılmaz; manuel inceleme gerekir.' } : {})
  });

  components.push({
    key: 'safety',
    label: 'Onarım güvenlik sınırı',
    status: 'ready',
    current: 'Yalnız wa-ai-knowledge-prod ve wa-knowledge-index oluşturulabilir',
    expected: 'Silme, DNS, domain, plan ve mevcut veri kaynağı işlemleri kapalı',
    repairable: false
  });

  const blocked = components.some(item => item.status === 'blocked');
  const plan = components.filter(item => item.status !== 'ready').map(item => ({
    action: item.repairable ? 'create' : 'review', resource: item.key, destructive: false, paid: false
  }));
  return {
    accountId,
    accountName: account.name,
    checkedAt: new Date().toISOString(),
    overall: components.every(item => item.status === 'ready') ? 'ready' : blocked ? 'blocked' : 'repair_required',
    components,
    plan
  };
}

function component(
  key: string,
  label: string,
  exists: boolean,
  current: string | undefined,
  expected: string,
  repairable: boolean,
  details?: string,
  forcedStatus?: InfrastructureComponent['status']
): InfrastructureComponent {
  return {
    key,
    label,
    status: forcedStatus ?? (exists ? 'ready' : 'missing'),
    ...(current ? { current } : {}),
    expected,
    repairable: forcedStatus === 'misconfigured' ? false : repairable,
    ...(details ? { details } : {})
  };
}

export async function repairInfrastructure(
  accountId: string,
  token: string,
  selectedActions: string[]
): Promise<{ applied: string[]; skipped: string[]; report: InfrastructureReport }> {
  if (accountId !== manifest.accountId) throw new Error('CLOUDFLARE_ACCOUNT_MISMATCH');
  const before = await scanInfrastructure(accountId, token);
  const allowed = new Set(selectedActions.slice(0, 10));
  const applied: string[] = [];
  const skipped: string[] = [];
  for (const item of before.components) {
    if (!allowed.has(item.key)) continue;
    if (item.status !== 'missing' || !item.repairable) { skipped.push(item.key); continue; }
    if (item.key === `queue:${manifest.knowledgeQueue}`) {
      await cf(token, `/accounts/${accountId}/queues`, {
        method: 'POST',
        body: JSON.stringify({ queue_name: manifest.knowledgeQueue })
      });
      applied.push(item.key);
    } else if (item.key === 'vectorize') {
      await cf(token, `/accounts/${accountId}/vectorize/v2/indexes`, {
        method: 'POST',
        body: JSON.stringify({
          name: manifest.vectorize,
          config: { dimensions: manifest.vectorDimensions, metric: manifest.vectorMetric }
        })
      });
      applied.push(item.key);
    } else {
      skipped.push(item.key);
    }
  }
  return { applied, skipped, report: await scanInfrastructure(accountId, token) };
}

export { manifest as projectInfrastructureManifest };
