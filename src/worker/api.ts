import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import {
  AiInstructionsSchema, CloudflareScanSchema, ContactSchema, ConversationAiModeSchema,
  KnowledgeEntrySchema, ManualMessageSchema, MetaCredentialsSchema, NewTemplateMessageSchema
} from '../shared/contracts';
import { normalizePhone } from '../shared/phone';
import type { AppContext } from './types';
import { all, audit, first, nowIso, run, setSetting, setting } from './db';
import { fail, ok, requireAuth } from './http';
import { getMetaCredentials, metaStatus, removeMeta, saveMetaCredentials, setMetaPaused, verifyMeta } from './meta';
import { indexKnowledge } from './ai';
import { storeAttachment } from './files';
import { repairInfrastructure, scanInfrastructure } from './infrastructure';

export const apiRoutes = new Hono<AppContext>();
apiRoutes.use('*', requireAuth);

apiRoutes.get('/dashboard', async c => {
  const [contacts, conversations, unread, handoffs, failed, notifications, usage] = await Promise.all([
    first<{ count: number }>(c.env.DB, "SELECT COUNT(*) AS count FROM contacts WHERE deleted_at IS NULL"),
    first<{ count: number }>(c.env.DB, "SELECT COUNT(*) AS count FROM conversations WHERE status = 'open' AND deleted_at IS NULL"),
    first<{ count: number }>(c.env.DB, "SELECT COALESCE(SUM(unread_count),0) AS count FROM conversations WHERE deleted_at IS NULL"),
    first<{ count: number }>(c.env.DB, "SELECT COUNT(*) AS count FROM human_handoffs WHERE status IN ('open','in_progress')"),
    first<{ count: number }>(c.env.DB, "SELECT COUNT(*) AS count FROM messages WHERE delivery_status = 'failed' AND created_at > datetime('now','-1 day')"),
    first<{ count: number }>(c.env.DB, "SELECT COUNT(*) AS count FROM admin_notifications WHERE status = 'unread'"),
    first<{ neurons: number }>(c.env.DB, "SELECT COALESCE(SUM(estimated_neurons),0) AS neurons FROM ai_usage_records WHERE created_at >= date('now')")
  ]);
  return ok(c, { contacts: contacts?.count ?? 0, activeConversations: conversations?.count ?? 0, unreadMessages: unread?.count ?? 0, openHandoffs: handoffs?.count ?? 0, failedMessages: failed?.count ?? 0, unreadNotifications: notifications?.count ?? 0, estimatedNeuronsToday: usage?.neurons ?? 0 });
});

apiRoutes.get('/conversations', async c => {
  const q = (c.req.query('q') ?? '').trim();
  const like = `%${q}%`;
  const rows = await all(c.env.DB,
    `SELECT c.id, c.contact_id, c.status, c.ai_mode, c.human_takeover, c.unread_count, c.last_message_at,
            p.display_name, p.phone_e164, p.company_name,
            (SELECT text_content FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_message
       FROM conversations c JOIN contacts p ON p.id = c.contact_id
      WHERE c.deleted_at IS NULL AND p.deleted_at IS NULL
        AND (? = '' OR p.display_name LIKE ? OR p.phone_e164 LIKE ? OR COALESCE(p.company_name,'') LIKE ?)
      ORDER BY COALESCE(c.last_message_at,c.created_at) DESC LIMIT 200`, q, like, like, like);
  return ok(c, rows);
});

apiRoutes.get('/conversations/:id', async c => {
  const id = c.req.param('id');
  const conversation = await first<Record<string, unknown>>(c.env.DB,
    `SELECT c.*, p.display_name, p.phone_e164, p.company_name, p.email, p.city, p.country_code
       FROM conversations c JOIN contacts p ON p.id = c.contact_id
      WHERE c.id = ? AND c.deleted_at IS NULL AND p.deleted_at IS NULL`, id);
  if (!conversation) return fail(c, 'NOT_FOUND', 'Konuşma bulunamadı.', 404);
  const contactId = String(conversation.contact_id);
  const [messages, notes, requirements, summary, handoff, lastDecision] = await Promise.all([
    all(c.env.DB, `SELECT m.*, a.original_name, a.mime_type, a.size_bytes FROM messages m LEFT JOIN attachments a ON a.id = m.attachment_id WHERE m.conversation_id = ? AND m.contact_id = ? ORDER BY m.created_at ASC LIMIT 500`, id, contactId),
    all(c.env.DB, 'SELECT * FROM customer_notes WHERE conversation_id = ? AND contact_id = ? AND deleted_at IS NULL ORDER BY created_at DESC', id, contactId),
    first(c.env.DB, 'SELECT * FROM customer_requirements WHERE conversation_id = ? AND contact_id = ?', id, contactId),
    first(c.env.DB, 'SELECT * FROM conversation_summaries WHERE conversation_id = ? ORDER BY version DESC LIMIT 1', id),
    first(c.env.DB, "SELECT * FROM human_handoffs WHERE conversation_id = ? AND contact_id = ? AND status IN ('open','in_progress') ORDER BY created_at DESC LIMIT 1", id, contactId),
    first(c.env.DB, 'SELECT action, intent, confidence, needs_human, decision_json, created_at FROM ai_decisions WHERE conversation_id = ? AND contact_id = ? ORDER BY created_at DESC LIMIT 1', id, contactId)
  ]);
  return ok(c, { conversation, messages, notes, requirements, summary, handoff, lastDecision });
});

apiRoutes.post('/conversations/:id/read', async c => {
  await run(c.env.DB, 'UPDATE conversations SET unread_count = 0, updated_at = ? WHERE id = ?', nowIso(), c.req.param('id'));
  return ok(c, { read: true });
});

apiRoutes.put('/conversations/:id/ai-mode', zValidator('json', ConversationAiModeSchema), async c => {
  const input = c.req.valid('json');
  const id = c.req.param('id');
  const row = await first<{ contact_id: string }>(c.env.DB, 'SELECT contact_id FROM conversations WHERE id = ? AND deleted_at IS NULL', id);
  if (!row) return fail(c, 'NOT_FOUND', 'Konuşma bulunamadı.', 404);
  await run(c.env.DB,
    `UPDATE conversations SET ai_mode = ?, ai_paused_until = ?, human_takeover = ?, human_takeover_at = ?, human_takeover_by = ?, updated_at = ? WHERE id = ?`,
    input.mode, input.pausedUntil ?? null, input.mode === 'human' ? 1 : 0, input.mode === 'human' ? nowIso() : null, input.mode === 'human' ? c.get('adminId')! : null, nowIso(), id);
  await audit(c.env.DB, c.get('adminId')!, 'conversation.ai_mode_changed', 'conversation', id, { mode: input.mode }, c.get('requestId'));
  return ok(c, { mode: input.mode });
});

apiRoutes.post('/messages/text', zValidator('json', ManualMessageSchema), async c => {
  const input = c.req.valid('json');
  const conversation = await first<{ contact_id: string; last_inbound_at: string | null }>(c.env.DB,
    'SELECT contact_id, last_inbound_at FROM conversations WHERE id = ? AND deleted_at IS NULL', input.conversationId);
  if (!conversation) return fail(c, 'NOT_FOUND', 'Konuşma bulunamadı.', 404);
  if (!conversation.last_inbound_at || Date.now() - Date.parse(conversation.last_inbound_at) > 24 * 60 * 60_000) {
    return fail(c, 'WHATSAPP_WINDOW_CLOSED', '24 saatlik görüşme penceresi kapalı. Onaylı şablon kullanın.', 409);
  }
  const optout = await first(c.env.DB, "SELECT id FROM opt_outs WHERE contact_id = ? AND scope = 'all_outbound' AND revoked_at IS NULL", conversation.contact_id);
  if (optout) return fail(c, 'CONTACT_OPTED_OUT', 'Bu kişi giden mesajları durdurmuş.', 409);
  const existing = await first<{ id: string }>(c.env.DB, 'SELECT id FROM messages WHERE client_request_id = ?', input.clientRequestId);
  if (existing) return ok(c, { messageId: existing.id, duplicate: true });
  const id = crypto.randomUUID();
  const now = nowIso();
  await run(c.env.DB,
    `INSERT INTO messages (id, conversation_id, contact_id, client_request_id, direction, sender_type, message_type, text_content, delivery_status, created_at)
     VALUES (?, ?, ?, ?, 'outbound', 'admin', 'text', ?, 'queued', ?)`, id, input.conversationId, conversation.contact_id, input.clientRequestId, input.text, now);
  await run(c.env.DB, `UPDATE conversations SET human_takeover = 1, human_takeover_at = ?, human_takeover_by = ?, ai_mode = 'human', last_outbound_at = ?, last_message_at = ?, updated_at = ? WHERE id = ?`, now, c.get('adminId')!, now, now, now, input.conversationId);
  await c.env.OUTBOUND.send({ jobId: crypto.randomUUID(), conversationId: input.conversationId, contactId: conversation.contact_id, messageId: id, kind: 'text', enqueuedAt: now });
  await audit(c.env.DB, c.get('adminId')!, 'message.manual_queued', 'message', id, { conversationId: input.conversationId }, c.get('requestId'));
  return ok(c, { messageId: id, duplicate: false }, 201);
});

apiRoutes.post('/messages/template', zValidator('json', NewTemplateMessageSchema), async c => {
  const input = c.req.valid('json');
  const normalized = normalizePhone(input.phone, 'TR');
  if (!normalized.ok) return fail(c, 'PHONE_INVALID', 'Telefon numarası geçersiz veya ülke kodu eksik.', 422);
  const template = await first<{ status: string }>(c.env.DB, 'SELECT status FROM message_templates WHERE meta_name = ? AND language_code = ?', input.templateName, input.languageCode);
  if (!template || template.status !== 'APPROVED') return fail(c, 'TEMPLATE_NOT_APPROVED', 'Meta tarafından onaylanmış bir şablon seçin.', 409);
  const now = nowIso();
  let contact = await first<{ id: string }>(c.env.DB, 'SELECT id FROM contacts WHERE phone_e164 = ? AND deleted_at IS NULL', normalized.e164);
  if (!contact) {
    contact = { id: crypto.randomUUID() };
    await run(c.env.DB, `INSERT INTO contacts (id, phone_e164, display_name, country_code, source, status, created_at, updated_at) VALUES (?, ?, ?, 'TR', 'manual', 'lead', ?, ?)`, contact.id, normalized.e164, input.displayName, now, now);
  }
  let conversation = await first<{ id: string }>(c.env.DB, "SELECT id FROM conversations WHERE contact_id = ? AND status IN ('open','pending') AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1", contact.id);
  if (!conversation) {
    conversation = { id: crypto.randomUUID() };
    await run(c.env.DB, `INSERT INTO conversations (id, contact_id, status, ai_mode, created_at, updated_at) VALUES (?, ?, 'open', 'suggestion', ?, ?)`, conversation.id, contact.id, now, now);
  }
  const messageId = crypto.randomUUID();
  await run(c.env.DB, `INSERT INTO messages (id, conversation_id, contact_id, direction, sender_type, message_type, text_content, delivery_status, created_at) VALUES (?, ?, ?, 'outbound', 'admin', 'template', ?, 'queued', ?)`, messageId, conversation.id, contact.id, JSON.stringify({ templateName: input.templateName, languageCode: input.languageCode, variables: input.variables }), now);
  await c.env.OUTBOUND.send({ jobId: crypto.randomUUID(), conversationId: conversation.id, contactId: contact.id, messageId, kind: 'template', enqueuedAt: now });
  return ok(c, { contactId: contact.id, conversationId: conversation.id, messageId }, 201);
});

apiRoutes.post('/conversations/:id/attachments', async c => {
  const conversationId = c.req.param('id');
  const conversation = await first<{ contact_id: string; last_inbound_at: string | null }>(c.env.DB, 'SELECT contact_id, last_inbound_at FROM conversations WHERE id = ? AND deleted_at IS NULL', conversationId);
  if (!conversation) return fail(c, 'NOT_FOUND', 'Konuşma bulunamadı.', 404);
  if (!conversation.last_inbound_at || Date.now() - Date.parse(conversation.last_inbound_at) > 24 * 60 * 60_000) return fail(c, 'WHATSAPP_WINDOW_CLOSED', 'Dosya göndermek için 24 saatlik görüşme penceresi açık olmalıdır.', 409);
  const form = await c.req.formData();
  const file = form.get('file');
  if (!(file instanceof File)) return fail(c, 'FILE_REQUIRED', 'Bir dosya seçin.', 422);
  const stored = await storeAttachment(c.env, { conversationId, contactId: conversation.contact_id, originalName: file.name, mimeType: file.type, bytes: new Uint8Array(await file.arrayBuffer()), source: 'admin', adminId: c.get('adminId')! });
  const messageId = crypto.randomUUID();
  const now = nowIso();
  await run(c.env.DB, `INSERT INTO messages (id, conversation_id, contact_id, direction, sender_type, message_type, attachment_id, delivery_status, created_at) VALUES (?, ?, ?, 'outbound', 'admin', ?, ?, 'queued', ?)`, messageId, conversationId, conversation.contact_id, file.type.startsWith('image/') ? 'image' : 'document', stored.id, now);
  await c.env.OUTBOUND.send({ jobId: crypto.randomUUID(), conversationId, contactId: conversation.contact_id, messageId, kind: 'media', enqueuedAt: now });
  return ok(c, { messageId, attachmentId: stored.id }, 201);
});

apiRoutes.get('/attachments/:id', async c => {
  const row = await first<{ r2_key: string; original_name: string; mime_type: string }>(c.env.DB, 'SELECT r2_key, original_name, mime_type FROM attachments WHERE id = ? AND deleted_at IS NULL', c.req.param('id'));
  if (!row) return fail(c, 'NOT_FOUND', 'Dosya bulunamadı.', 404);
  const object = await c.env.FILES.get(row.r2_key);
  if (!object) return fail(c, 'FILE_MISSING', 'Dosya depolama alanında bulunamadı.', 404);
  const headers = new Headers();
  headers.set('Content-Type', row.mime_type);
  headers.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(row.original_name)}`);
  headers.set('Cache-Control', 'private, no-store');
  return new Response(object.body, { headers });
});

apiRoutes.get('/contacts', async c => {
  const q = (c.req.query('q') ?? '').trim();
  const like = `%${q}%`;
  return ok(c, await all(c.env.DB, `SELECT id, phone_e164, display_name, company_name, email, city, status, source, last_contact_at, created_at FROM contacts WHERE deleted_at IS NULL AND (? = '' OR display_name LIKE ? OR phone_e164 LIKE ? OR COALESCE(company_name,'') LIKE ?) ORDER BY updated_at DESC LIMIT 500`, q, like, like, like));
});

apiRoutes.post('/contacts', zValidator('json', ContactSchema), async c => {
  const input = c.req.valid('json');
  const normalized = normalizePhone(input.phone, input.countryCode ?? 'TR');
  if (!normalized.ok) return fail(c, 'PHONE_INVALID', 'Telefon numarası geçersiz veya ülke kodu eksik.', 422);
  const id = crypto.randomUUID();
  const now = nowIso();
  try {
    await run(c.env.DB, `INSERT INTO contacts (id, phone_e164, display_name, company_name, email, city, country_code, source, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'lead', ?, ?)`, id, normalized.e164, input.displayName, input.companyName ?? null, input.email ?? null, input.city ?? null, normalized.countryCode, input.source, now, now);
  } catch { return fail(c, 'CONTACT_EXISTS', 'Bu telefon numarası zaten kayıtlı.', 409); }
  return ok(c, { id, phoneE164: normalized.e164 }, 201);
});

apiRoutes.get('/knowledge', async c => ok(c, await all(c.env.DB, `SELECT id, title, category, content, status, usage_permission, source_type, vector_status, vector_version, approved_at, updated_at FROM business_knowledge WHERE deleted_at IS NULL ORDER BY updated_at DESC`)));

apiRoutes.post('/knowledge', zValidator('json', KnowledgeEntrySchema), async c => {
  const input = c.req.valid('json');
  const id = crypto.randomUUID();
  const now = nowIso();
  await run(c.env.DB, `INSERT INTO business_knowledge (id, title, category, content, status, usage_permission, source_type, vector_status, created_by_admin_id, approved_by_admin_id, approved_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'manual', 'pending', ?, ?, ?, ?, ?)`, id, input.title, input.category, input.content, input.status, input.usagePermission, c.get('adminId')!, input.status === 'approved' ? c.get('adminId')! : null, input.status === 'approved' ? now : null, now, now);
  if (input.status === 'approved') c.executionCtx.waitUntil(indexKnowledge(c.env, id));
  await audit(c.env.DB, c.get('adminId')!, 'knowledge.created', 'knowledge', id, { status: input.status }, c.get('requestId'));
  return ok(c, { id }, 201);
});

apiRoutes.put('/knowledge/:id', zValidator('json', KnowledgeEntrySchema), async c => {
  const input = c.req.valid('json');
  const id = c.req.param('id');
  const now = nowIso();
  await run(c.env.DB, `UPDATE business_knowledge SET title = ?, category = ?, content = ?, status = ?, usage_permission = ?, vector_status = 'pending', approved_by_admin_id = ?, approved_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`, input.title, input.category, input.content, input.status, input.usagePermission, input.status === 'approved' ? c.get('adminId')! : null, input.status === 'approved' ? now : null, now, id);
  if (input.status === 'approved') c.executionCtx.waitUntil(indexKnowledge(c.env, id));
  return ok(c, { updated: true });
});

apiRoutes.delete('/knowledge/:id', async c => {
  await run(c.env.DB, `UPDATE business_knowledge SET deleted_at = ?, status = 'disabled', vector_status = 'disabled', updated_at = ? WHERE id = ?`, nowIso(), nowIso(), c.req.param('id'));
  return ok(c, { deleted: true });
});

apiRoutes.get('/ai/settings', async c => {
  let handoffRules: string[] = [];
  try { handoffRules = JSON.parse(await setting(c.env.DB, 'ai_handoff_rules') ?? '[]') as string[]; } catch { handoffRules = []; }
  return ok(c, {
    globalMode: await setting(c.env.DB, 'ai_global_mode') ?? 'off',
    autoReplyEnabled: (await setting(c.env.DB, 'ai_auto_reply_enabled')) === 'true',
    suggestionMode: (await setting(c.env.DB, 'ai_suggestion_mode')) === 'true',
    businessInstructions: await setting(c.env.DB, 'ai_business_instructions') ?? '', handoffRules,
    minimumConfidence: Number(await setting(c.env.DB, 'ai_minimum_confidence') ?? '0.82'),
    recentMessageCount: Number(await setting(c.env.DB, 'ai_recent_message_count') ?? '10'),
    debounceSeconds: Number(await setting(c.env.DB, 'ai_debounce_seconds') ?? '6')
  });
});

apiRoutes.put('/ai/settings', zValidator('json', AiInstructionsSchema.extend({ globalMode: z.enum(['off','suggestion','auto','business_hours']), autoReplyEnabled: z.boolean(), suggestionMode: z.boolean() })), async c => {
  const input = c.req.valid('json');
  await Promise.all([
    setSetting(c.env.DB, 'ai_global_mode', input.globalMode, c.get('adminId')),
    setSetting(c.env.DB, 'ai_auto_reply_enabled', input.autoReplyEnabled, c.get('adminId')),
    setSetting(c.env.DB, 'ai_suggestion_mode', input.suggestionMode, c.get('adminId')),
    setSetting(c.env.DB, 'ai_business_instructions', input.businessInstructions, c.get('adminId')),
    setSetting(c.env.DB, 'ai_handoff_rules', input.handoffRules, c.get('adminId')),
    setSetting(c.env.DB, 'ai_minimum_confidence', input.minimumConfidence, c.get('adminId')),
    setSetting(c.env.DB, 'ai_recent_message_count', input.recentMessageCount, c.get('adminId')),
    setSetting(c.env.DB, 'ai_debounce_seconds', input.debounceSeconds, c.get('adminId'))
  ]);
  await audit(c.env.DB, c.get('adminId')!, 'ai.settings_changed', 'system', null, { globalMode: input.globalMode, autoReplyEnabled: input.autoReplyEnabled }, c.get('requestId'));
  return ok(c, { saved: true });
});

apiRoutes.post('/ai/emergency-stop', async c => {
  await setSetting(c.env.DB, 'ai_global_mode', 'off', c.get('adminId'));
  await setSetting(c.env.DB, 'ai_auto_reply_enabled', false, c.get('adminId'));
  await run(c.env.DB, "UPDATE ai_jobs SET status = 'cancelled', updated_at = ? WHERE status IN ('queued','running')", nowIso());
  await audit(c.env.DB, c.get('adminId')!, 'ai.emergency_stop', 'system', null, {}, c.get('requestId'));
  return ok(c, { stopped: true });
});

apiRoutes.post('/ai/assistant', zValidator('json', z.object({ threadId: z.string().uuid().optional(), message: z.string().min(1).max(10000), conversationId: z.string().uuid().optional() })), async c => {
  const input = c.req.valid('json');
  let threadId = input.threadId;
  if (!threadId) {
    threadId = crypto.randomUUID();
    await run(c.env.DB, 'INSERT INTO admin_ai_threads (id, admin_id, title, selected_conversation_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', threadId, c.get('adminId')!, input.message.slice(0, 80), input.conversationId ?? null, nowIso(), nowIso());
  }
  const thread = await first<{ id: string }>(c.env.DB, 'SELECT id FROM admin_ai_threads WHERE id = ? AND admin_id = ?', threadId, c.get('adminId')!);
  if (!thread) return fail(c, 'THREAD_NOT_FOUND', 'AI görüşmesi bulunamadı.', 404);
  const history = await all<{ role: string; content: string }>(c.env.DB, 'SELECT role, content FROM admin_ai_messages WHERE thread_id = ? ORDER BY created_at ASC LIMIT 30', threadId);
  let conversationContext: unknown = null;
  if (input.conversationId) {
    conversationContext = await first(c.env.DB, `SELECT c.id, c.contact_id, p.display_name, p.company_name, r.sector, r.website_type, r.budget_min, r.budget_max, r.next_action FROM conversations c JOIN contacts p ON p.id=c.contact_id LEFT JOIN customer_requirements r ON r.conversation_id=c.id AND r.contact_id=c.contact_id WHERE c.id=? AND c.deleted_at IS NULL`, input.conversationId);
  }
  const approved = await all<{ title: string; content: string }>(c.env.DB, "SELECT title, content FROM business_knowledge WHERE status='approved' AND deleted_at IS NULL AND usage_permission IN ('internal','both') ORDER BY updated_at DESC LIMIT 12");
  const response = await c.env.AI.run(c.env.DEFAULT_AI_MODEL as keyof AiModels, {
    messages: [
      { role: 'system', content: 'Sen işletme sahibinin iç yönetim asistanısın. Başka müşterilerin verilerini karıştırma. Sadece verilen seçili konuşma ve onaylı işletme bilgisini kullan. Uydurma. Kullanıcı sana bir işletme kuralı öğretiyorsa bunu otomatik kalıcı kabul etme; yapılandırılmış öneri olarak belirt ve yönetici onayı iste.' },
      ...history.map(item => ({ role: item.role === 'admin' ? 'user' as const : 'assistant' as const, content: item.content })),
      { role: 'user', content: JSON.stringify({ question: input.message, selectedConversation: conversationContext, approvedKnowledge: approved }) }
    ], temperature: 0.25, max_tokens: 1200
  }) as unknown as { response?: string };
  const answer = response.response ?? 'Bu istek için güvenilir bir cevap oluşturamadım.';
  const now = nowIso();
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO admin_ai_messages (id, thread_id, role, content, created_at) VALUES (?, ?, 'admin', ?, ?)").bind(crypto.randomUUID(), threadId, input.message, now),
    c.env.DB.prepare("INSERT INTO admin_ai_messages (id, thread_id, role, content, created_at) VALUES (?, ?, 'assistant', ?, ?)").bind(crypto.randomUUID(), threadId, answer, now),
    c.env.DB.prepare('UPDATE admin_ai_threads SET updated_at = ? WHERE id = ?').bind(now, threadId)
  ]);
  return ok(c, { threadId, answer });
});

apiRoutes.get('/meta/status', async c => ok(c, await metaStatus(c.env)));
apiRoutes.put('/meta/credentials', zValidator('json', MetaCredentialsSchema), async c => {
  await saveMetaCredentials(c.env, c.req.valid('json'), c.get('adminId')!);
  await setSetting(c.env.DB, 'meta_connection_enabled', false, c.get('adminId'));
  return ok(c, { saved: true });
});
apiRoutes.post('/meta/verify', async c => {
  const result = await verifyMeta(c.env);
  await setSetting(c.env.DB, 'meta_connection_enabled', true, c.get('adminId'));
  return ok(c, result);
});
apiRoutes.post('/meta/pause', zValidator('json', z.object({ paused: z.boolean() })), async c => { const { paused } = c.req.valid('json'); await setMetaPaused(c.env, paused); await setSetting(c.env.DB, 'meta_connection_enabled', !paused, c.get('adminId')); return ok(c, { paused }); });
apiRoutes.delete('/meta/credentials', async c => { await removeMeta(c.env); await setSetting(c.env.DB, 'meta_connection_enabled', false, c.get('adminId')); return ok(c, { removed: true }); });

apiRoutes.post('/cloudflare/scan', zValidator('json', CloudflareScanSchema), async c => {
  const input = c.req.valid('json');
  const report = await scanInfrastructure(input.accountId, input.apiToken);
  await run(c.env.DB, 'INSERT INTO infrastructure_snapshots (id, account_id, report_json, overall_status, created_by_admin_id, created_at) VALUES (?, ?, ?, ?, ?, ?)', crypto.randomUUID(), input.accountId, JSON.stringify(report), report.overall, c.get('adminId')!, nowIso());
  return ok(c, report);
});
apiRoutes.post('/cloudflare/repair', zValidator('json', CloudflareScanSchema.extend({ actions: z.array(z.string()).max(20) })), async c => {
  const input = c.req.valid('json');
  const result = await repairInfrastructure(input.accountId, input.apiToken, input.actions);
  await audit(c.env.DB, c.get('adminId')!, 'cloudflare.safe_repair', 'infrastructure', input.accountId, { applied: result.applied }, c.get('requestId'));
  return ok(c, result);
});

apiRoutes.get('/notifications', async c => ok(c, await all(c.env.DB, 'SELECT * FROM admin_notifications ORDER BY created_at DESC LIMIT 300')));
apiRoutes.put('/notifications/:id/status', zValidator('json', z.object({ status: z.enum(['unread','read','in_progress','snoozed','completed','dismissed']) })), async c => { const { status } = c.req.valid('json'); await run(c.env.DB, 'UPDATE admin_notifications SET status = ?, updated_at = ? WHERE id = ?', status, nowIso(), c.req.param('id')); return ok(c, { updated: true }); });

apiRoutes.get('/settings', async c => ok(c, {
  branding: await first(c.env.DB, 'SELECT app_name, company_name, short_description, primary_color, secondary_color FROM branding_settings WHERE id = 1'),
  meta: await metaStatus(c.env),
  timezone: await setting(c.env.DB, 'timezone') ?? 'Europe/Istanbul',
  aiModel: c.env.DEFAULT_AI_MODEL,
  embeddingModel: c.env.DEFAULT_EMBEDDING_MODEL
}));
