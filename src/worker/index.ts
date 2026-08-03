import { Hono } from 'hono';
import { authRoutes } from './auth';
import { apiRoutes } from './api';
import { webhookRoutes } from './webhook';
import { handleQueue } from './queues';
import { first, nowIso, run, setting } from './db';
import type { AppContext, Env } from './types';

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
  const d1 = await c.env.DB.prepare('SELECT 1 AS ok').first<{ ok: number }>().then(row => row?.ok === 1).catch(() => false);
  const meta = (await setting(c.env.DB, 'meta_connection_enabled').catch(() => null)) === 'true';
  return c.json({
    ok: d1,
    components: {
      worker: true,
      d1,
      r2Binding: Boolean(c.env.FILES),
      queuesBinding: Boolean(c.env.INBOUND_AI && c.env.OUTBOUND && c.env.ADMIN_NOTIFY),
      workersAiBinding: Boolean(c.env.AI),
      vectorizeBinding: Boolean(c.env.KNOWLEDGE_INDEX),
      metaConfiguration: meta ? 'configured' : 'not_configured'
    }
  }, d1 ? 200 : 503);
});

app.route('/api/auth', authRoutes);
app.route('/api', apiRoutes);
app.route('/webhooks', webhookRoutes);

app.notFound(async c => c.env.ASSETS.fetch(c.req.raw));
app.onError((error, c) => {
  console.error(JSON.stringify({ level: 'error', event: 'request_failed', requestId: c.get('requestId'), name: error.name }));
  return c.json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'İşlem tamamlanamadı.', requestId: c.get('requestId') } }, 500);
});

async function runScheduled(env: Env): Promise<void> {
  const now = nowIso();
  const due = await env.DB.prepare("SELECT id, contact_id, conversation_id, title FROM follow_up_tasks WHERE status='pending' AND due_at <= ? ORDER BY due_at LIMIT 100").bind(now).all<{ id: string; contact_id: string; conversation_id: string | null; title: string }>();
  for (const task of due.results) {
    const key = `followup:${task.id}`;
    const existing = await first<{ id: string }>(env.DB, 'SELECT id FROM admin_notifications WHERE deduplication_key=? LIMIT 1', key);
    if (!existing) await run(env.DB, `INSERT INTO admin_notifications (id,type,priority,status,contact_id,conversation_id,title,body,deduplication_key,created_at,updated_at) VALUES (?, 'follow_up', 'normal', 'unread', ?, ?, 'Takip görevi geldi', ?, ?, ?, ?)`, crypto.randomUUID(), task.contact_id, task.conversation_id, task.title.slice(0,1000), key, now, now);
  }
  await env.DB.prepare("DELETE FROM login_attempts WHERE created_at < datetime('now','-2 days')").run();
}

export default {
  fetch: app.fetch,
  queue: handleQueue,
  scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) { ctx.waitUntil(runScheduled(env)); }
};
