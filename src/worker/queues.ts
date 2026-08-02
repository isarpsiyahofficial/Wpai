import type { AdminNotifyJob, DeadLetterJob, Env, InboundAiJob, OutboundJob } from './types';
import { buildAiContext, decide, finalSendGate } from './ai';
import { first, nowIso, run, setting } from './db';
import { getMetaCredentials, sendMetaMessage } from './meta';

export async function handleQueue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  if (batch.queue === 'wa-inbound-ai') return consumeInbound(batch as MessageBatch<InboundAiJob>, env);
  if (batch.queue === 'wa-outbound') return consumeOutbound(batch as MessageBatch<OutboundJob>, env);
  if (batch.queue === 'wa-admin-notify') return consumeAdminNotify(batch as MessageBatch<AdminNotifyJob>, env);
  if (batch.queue === 'wa-ai-dlq' || batch.queue === 'wa-outbound-dlq') return consumeDeadLetters(batch as MessageBatch<DeadLetterJob>, env);
  for (const message of batch.messages) message.ack();
}

async function consumeInbound(batch: MessageBatch<InboundAiJob>, env: Env): Promise<void> {
  for (const queueMessage of batch.messages) {
    const job = queueMessage.body;
    try {
      const stored = await first<{ status: string }>(env.DB, 'SELECT status FROM ai_jobs WHERE id = ? AND conversation_id = ? AND contact_id = ?', job.jobId, job.conversationId, job.contactId);
      if (!stored || stored.status === 'completed' || stored.status === 'cancelled') { queueMessage.ack(); continue; }
      await run(env.DB, "UPDATE ai_jobs SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ?", nowIso(), job.jobId);
      const source = await first<{ text_content: string | null }>(env.DB, 'SELECT text_content FROM messages WHERE id = ? AND conversation_id = ? AND contact_id = ?', job.sourceMessageId, job.conversationId, job.contactId);
      if (!source?.text_content) {
        await run(env.DB, "UPDATE ai_jobs SET status = 'completed', updated_at = ? WHERE id = ?", nowIso(), job.jobId);
        queueMessage.ack(); continue;
      }
      const context = await buildAiContext(env, job.conversationId, job.contactId, source.text_content);
      const decision = await decide(env, context, source.text_content);
      const decisionId = crypto.randomUUID();
      await run(env.DB,
        `INSERT INTO ai_decisions (id, conversation_id, contact_id, source_message_id, action, intent, confidence, needs_human, needs_research, should_notify_admin, decision_json, model, context_version, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        decisionId, job.conversationId, job.contactId, job.sourceMessageId, decision.action, decision.intent, decision.confidence, decision.needs_human ? 1 : 0, decision.needs_research ? 1 : 0, decision.should_notify_admin ? 1 : 0, JSON.stringify(decision), env.DEFAULT_AI_MODEL, context.contextVersion, nowIso());
      for (const note of decision.note_updates) {
        await run(env.DB, `INSERT INTO customer_notes (id, contact_id, conversation_id, source, note_text, created_at, updated_at) VALUES (?, ?, ?, 'ai', ?, ?, ?)`, crypto.randomUUID(), job.contactId, job.conversationId, note.text, nowIso(), nowIso());
      }
      if (decision.needs_human || decision.action === 'handoff') await createHandoff(env, job, decisionId, decision.intent, source.text_content);
      const gate = await finalSendGate(env, job, decision);
      if (gate.allowed && decision.reply.trim()) {
        const messageId = crypto.randomUUID();
        const now = nowIso();
        await run(env.DB, `INSERT INTO messages (id, conversation_id, contact_id, direction, sender_type, message_type, text_content, delivery_status, ai_generated, ai_decision_id, created_at) VALUES (?, ?, ?, 'outbound', 'ai', 'text', ?, 'queued', 1, ?, ?)`, messageId, job.conversationId, job.contactId, decision.reply.trim(), decisionId, now);
        await env.OUTBOUND.send({ jobId: crypto.randomUUID(), conversationId: job.conversationId, contactId: job.contactId, messageId, kind: 'text', expectedAiDecisionId: decisionId, enqueuedAt: now });
      }
      await run(env.DB, "UPDATE ai_jobs SET status = 'completed', updated_at = ? WHERE id = ?", nowIso(), job.jobId);
      queueMessage.ack();
    } catch (error) {
      const code = safeErrorCode(error);
      await run(env.DB, "UPDATE ai_jobs SET status = 'failed', error_code = ?, updated_at = ? WHERE id = ?", code, nowIso(), job.jobId).catch(() => undefined);
      if (queueMessage.attempts >= 3) {
        await env.AI_DLQ.send({ sourceQueue: batch.queue, originalJob: job, errorCode: code, failedAt: nowIso() });
        queueMessage.ack();
      } else queueMessage.retry({ delaySeconds: Math.min(300, 2 ** queueMessage.attempts * 10) });
    }
  }
}

async function createHandoff(env: Env, job: InboundAiJob, decisionId: string, intent: string, lastMessage: string): Promise<void> {
  const existing = await first<{ id: string }>(env.DB, "SELECT id FROM human_handoffs WHERE conversation_id = ? AND status IN ('open','in_progress') LIMIT 1", job.conversationId);
  const handoffId = existing?.id ?? crypto.randomUUID();
  if (!existing) await run(env.DB, `INSERT INTO human_handoffs (id, conversation_id, contact_id, reason_code, reason_text, status, ai_decision_id, created_at) VALUES (?, ?, ?, ?, ?, 'open', ?, ?)`, handoffId, job.conversationId, job.contactId, intent, `AI insan müdahalesi istedi. Son mesaj: ${lastMessage.slice(0, 500)}`, decisionId, nowIso());
  await run(env.DB, `UPDATE conversations SET ai_mode = 'human', human_takeover = 1, human_takeover_at = ?, updated_at = ? WHERE id = ? AND contact_id = ?`, nowIso(), nowIso(), job.conversationId, job.contactId);
  const dedupe = `handoff:${job.conversationId}`;
  const notification = await first<{ id: string }>(env.DB, `SELECT id FROM admin_notifications WHERE deduplication_key = ? AND status IN ('unread','in_progress','snoozed') LIMIT 1`, dedupe);
  const notificationId = notification?.id ?? crypto.randomUUID();
  if (!notification) await run(env.DB, `INSERT INTO admin_notifications (id, type, priority, status, contact_id, conversation_id, title, body, deduplication_key, cooldown_until, created_at, updated_at) VALUES (?, 'ai_handoff', 'high', 'unread', ?, ?, 'Müşteri müdahalesi gerekiyor', ?, ?, ?, ?, ?)`, notificationId, job.contactId, job.conversationId, `Neden: ${intent}. Son mesaj: ${lastMessage.slice(0, 500)}`, dedupe, new Date(Date.now() + 15 * 60_000).toISOString(), nowIso(), nowIso());
  await env.ADMIN_NOTIFY.send({ jobId: crypto.randomUUID(), notificationId, conversationId: job.conversationId, enqueuedAt: nowIso() });
}

async function consumeOutbound(batch: MessageBatch<OutboundJob>, env: Env): Promise<void> {
  for (const queueMessage of batch.messages) {
    const job = queueMessage.body;
    try {
      const row = await first<{ id: string; conversation_id: string; contact_id: string; text_content: string | null; message_type: string; attachment_id: string | null; delivery_status: string; ai_generated: number; ai_decision_id: string | null; phone_e164: string; r2_key: string | null; original_name: string | null; mime_type: string | null }>(env.DB,
        `SELECT m.id, m.conversation_id, m.contact_id, m.text_content, m.message_type, m.attachment_id, m.delivery_status, m.ai_generated, m.ai_decision_id,
                p.phone_e164, a.r2_key, a.original_name, a.mime_type
           FROM messages m JOIN conversations c ON c.id=m.conversation_id AND c.contact_id=m.contact_id
           JOIN contacts p ON p.id=m.contact_id LEFT JOIN attachments a ON a.id=m.attachment_id
          WHERE m.id=? AND m.conversation_id=? AND m.contact_id=? AND c.deleted_at IS NULL AND p.deleted_at IS NULL`, job.messageId, job.conversationId, job.contactId);
      if (!row || ['sent','delivered','read','cancelled'].includes(row.delivery_status)) { queueMessage.ack(); continue; }
      if ((await setting(env.DB, 'meta_connection_enabled')) !== 'true') throw new Error('META_CONNECTION_DISABLED');
      if (row.ai_generated) {
        const state = await first<{ ai_mode: string; human_takeover: number }>(env.DB, 'SELECT ai_mode, human_takeover FROM conversations WHERE id=? AND contact_id=?', job.conversationId, job.contactId);
        if (!state || state.human_takeover || !['auto','business_hours'].includes(state.ai_mode) || row.ai_decision_id !== job.expectedAiDecisionId) {
          await run(env.DB, "UPDATE messages SET delivery_status='cancelled', error_code='AI_GATE_CHANGED' WHERE id=?", row.id);
          queueMessage.ack(); continue;
        }
      }
      let payload: Record<string, unknown>;
      if (job.kind === 'template') {
        const data = JSON.parse(row.text_content ?? '{}') as { templateName: string; languageCode: string; variables: string[] };
        payload = { type: 'template', template: { name: data.templateName, language: { code: data.languageCode }, components: data.variables.length ? [{ type: 'body', parameters: data.variables.map(text => ({ type: 'text', text })) }] : [] } };
      } else if (job.kind === 'media' && row.r2_key && row.mime_type) {
        const mediaId = await uploadMedia(env, row.r2_key, row.mime_type, row.original_name ?? 'dosya');
        payload = row.message_type === 'image' ? { type: 'image', image: { id: mediaId } } : { type: 'document', document: { id: mediaId, filename: row.original_name ?? 'dosya' } };
      } else payload = { type: 'text', text: { preview_url: false, body: row.text_content ?? '' } };
      const sent = await sendMetaMessage(env, row.phone_e164, payload);
      await env.DB.batch([
        env.DB.prepare("UPDATE messages SET meta_message_id=?, delivery_status='submitted', sent_at=? WHERE id=?").bind(sent.id, nowIso(), row.id),
        env.DB.prepare("INSERT INTO message_status_events (id, message_id, meta_message_id, status, occurred_at, created_at) VALUES (?, ?, ?, 'submitted', ?, ?)").bind(crypto.randomUUID(), row.id, sent.id, nowIso(), nowIso()),
        env.DB.prepare('UPDATE conversations SET last_outbound_at=?, last_message_at=?, updated_at=? WHERE id=?').bind(nowIso(), nowIso(), nowIso(), job.conversationId)
      ]);
      queueMessage.ack();
    } catch (error) {
      const code = safeErrorCode(error);
      if (code.includes('400') || code.includes('401') || code.includes('403') || code.includes('TEMPLATE')) {
        await run(env.DB, "UPDATE messages SET delivery_status='failed', error_code=? WHERE id=?", code, job.messageId).catch(() => undefined);
        queueMessage.ack();
      } else if (queueMessage.attempts >= 4) {
        await env.OUTBOUND_DLQ.send({ sourceQueue: batch.queue, originalJob: job, errorCode: code, failedAt: nowIso() });
        await run(env.DB, "UPDATE messages SET delivery_status='failed', error_code=? WHERE id=?", code, job.messageId).catch(() => undefined);
        queueMessage.ack();
      } else queueMessage.retry({ delaySeconds: Math.min(600, 2 ** queueMessage.attempts * 15) });
    }
  }
}

async function uploadMedia(env: Env, r2Key: string, mime: string, filename: string): Promise<string> {
  const credentials = await getMetaCredentials(env);
  if (!credentials) throw new Error('META_NOT_CONFIGURED');
  const object = await env.FILES.get(r2Key);
  if (!object) throw new Error('R2_OBJECT_MISSING');
  const form = new FormData();
  form.set('messaging_product', 'whatsapp');
  form.set('type', mime);
  form.set('file', new File([await object.arrayBuffer()], filename, { type: mime }));
  const response = await fetch(`https://graph.facebook.com/${env.META_GRAPH_API_VERSION}/${credentials.phoneNumberId}/media`, { method: 'POST', headers: { Authorization: `Bearer ${credentials.accessToken}` }, body: form });
  const data = await response.json<{ id?: string }>();
  if (!response.ok || !data.id) throw new Error(`META_MEDIA_UPLOAD_${response.status}`);
  return data.id;
}

async function consumeAdminNotify(batch: MessageBatch<AdminNotifyJob>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    const job = message.body;
    try {
      const enabled = (await setting(env.DB, 'admin_notifications_enabled')) === 'true';
      if (!enabled) { message.ack(); continue; }
      const credentials = await getMetaCredentials(env);
      if (!credentials?.adminWhatsAppPhone) { message.ack(); continue; }
      const notification = await first<{ title: string; body: string; whatsapp_status: string | null }>(env.DB, 'SELECT title, body, whatsapp_status FROM admin_notifications WHERE id=?', job.notificationId);
      if (!notification || notification.whatsapp_status === 'sent') { message.ack(); continue; }
      // Outside the 24h window a Meta-approved utility template is required. Keep panel notification if template is unavailable.
      const template = await first<{ meta_name: string; language_code: string }>(env.DB, "SELECT meta_name, language_code FROM message_templates WHERE meta_name='admin_alert_v1' AND status='APPROVED' LIMIT 1");
      if (!template) {
        await run(env.DB, "UPDATE admin_notifications SET whatsapp_status='template_required', updated_at=? WHERE id=?", nowIso(), job.notificationId);
        message.ack(); continue;
      }
      await sendMetaMessage(env, credentials.adminWhatsAppPhone, { type: 'template', template: { name: template.meta_name, language: { code: template.language_code }, components: [{ type: 'body', parameters: [{ type: 'text', text: notification.title }, { type: 'text', text: notification.body.slice(0, 900) }] }] } });
      await run(env.DB, "UPDATE admin_notifications SET whatsapp_status='sent', updated_at=? WHERE id=?", nowIso(), job.notificationId);
      message.ack();
    } catch {
      if (message.attempts >= 3) message.ack(); else message.retry({ delaySeconds: 60 });
    }
  }
}

async function consumeDeadLetters(batch: MessageBatch<DeadLetterJob>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    await run(env.DB, `INSERT INTO admin_notifications (id, type, priority, status, title, body, created_at, updated_at) VALUES (?, 'system_error', 'high', 'unread', 'Kuyruk işi başarısız', ?, ?, ?)`, crypto.randomUUID(), `${message.body.sourceQueue}: ${message.body.errorCode}`, nowIso(), nowIso()).catch(() => undefined);
    message.ack();
  }
}

function safeErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : 'UNKNOWN_ERROR';
  return message.replace(/Bearer\s+\S+/gi, 'Bearer ***').replace(/cfat_[A-Za-z0-9_-]+/g, 'cfat_***').slice(0, 160);
}
