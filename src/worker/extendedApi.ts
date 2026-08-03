import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { AppContext } from './types';
import { all, audit, first, nowIso, run } from './db';
import { fail, ok, requireAuth } from './http';
import { getMetaCredentials } from './meta';
import { indexKnowledge } from './ai';
import { normalizePhone } from '../shared/phone';

const CsvImportSchema = z.object({
  csv: z.string().min(1).max(5_000_000),
  defaultCountryCode: z.string().length(2).default('TR'),
  commit: z.boolean().default(false)
});
const CatalogSchema = z.object({
  name: z.string().trim().min(2).max(200),
  description: z.string().trim().min(2).max(10_000),
  status: z.enum(['draft', 'approved', 'disabled']),
  features: z.array(z.string().trim().min(1).max(500)).max(100).default([])
});
const PriceSchema = z.object({
  serviceId: z.string().uuid().nullable().optional(),
  title: z.string().trim().min(2).max(200),
  amountMin: z.number().nonnegative().nullable().optional(),
  amountMax: z.number().nonnegative().nullable().optional(),
  currencyCode: z.string().trim().min(3).max(3).default('TRY'),
  status: z.enum(['draft', 'approved', 'disabled']),
  rule: z.record(z.string(), z.unknown()).default({})
});
const TrainingSchema = z.object({
  title: z.string().trim().min(3).max(240),
  category: z.string().trim().min(2).max(100),
  content: z.string().trim().min(10).max(50_000),
  usagePermission: z.enum(['internal', 'customer_answers', 'both']).default('both'),
  approve: z.boolean().default(false),
  sourceThreadId: z.string().uuid().optional()
});

export const extendedApiRoutes = new Hono<AppContext>();
extendedApiRoutes.use('*', requireAuth);

extendedApiRoutes.get('/templates', async c => ok(c, await all(c.env.DB,
  `SELECT id, meta_name, language_code, category, status, components_json, synced_at, updated_at
     FROM message_templates ORDER BY meta_name, language_code`)));

extendedApiRoutes.post('/templates/sync', async c => {
  const credentials = await getMetaCredentials(c.env);
  if (!credentials) return fail(c, 'META_NOT_CONFIGURED', 'Önce Meta WhatsApp bağlantısını yapılandırın.', 409);
  const url = new URL(`https://graph.facebook.com/${c.env.META_GRAPH_API_VERSION}/${encodeURIComponent(credentials.businessAccountId)}/message_templates`);
  url.searchParams.set('fields', 'name,language,category,status,components');
  url.searchParams.set('limit', '250');
  const response = await fetch(url, { headers: { Authorization: `Bearer ${credentials.accessToken}` } });
  const body = await response.json<{ data?: Array<{ name: string; language: string; category?: string; status?: string; components?: unknown[] }>; error?: { code?: number } }>();
  if (!response.ok || !body.data) return fail(c, 'META_TEMPLATE_SYNC_FAILED', `Meta şablonları alınamadı (${body.error?.code ?? response.status}).`, 502);
  const now = nowIso();
  const statements = body.data.map(template => c.env.DB.prepare(
    `INSERT INTO message_templates (id, meta_name, language_code, category, status, components_json, synced_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(meta_name) DO UPDATE SET language_code=excluded.language_code, category=excluded.category,
       status=excluded.status, components_json=excluded.components_json, synced_at=excluded.synced_at, updated_at=excluded.updated_at`
  ).bind(crypto.randomUUID(), template.name, template.language, template.category ?? null, template.status ?? 'unknown', JSON.stringify(template.components ?? []), now, now, now));
  if (statements.length) {
    const result = await c.env.DB.batch(statements);
    if (result.some(item => !item.success)) throw new Error('TEMPLATE_SYNC_DATABASE_FAILED');
  }
  await audit(c.env.DB, c.get('adminId')!, 'meta.templates_synced', 'message_template', null, { count: body.data.length }, c.get('requestId'));
  return ok(c, { count: body.data.length });
});

extendedApiRoutes.get('/files', async c => ok(c, await all(c.env.DB,
  `SELECT a.id, a.conversation_id, a.contact_id, a.original_name, a.mime_type, a.size_bytes, a.source, a.scan_status, a.created_at,
          p.display_name, p.phone_e164
     FROM attachments a JOIN contacts p ON p.id=a.contact_id
    WHERE a.deleted_at IS NULL ORDER BY a.created_at DESC LIMIT 500`)));

extendedApiRoutes.get('/reports/overview', async c => {
  const [daily, delivery, handoffs, leads, ai] = await Promise.all([
    all(c.env.DB, `SELECT substr(created_at,1,10) AS day, COUNT(*) AS total,
      SUM(CASE WHEN direction='inbound' THEN 1 ELSE 0 END) AS inbound,
      SUM(CASE WHEN direction='outbound' THEN 1 ELSE 0 END) AS outbound
      FROM messages WHERE created_at >= datetime('now','-30 day') GROUP BY substr(created_at,1,10) ORDER BY day`),
    all(c.env.DB, `SELECT delivery_status AS status, COUNT(*) AS total FROM messages WHERE direction='outbound' GROUP BY delivery_status`),
    first<{ total: number }>(c.env.DB, "SELECT COUNT(*) AS total FROM human_handoffs WHERE status IN ('open','in_progress')"),
    all(c.env.DB, `SELECT COALESCE(lead_stage,'belirsiz') AS stage, COUNT(*) AS total FROM customer_requirements GROUP BY COALESCE(lead_stage,'belirsiz')`),
    first<{ total: number; neurons: number }>(c.env.DB, `SELECT COUNT(*) AS total, COALESCE(SUM(estimated_neurons),0) AS neurons FROM ai_usage_records WHERE created_at >= datetime('now','-30 day')`)
  ]);
  return ok(c, { daily, delivery, openHandoffs: handoffs?.total ?? 0, leadStages: leads, ai: ai ?? { total: 0, neurons: 0 } });
});

extendedApiRoutes.post('/contacts/import-csv', zValidator('json', CsvImportSchema), async c => {
  const input = c.req.valid('json');
  const rows = parseCsv(input.csv);
  if (!rows.length) return fail(c, 'CSV_EMPTY', 'CSV içinde veri satırı bulunamadı.', 422);
  const headers = rows[0]!.map(normalizeHeader);
  const phoneIndex = findHeader(headers, ['telefon', 'phone', 'gsm', 'whatsapp']);
  if (phoneIndex < 0) return fail(c, 'CSV_PHONE_COLUMN_MISSING', 'telefon kolonu bulunamadı.', 422);
  const nameIndex = findHeader(headers, ['isim', 'adsoyad', 'name']);
  const companyIndex = findHeader(headers, ['firma', 'sirket', 'company']);
  const cityIndex = findHeader(headers, ['sehir', 'şehir', 'city']);
  const noteIndex = findHeader(headers, ['not', 'note']);
  const candidates = new Map<string, { phone: string; name: string; company?: string; city?: string; note?: string; row: number }>();
  const invalid: Array<{ row: number; phone: string; reason: string }> = [];
  let duplicateInFile = 0;
  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index]!;
    if (row.every(cell => !cell.trim())) continue;
    const rawPhone = row[phoneIndex]?.trim() ?? '';
    const normalized = normalizePhone(rawPhone, input.defaultCountryCode);
    if (!normalized.ok) { invalid.push({ row: index + 1, phone: rawPhone, reason: normalized.reason }); continue; }
    if (candidates.has(normalized.e164)) { duplicateInFile += 1; continue; }
    candidates.set(normalized.e164, {
      phone: normalized.e164,
      name: row[nameIndex]?.trim() || normalized.e164,
      ...(row[companyIndex]?.trim() ? { company: row[companyIndex]!.trim() } : {}),
      ...(row[cityIndex]?.trim() ? { city: row[cityIndex]!.trim() } : {}),
      ...(row[noteIndex]?.trim() ? { note: row[noteIndex]!.trim() } : {}),
      row: index + 1
    });
  }
  const phones = [...candidates.keys()];
  const existing = new Set<string>();
  const optedOut = new Set<string>();
  for (let offset = 0; offset < phones.length; offset += 80) {
    const chunk = phones.slice(offset, offset + 80);
    const placeholders = chunk.map(() => '?').join(',');
    for (const item of await all<{ phone_e164: string }>(c.env.DB, `SELECT phone_e164 FROM contacts WHERE phone_e164 IN (${placeholders}) AND deleted_at IS NULL`, ...chunk)) existing.add(item.phone_e164);
    for (const item of await all<{ phone_e164: string }>(c.env.DB, `SELECT p.phone_e164 FROM opt_outs o JOIN contacts p ON p.id=o.contact_id WHERE p.phone_e164 IN (${placeholders}) AND o.revoked_at IS NULL`, ...chunk)) optedOut.add(item.phone_e164);
  }
  const eligible = [...candidates.values()].filter(item => !existing.has(item.phone) && !optedOut.has(item.phone));
  if (input.commit && eligible.length) {
    const now = nowIso();
    const statements: D1PreparedStatement[] = [];
    for (const item of eligible) {
      const contactId = crypto.randomUUID();
      statements.push(c.env.DB.prepare(`INSERT INTO contacts (id,phone_e164,display_name,company_name,city,country_code,source,status,created_at,updated_at) VALUES (?,?,?,?,?,'ZZ','csv','lead',?,?)`).bind(contactId, item.phone, item.name.slice(0,160), item.company?.slice(0,200) ?? null, item.city?.slice(0,120) ?? null, now, now));
      if (item.note) statements.push(c.env.DB.prepare(`INSERT INTO customer_notes (id,contact_id,source,note_text,created_by_admin_id,created_at,updated_at) VALUES (?,?,'admin',?,?,?,?,?)`).bind(crypto.randomUUID(), contactId, item.note.slice(0,2000), c.get('adminId')!, now, now));
    }
    const results = await c.env.DB.batch(statements);
    if (results.some(item => !item.success)) throw new Error('CSV_IMPORT_FAILED');
    await audit(c.env.DB, c.get('adminId')!, 'contacts.csv_imported', 'contact', null, { imported: eligible.length }, c.get('requestId'));
  }
  return ok(c, { totalRows: Math.max(0, rows.length - 1), validUnique: candidates.size, invalid, duplicateInFile, alreadyRegistered: existing.size, optOutExcluded: optedOut.size, eligible: eligible.length, committed: input.commit ? eligible.length : 0 });
});

extendedApiRoutes.get('/contacts/:id/export', async c => {
  const id = c.req.param('id');
  const contact = await first(c.env.DB, 'SELECT * FROM contacts WHERE id=? AND deleted_at IS NULL', id);
  if (!contact) return fail(c, 'NOT_FOUND', 'Kişi bulunamadı.', 404);
  const [conversations, messages, notes, requirements, attachments, handoffs] = await Promise.all([
    all(c.env.DB, 'SELECT * FROM conversations WHERE contact_id=?', id),
    all(c.env.DB, 'SELECT * FROM messages WHERE contact_id=? ORDER BY created_at', id),
    all(c.env.DB, 'SELECT * FROM customer_notes WHERE contact_id=? ORDER BY created_at', id),
    all(c.env.DB, 'SELECT * FROM customer_requirements WHERE contact_id=?', id),
    all(c.env.DB, 'SELECT id,conversation_id,original_name,mime_type,size_bytes,sha256,created_at FROM attachments WHERE contact_id=? AND deleted_at IS NULL', id),
    all(c.env.DB, 'SELECT * FROM human_handoffs WHERE contact_id=?', id)
  ]);
  return ok(c, { exportedAt: nowIso(), contact, conversations, messages, notes, requirements, attachments, handoffs });
});

extendedApiRoutes.delete('/contacts/:id', zValidator('json', z.object({ confirmPhone: z.string().min(7).max(32) })), async c => {
  const id = c.req.param('id');
  const contact = await first<{ phone_e164: string }>(c.env.DB, 'SELECT phone_e164 FROM contacts WHERE id=? AND deleted_at IS NULL', id);
  if (!contact) return fail(c, 'NOT_FOUND', 'Kişi bulunamadı.', 404);
  const normalized = normalizePhone(c.req.valid('json').confirmPhone, 'TR');
  if (!normalized.ok || normalized.e164 !== contact.phone_e164) return fail(c, 'DELETE_CONFIRMATION_FAILED', 'Telefon numarası doğrulaması başarısız.', 409);
  const objects = await all<{ r2_key: string }>(c.env.DB, 'SELECT r2_key FROM attachments WHERE contact_id=? AND deleted_at IS NULL', id);
  for (const object of objects) await c.env.FILES.delete(object.r2_key);
  await run(c.env.DB, 'DELETE FROM contacts WHERE id=?', id);
  await audit(c.env.DB, c.get('adminId')!, 'contact.permanently_deleted', 'contact', id, { filesDeleted: objects.length }, c.get('requestId'));
  return ok(c, { deleted: true });
});

extendedApiRoutes.get('/catalog', async c => ok(c, {
  services: await all(c.env.DB, 'SELECT * FROM service_catalog ORDER BY updated_at DESC'),
  prices: await all(c.env.DB, 'SELECT * FROM pricing_rules ORDER BY updated_at DESC')
}));
extendedApiRoutes.post('/catalog/services', zValidator('json', CatalogSchema), async c => {
  const input = c.req.valid('json'); const id = crypto.randomUUID(); const now = nowIso();
  await run(c.env.DB, 'INSERT INTO service_catalog (id,name,description,status,features_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)', id, input.name, input.description, input.status, JSON.stringify(input.features), now, now);
  return ok(c, { id }, 201);
});
extendedApiRoutes.post('/catalog/prices', zValidator('json', PriceSchema), async c => {
  const input = c.req.valid('json'); const id = crypto.randomUUID(); const now = nowIso();
  await run(c.env.DB, 'INSERT INTO pricing_rules (id,service_id,title,amount_min,amount_max,currency_code,rule_json,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)', id, input.serviceId ?? null, input.title, input.amountMin ?? null, input.amountMax ?? null, input.currencyCode.toUpperCase(), JSON.stringify(input.rule), input.status, now, now);
  return ok(c, { id }, 201);
});

extendedApiRoutes.get('/ai/assistant/threads', async c => ok(c, await all(c.env.DB, 'SELECT id,title,selected_conversation_id,created_at,updated_at FROM admin_ai_threads WHERE admin_id=? ORDER BY updated_at DESC LIMIT 100', c.get('adminId')!)));
extendedApiRoutes.get('/ai/assistant/threads/:id', async c => {
  const thread = await first(c.env.DB, 'SELECT id,title,selected_conversation_id,created_at,updated_at FROM admin_ai_threads WHERE id=? AND admin_id=?', c.req.param('id'), c.get('adminId')!);
  if (!thread) return fail(c, 'NOT_FOUND', 'AI görüşmesi bulunamadı.', 404);
  return ok(c, { thread, messages: await all(c.env.DB, 'SELECT id,role,content,proposed_knowledge_json,created_at FROM admin_ai_messages WHERE thread_id=? ORDER BY created_at', c.req.param('id')) });
});
extendedApiRoutes.post('/ai/training', zValidator('json', TrainingSchema), async c => {
  const input = c.req.valid('json'); const id = crypto.randomUUID(); const now = nowIso(); const status = input.approve ? 'approved' : 'draft';
  await run(c.env.DB, `INSERT INTO business_knowledge (id,title,category,content,status,usage_permission,source_type,vector_status,created_by_admin_id,approved_by_admin_id,approved_at,created_at,updated_at) VALUES (?,?,?,?,?,?,'admin_chat','pending',?,?,?,?,?)`, id, input.title, input.category, input.content, status, input.usagePermission, c.get('adminId')!, input.approve ? c.get('adminId')! : null, input.approve ? now : null, now, now);
  if (input.approve) c.executionCtx.waitUntil(indexKnowledge(c.env, id));
  if (input.sourceThreadId) await run(c.env.DB, 'UPDATE admin_ai_threads SET updated_at=? WHERE id=? AND admin_id=?', now, input.sourceThreadId, c.get('adminId')!);
  await audit(c.env.DB, c.get('adminId')!, 'ai.training_saved', 'knowledge', id, { approved: input.approve }, c.get('requestId'));
  return ok(c, { id, status }, 201);
});

function normalizeHeader(value: string): string { return value.trim().toLocaleLowerCase('tr-TR').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, ''); }
function findHeader(headers: string[], candidates: string[]): number { const normalized = candidates.map(normalizeHeader); return headers.findIndex(header => normalized.includes(header)); }
function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let cell = ''; let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quoted) { if (char === '"' && text[index + 1] === '"') { cell += '"'; index += 1; } else if (char === '"') quoted = false; else cell += char; }
    else if (char === '"') quoted = true;
    else if (char === ',' || char === ';') { row.push(cell); cell = ''; }
    else if (char === '\n') { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; }
    else cell += char;
  }
  row.push(cell.replace(/\r$/, '')); if (row.some(value => value.length)) rows.push(row); return rows;
}
