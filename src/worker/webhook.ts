import { Hono } from 'hono';
import type { AppContext } from './types';
import { getMetaCredentials, verifyWebhookSignature } from './meta';
import { first, nowIso, run } from './db';
import { fail } from './http';
import { normalizePhone } from '../shared/phone';

export const webhookRoutes = new Hono<AppContext>();

webhookRoutes.get('/whatsapp', async c => {
  const mode = c.req.query('hub.mode');
  const token = c.req.query('hub.verify_token');
  const challenge = c.req.query('hub.challenge');
  const credentials = await getMetaCredentials(c.env);
  if (mode === 'subscribe' && credentials && token === credentials.verifyToken && challenge) return c.text(challenge, 200);
  return c.text('Forbidden', 403);
});

webhookRoutes.post('/whatsapp', async c => {
  const credentials = await getMetaCredentials(c.env);
  if (!credentials) return fail(c, 'META_NOT_CONFIGURED', 'Meta bağlantısı yapılandırılmamış.', 503);
  const raw = await c.req.arrayBuffer();
  const signature = c.req.header('X-Hub-Signature-256') ?? null;
  if (!(await verifyWebhookSignature(credentials.appSecret, raw, signature))) return fail(c, 'WEBHOOK_SIGNATURE_INVALID', 'Geçersiz webhook imzası.', 401);
  const payloadHash = await digestHex(raw);
  const eventId = crypto.randomUUID();
  try {
    await run(c.env.DB, `INSERT INTO webhook_events (id, payload_hash, event_type, status, received_at) VALUES (?, ?, 'whatsapp', 'received', ?)`, eventId, payloadHash, nowIso());
  } catch { return c.json({ received: true, duplicate: true }); }
  let payload: WhatsAppWebhook;
  try { payload = JSON.parse(new TextDecoder().decode(raw)) as WhatsAppWebhook; }
  catch { await run(c.env.DB, "UPDATE webhook_events SET status='failed', error_code='INVALID_JSON', processed_at=? WHERE id=?", nowIso(), eventId); return c.json({ received: true }); }
  c.executionCtx.waitUntil(processPayload(c.env, payload, eventId));
  return c.json({ received: true });
});

type WhatsAppWebhook = {
  entry?: Array<{ changes?: Array<{ value?: { contacts?: Array<{ wa_id?: string; profile?: { name?: string } }>; messages?: Array<MetaInbound>; statuses?: Array<MetaStatus> } }> }>;
};
type MetaInbound = { id?: string; from?: string; timestamp?: string; type?: string; text?: { body?: string }; image?: { id?: string; mime_type?: string; caption?: string }; document?: { id?: string; mime_type?: string; filename?: string; caption?: string }; audio?: { id?: string; mime_type?: string }; video?: { id?: string; mime_type?: string; caption?: string }; reaction?: { message_id?: string; emoji?: string } };
type MetaStatus = { id?: string; status?: string; timestamp?: string; errors?: Array<{ code?: number; title?: string }> };

async function processPayload(env: AppContext['Bindings'], payload: WhatsAppWebhook, eventId: string): Promise<void> {
  try {
    for (const entry of payload.entry ?? []) for (const change of entry.changes ?? []) {
      const value = change.value;
      const profileName = value?.contacts?.[0]?.profile?.name ?? 'WhatsApp Müşterisi';
      for (const status of value?.statuses ?? []) await processStatus(env, status);
      for (const message of value?.messages ?? []) await processInbound(env, message, profileName);
    }
    await run(env.DB, "UPDATE webhook_events SET status='processed', processed_at=? WHERE id=?", nowIso(), eventId);
  } catch (error) {
    await run(env.DB, "UPDATE webhook_events SET status='failed', error_code=?, processed_at=? WHERE id=?", safeCode(error), nowIso(), eventId).catch(() => undefined);
  }
}

async function processInbound(env: AppContext['Bindings'], message: MetaInbound, profileName: string): Promise<void> {
  if (!message.id || !message.from) return;
  const duplicate = await first<{ id: string }>(env.DB, 'SELECT id FROM messages WHERE meta_message_id=? LIMIT 1', message.id);
  if (duplicate) return;
  const normalized = normalizePhone(`+${message.from}`, 'ZZ');
  if (!normalized.ok) return;
  const now = message.timestamp ? new Date(Number(message.timestamp) * 1000).toISOString() : nowIso();
  let contact = await first<{ id: string }>(env.DB, 'SELECT id FROM contacts WHERE phone_e164=? AND deleted_at IS NULL', normalized.e164);
  if (!contact) {
    contact = { id: crypto.randomUUID() };
    await run(env.DB, `INSERT INTO contacts (id, phone_e164, display_name, country_code, source, status, first_contact_at, last_contact_at, created_at, updated_at) VALUES (?, ?, ?, 'ZZ', 'whatsapp', 'lead', ?, ?, ?, ?)`, contact.id, normalized.e164, profileName.slice(0, 160), now, now, now, now);
  }
  let conversation = await first<{ id: string; current_context_version: number }>(env.DB, "SELECT id, current_context_version FROM conversations WHERE contact_id=? AND status IN ('open','pending') AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1", contact.id);
  if (!conversation) {
    conversation = { id: crypto.randomUUID(), current_context_version: 0 };
    await run(env.DB, `INSERT INTO conversations (id, contact_id, status, ai_mode, unread_count, last_inbound_at, last_message_at, created_at, updated_at) VALUES (?, ?, 'open', 'suggestion', 0, ?, ?, ?, ?)`, conversation.id, contact.id, now, now, now, now);
  }
  const type = mapType(message.type);
  const text = message.text?.body ?? message.image?.caption ?? message.document?.caption ?? message.video?.caption ?? message.reaction?.emoji ?? null;
  const messageId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO messages (id, conversation_id, contact_id, meta_message_id, direction, sender_type, message_type, text_content, delivery_status, received_at, created_at) VALUES (?, ?, ?, ?, 'inbound', 'customer', ?, ?, 'delivered', ?, ?)`).bind(messageId, conversation.id, contact.id, message.id, type, text, now, now),
    env.DB.prepare(`UPDATE conversations SET unread_count=unread_count+1, last_inbound_at=?, last_message_at=?, current_context_version=current_context_version+1, updated_at=? WHERE id=? AND contact_id=?`).bind(now, now, now, conversation.id, contact.id),
    env.DB.prepare('UPDATE contacts SET display_name=CASE WHEN display_name = ? THEN ? ELSE display_name END, last_contact_at=?, updated_at=? WHERE id=?').bind('WhatsApp Müşterisi', profileName.slice(0,160), now, now, contact.id)
  ]);
  if (text && isOptOut(text)) {
    const existing = await first(env.DB, "SELECT id FROM opt_outs WHERE contact_id=? AND scope='marketing' AND revoked_at IS NULL", contact.id);
    if (!existing) await run(env.DB, `INSERT INTO opt_outs (id, contact_id, scope, reason, source_message_id, created_at) VALUES (?, ?, 'marketing', 'customer_request', ?, ?)`, crypto.randomUUID(), contact.id, messageId, now);
  }
  const shouldAi = text && !['reaction'].includes(type) && !isTrivial(text);
  if (shouldAi) {
    const jobId = crypto.randomUUID();
    await run(env.DB, `INSERT INTO ai_jobs (id, conversation_id, contact_id, source_message_id, status, expected_context_version, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)`, jobId, conversation.id, contact.id, messageId, conversation.current_context_version + 1, now, now);
    const debounce = 6;
    await env.INBOUND_AI.send({ jobId, conversationId: conversation.id, contactId: contact.id, sourceMessageId: messageId, expectedLastMessageId: messageId, enqueuedAt: now }, { delaySeconds: debounce });
  }
}

async function processStatus(env: AppContext['Bindings'], status: MetaStatus): Promise<void> {
  if (!status.id || !status.status) return;
  const allowed = new Set(['sent','delivered','read','failed']);
  if (!allowed.has(status.status)) return;
  const message = await first<{ id: string }>(env.DB, 'SELECT id FROM messages WHERE meta_message_id=?', status.id);
  const occurred = status.timestamp ? new Date(Number(status.timestamp) * 1000).toISOString() : nowIso();
  await run(env.DB, `INSERT OR IGNORE INTO message_status_events (id, message_id, meta_message_id, status, error_code, error_message_safe, occurred_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, crypto.randomUUID(), message?.id ?? null, status.id, status.status, status.errors?.[0]?.code ? String(status.errors[0].code) : null, status.errors?.[0]?.title?.slice(0,160) ?? null, occurred, nowIso());
  if (message) await run(env.DB, 'UPDATE messages SET delivery_status=?, error_code=? WHERE id=?', status.status, status.errors?.[0]?.code ? String(status.errors[0].code) : null, message.id);
}

function mapType(type: string | undefined): string {
  const valid = new Set(['text','image','document','audio','video','location','contacts','interactive','reaction']);
  if (!type || !valid.has(type)) return 'unsupported';
  return type === 'contacts' ? 'contact' : type;
}
function isOptOut(text: string): boolean { return /^(istemiyorum|mesaj atmayın|iptal|dur|stop)\b/i.test(text.trim()); }
function isTrivial(text: string): boolean { return /^(tamam|teşekkürler|teşekkür ederim|anladım|ok|👍|🙏|👌)[.! ]*$/iu.test(text.trim()); }
async function digestHex(data: ArrayBuffer): Promise<string> { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))].map(byte => byte.toString(16).padStart(2,'0')).join(''); }
function safeCode(error: unknown): string { return (error instanceof Error ? error.message : 'UNKNOWN').replace(/cfat_[A-Za-z0-9_-]+/g,'cfat_***').slice(0,160); }
