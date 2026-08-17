import { afterEach, describe, expect, it, vi } from 'vitest';
import { projectInfrastructureManifest, repairInfrastructure, scanInfrastructure } from '../../src/worker/infrastructure';

const accountId = 'ad8e99c82c6c17d823f6877ff1efade4';
const token = 'test-token-that-is-long-enough-and-never-real';

type State = { d1: boolean; r2: boolean; queues: Set<string>; worker: boolean; vector: boolean; wrongD1?: boolean };

function installCloudflareMock(state: State) {
  const calls: Array<{ path: string; method: string; body?: unknown }> = [];
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace('/client/v4', '');
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined;
    calls.push({ path, method, ...(body === undefined ? {} : { body }) });
    let result: unknown;
    if (path === '/user/tokens/verify') result = { status: 'active' };
    else if (path === `/accounts/${accountId}`) result = { id: accountId, name: 'WPAI Account' };
    else if (path === `/accounts/${accountId}/d1/database` && method === 'GET') result = state.d1 ? [{ uuid: state.wrongD1 ? 'wrong-id' : projectInfrastructureManifest.d1Id, name: projectInfrastructureManifest.d1 }] : [];
    else if (path === `/accounts/${accountId}/r2/buckets` && method === 'GET') result = { buckets: state.r2 ? [{ name: projectInfrastructureManifest.r2 }] : [] };
    else if (path === `/accounts/${accountId}/queues` && method === 'GET') result = { queues: [...state.queues].map((name, index) => ({ id: `q-${index}`, name })) };
    else if (path === `/accounts/${accountId}/queues` && method === 'POST') { state.queues.add((body as { queue_name: string }).queue_name); result = { id: 'new-q' }; }
    else if (path === `/accounts/${accountId}/workers/scripts`) result = { scripts: state.worker ? [{ id: projectInfrastructureManifest.worker }] : [] };
    else if (path === `/accounts/${accountId}/vectorize/v2/indexes` && method === 'GET') result = { indexes: state.vector ? [{ name: projectInfrastructureManifest.vectorize, config: { dimensions: 1024, metric: 'cosine' } }] : [] };
    else if (path === `/accounts/${accountId}/vectorize/v2/indexes` && method === 'POST') { state.vector = true; result = { name: projectInfrastructureManifest.vectorize }; }
    else return new Response(JSON.stringify({ success: false, errors: [{ code: 404, message: path }] }), { status: 404 });
    return new Response(JSON.stringify({ success: true, result }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  vi.stubGlobal('fetch', mock);
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe('Cloudflare infrastructure scan and repair', () => {
  it('recognizes the exact ready project resources', async () => {
    installCloudflareMock({ d1: true, r2: true, queues: new Set(projectInfrastructureManifest.queues), worker: true, vector: true });
    const report = await scanInfrastructure(accountId, token);
    expect(report.overall).toBe('ready');
    expect(report.components.every(item => item.status === 'ready')).toBe(true);
    expect(report.plan).toEqual([]);
  });

  it('never treats a same-name wrong D1 as repairable', async () => {
    installCloudflareMock({ d1: true, wrongD1: true, r2: true, queues: new Set(projectInfrastructureManifest.queues), worker: true, vector: true });
    const report = await scanInfrastructure(accountId, token);
    const d1 = report.components.find(item => item.key === 'd1');
    expect(d1?.status).toBe('misconfigured');
    expect(d1?.repairable).toBe(false);
    expect(report.plan.find(item => item.resource === 'd1')?.action).toBe('review');
  });

  it('creates only the permitted knowledge queue and Vectorize index', async () => {
    const existingQueues = projectInfrastructureManifest.queues.filter(name => name !== projectInfrastructureManifest.knowledgeQueue);
    const state: State = { d1: false, r2: false, queues: new Set(existingQueues), worker: false, vector: false };
    const calls = installCloudflareMock(state);
    const result = await repairInfrastructure(accountId, token, [
      'd1', 'r2', 'worker', 'queue:wa-inbound-ai',
      `queue:${projectInfrastructureManifest.knowledgeQueue}`, 'vectorize', 'queue:not-ours'
    ]);
    expect(result.applied).toEqual([
      `queue:${projectInfrastructureManifest.knowledgeQueue}`,
      'vectorize'
    ]);
    expect(result.skipped).toEqual(expect.arrayContaining(['d1', 'r2', 'worker']));
    expect(state.queues.has(projectInfrastructureManifest.knowledgeQueue)).toBe(true);
    expect(state.queues.has('not-ours')).toBe(false);
    expect(calls.some(call => call.method === 'DELETE')).toBe(false);
    expect(calls.some(call => call.path.includes('/dns_records'))).toBe(false);
    expect(calls.some(call => call.path.includes('/d1/database') && call.method === 'POST')).toBe(false);
    expect(calls.some(call => call.path.includes('/r2/buckets/') && call.method !== 'GET')).toBe(false);
  });

  it('reports wrong-dimension Vectorize as non-repairable', async () => {
    const calls = installCloudflareMock({ d1: true, r2: true, queues: new Set(projectInfrastructureManifest.queues), worker: true, vector: false });
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname.replace('/client/v4', '');
      if (path === `/accounts/${accountId}/vectorize/v2/indexes` && (init?.method ?? 'GET') === 'GET') {
        return new Response(JSON.stringify({ success: true, result: { indexes: [{ name: projectInfrastructureManifest.vectorize, config: { dimensions: 768, metric: 'cosine' } }] } }), { headers: { 'Content-Type': 'application/json' } });
      }
      return originalFetch(input, init);
    }));
    const report = await scanInfrastructure(accountId, token);
    const vector = report.components.find(item => item.key === 'vectorize');
    expect(vector?.status).toBe('misconfigured');
    expect(vector?.repairable).toBe(false);
    expect(calls.some(call => call.method === 'DELETE')).toBe(false);
  });

  it('rejects inactive tokens and account mismatch', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      const result = path.endsWith('/user/tokens/verify') ? { status: 'disabled' } : { id: 'different', name: 'Wrong' };
      return new Response(JSON.stringify({ success: true, result }), { headers: { 'Content-Type': 'application/json' } });
    }));
    await expect(scanInfrastructure(accountId, token)).rejects.toThrow('CLOUDFLARE_TOKEN_INACTIVE');
  });
});
