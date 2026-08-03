import { Hono } from 'hono';
import { authRoutes } from './auth';
import { apiRoutes } from './api';
import { extendedApiRoutes } from './extendedApi';
import { scopedFileRoutes } from './scopedFiles';
import { usageApiRoutes } from './usageApi';
import { webhookRoutes } from './webhook';
import { handleQueue } from './queues';
import { first, nowIso, run, setting, all } from './db';
import type { AppContext, Env, KnowledgeSyncJob } from './types';
import { consumeKnowledgeSync, enqueueKnowledgeSync, vectorStatus } from './vectorSync';

const app = new Hono<AppContext>();

app.use('*', async (c, next) => {
  c.set('requestId', c.req.header('cf-ray') ?? crypto.randomUUID());
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  c.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; worker-src 'self'; manifest-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' https://api.cloudflare.com https://graph.facebook.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
});

app.get('/health', async c => {
  const deep = c.req.query('deep') === '1';
  const d1 = await c.env.DB.prepare('SELECT 1 AS ok').first<{ ok: number }>().then(row => row?.ok === 1).catch(() => false);
  const meta = d1 && (await setting(c.env.DB, 'meta_connection_enabled').catch(() => null)) === 'true';
  const r2Operational = deep
    ? await c.env.FILES.list({ limit: 1 }).then(() => true).catch(() => false)
    : null;
  const vector = d1 ? await vectorStatus(c.env).catch(() => null) : null;
  const vectorizeOperational = deep
    ? await c.env.KNOWLEDGE_INDEX.query(new Array<number>(1024).fill(0), { topK: 1, returnMetadata: 'none' }).then(() => true).catch(() => false)
    : null;
  const ok = d1 && (!deep || (r2Operational === true && vectorizeOperational === true));
  return c.json({
    ok,
    checkedAt: nowIso(),
    deep,
    components: {
      worker: true,
      d1,
      r2Binding: Boolean(c.env.FILES),
      r2Operational,
      queuesBinding: Boolean(c.env.INBOUND_AI && c.env.OUTBOUND && c.env.ADMIN_NOTIFY && c.env.KNOWLEDGE_SYNC),
      workersAiBinding: Boolean(c.env.AI),
      vectorizeBinding: Boolean(c.env.KNOWLEDGE_INDEX),
      vectorizeOperational,
      vectorize: vector,
      metaConfiguration: meta ? 'configured' : 'not_configured'
    }
  }, ok ? 200 : 503);
});

app.all('/api/attachments/:id', c => c.json({ ok: false, error: { code: 'SCOPED_FILE_ROUTE_REQUIRED', message: 'Dosya erişimi için konuşma kimliği gereklidir.', requestId: c.get('requestId') } }, 410));
app.route('/api/auth', authRoutes);
app.route('/api', apiRoutes);
app.route('/api', extendedApiRoutes);
app.route('/api', scopedFileRoutes);
app.route('/api', usageApiRoutes);
app.route('/webhooks', webhookRoutes);

app.notFound(async c => {
  if (c.req.path === '/api' || c.req.path.startsWith('/api/') || c.req.path.startsWith('/webhooks/')) {
    return c.json({ ok: false, error: { code: 'NOT_FOUND', message: 'API yolu bulunamadı.', requestId: c.get('requestId') } }, 404);
  }
  return c.env.ASSETS.fetch(c.req.raw);
});
app.onError((error, c) => {
  console.error(JSON.stringify({ level: 'error', event: 'request_failed', requestId: c.get('requestId'), name: error.name }));
  return c.json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'İşlem tamamlanamadı.', requestId: c.get('requestId') } }, 500);
});

export async function runScheduled(env: Env): Promise<void> {
  const now = nowIso();
  const due = await env.DB.prepare("SELECT id, contact_id, conversation_id, title FROM follow_up_tasks WHERE status='pending' AND due_at <= ? ORDER BY due_at LIMIT 100").bind(now).all<{ id: string; contact_id: string; conversation_id: string | null; title: string }>();
  for (const task of due.results) {
    const key = `followup:${task.id}`;
    const existing = await first<{ id: string }>(env.DB, 'SELECT id FROM admin_notifications WHERE deduplication_key=? LIMIT 1', key);
    if (!existing) await run(env.DB, `INSERT INTO admin_notifications (id,type,priority,status,contact_id,conversation_id,title,body,deduplication_key,created_at,updated_at) VALUES (?, 'follow_up', 'normal', 'unread', ?, ?, 'Takip görevi geldi', ?, ?, ?, ?)`, crypto.randomUUID(), task.contact_id, task.conversation_id, task.title.slice(0,1000), key, now, now);
  }

  const pendingKnowledge = await all<{ id: string; status: string; vector_status: string; vector_version: number }>(env.DB,
    `SELECT id,status,vector_status,vector_version FROM business_knowledge
      WHERE deleted_at IS NULL AND ((status='approved' AND vector_status IN ('pending','failed')) OR status<>'approved')
      ORDER BY updated_at LIMIT 100`);
  for (const item of pendingKnowledge) {
    if (item.status === 'approved') {
      await enqueueKnowledgeSync(env, { knowledgeId: item.id, operation: 'upsert', version: item.vector_version > 0 ? item.vector_version : null });
    } else {
      const hasChunks = await first<{ count: number }>(env.DB, 'SELECT COUNT(*) AS count FROM knowledge_chunks WHERE knowledge_id=?', item.id);
      if ((hasChunks?.count ?? 0) > 0) await enqueueKnowledgeSync(env, { knowledgeId: item.id, operation: 'delete' });
    }
  }

  await env.DB.prepare("DELETE FROM login_attempts WHERE created_at < datetime('now','-2 days')").run();
  await env.DB.prepare("UPDATE desktop_sessions SET revoked_at=? WHERE revoked_at IS NULL AND expires_at<=?").bind(now, now).run().catch(() => undefined);
}

export default {
  fetch: app.fetch,
  queue(batch: MessageBatch<unknown>, env: Env) {
    if (batch.queue === 'wa-knowledge-index') return consumeKnowledgeSync(batch as MessageBatch<KnowledgeSyncJob>, env);
    return handleQueue(batch, env);
  },
  scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) { ctx.waitUntil(runScheduled(env)); }
};