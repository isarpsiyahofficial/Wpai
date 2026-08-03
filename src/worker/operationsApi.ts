import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { AppContext } from './types';
import { all, audit, first, nowIso, run } from './db';
import { fail, ok, requireAuth } from './http';
import { normalizePhone } from '../shared/phone';
import { buildAiContext, decide } from './ai';
import { retryDeadLetter } from './deadLetter';

const BrandingSchema = z.object({
  appName: z.string().trim().min(2).max(80),
  companyName: z.string().trim().max(160).default(''),
  shortDescription: z.string().trim().max(240).default(''),
  primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  secondaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/)
});
const ReplySchema = z.object({
  title: z.string().trim().min(2).max(120),
  body: z.string().trim().min(1).max(5000),
  status: z.enum(['active', 'disabled']).default('active')
});
const RequirementsSchema = z.object({
  sector: z.string().trim().max(160).nullable().optional(),
  websiteType: z.string().trim().max(160).nullable().optional(),
  requestedPages: z.array(z.string().trim().min(1).max(160)).max(100).default([]),
  adminPanelRequired: z.boolean().nullable().optional(),
  catalogRequired: z.boolean().nullable().optional(),
  ecommerceRequired: z.boolean().nullable().optional(),
  multilanguageRequired: z.boolean().nullable().optional(),
  domainStatus: z.string().trim().max(160).nullable().optional(),
  hostingStatus: z.string().trim().max(160).nullable().optional(),
  designPreferences: z.string().trim().max(10_000).nullable().optional(),
  referenceWebsites: z.array(z.string().url().max(1000)).max(50).default([]),
  budgetMin: z.number().nonnegative().nullable().optional(),
  budgetMax: z.number().nonnegative().nullable().optional(),
  currencyCode: z.string().trim().length(3).nullable().optional(),
  deliveryExpectation: z.string().trim().max(1000).nullable().optional(),
  quotedPrice: z.number().nonnegative().nullable().optional(),
  discountAmount: z.number().nonnegative().nullable().optional(),
  paymentExpectation: z.string().trim().max(1000).nullable().optional(),
  nextAction: z.string().trim().max(1000).nullable().optional(),
  leadStage: z.string().trim().max(120).nullable().optional()
}).refine(value => value.budgetMin == null || value.budgetMax == null || value.budgetMin <= value.budgetMax,
  'Bütçe alt sınırı üst sınırı aşamaz.');
const NoteSchema = z.object({ text: z.string().trim().min(1).max(10_000) });
const ImportCommitSchema = z.object({ rowIds: z.array(z.string().uuid()).max(5000).optional() });
const ImportTemplateSchema = z.object({
  rowIds: z.array(z.string().uuid()).min(1).max(500),
  templateName: z.string().trim().min(1).max(512),
  languageCode: z.string().trim().min(2).max(20),
  variables: z.array(z.string().max(1000)).max(20).default([])
});

type ImportRow = {
  id: string;
  row_number: number;
  phone_e164: string | null;
  display_name: string | null;
  company_name: string | null;
  city: string | null;
  note_text: string | null;
  tags_json: string;
  status: string;
  reason: string | null;
};

export const operationsApiRoutes = new Hono<AppContext>();
operationsApiRoutes.use('*', requireAuth);

operationsApiRoutes.get('/branding', async c => {
  const row = await first(c.env.DB,
    `SELECT app_name,company_name,short_description,logo_key,primary_color,secondary_color,updated_at
       FROM branding_settings WHERE id=1`);
  return ok(c, row);
});

operationsApiRoutes.put('/branding', zValidator('json', BrandingSchema), async c => {
  const input = c.req.valid('json');
  await run(c.env.DB,
    `UPDATE branding_settings SET app_name=?,company_name=?,short_description=?,primary_color=?,secondary_color=?,updated_at=? WHERE id=1`,
    input.appName, input.companyName, input.shortDescription, input.primaryColor.toLowerCase(),
    input.secondaryColor.toLowerCase(), nowIso());
  await audit(c.env.DB, c.get('adminId')!, 'branding.updated', 'branding', '1',
    { appName: input.appName, colorsChanged: true }, c.get('requestId'));
  return ok(c, { updated: true });
});

operationsApiRoutes.post('/branding/logo', async c => {
  const form = await c.req.formData();
  const file = form.get('file');
  if (!(file instanceof File)) return fail(c, 'FILE_REQUIRED', 'Logo dosyası seçin.', 422);
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size <= 0 || file.size > 5 * 1024 * 1024) {
    return fail(c, 'LOGO_REJECTED', 'Logo PNG, JPEG veya WebP ve en fazla 5 MB olmalıdır.', 422);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const extension = file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg';
  const key = `branding/logo-${crypto.randomUUID()}.${extension}`;
  await c.env.FILES.put(key, bytes, {
    httpMetadata: { contentType: file.type, cacheControl: 'private, no-store' },
    customMetadata: { purpose: 'branding-logo' }
  });
  const previous = await first<{ logo_key: string | null }>(c.env.DB, 'SELECT logo_key FROM branding_settings WHERE id=1');
  await run(c.env.DB, 'UPDATE branding_settings SET logo_key=?,updated_at=? WHERE id=1', key, nowIso());
  if (previous?.logo_key && previous.logo_key !== key) await c.env.FILES.delete(previous.logo_key).catch(() => undefined);
  await audit(c.env.DB, c.get('adminId')!, 'branding.logo_updated', 'branding', '1', {}, c.get('requestId'));
  return ok(c, { updated: true });
});

operationsApiRoutes.get('/branding/logo', async c => {
  const row = await first<{ logo_key: string | null }>(c.env.DB, 'SELECT logo_key FROM branding_settings WHERE id=1');
  if (!row?.logo_key) return fail(c, 'NOT_FOUND', 'Logo bulunamadı.', 404);
  const object = await c.env.FILES.get(row.logo_key);
  if (!object) return fail(c, 'FILE_MISSING', 'Logo özel depoda bulunamadı.', 404);
  const headers = new Headers();
  headers.set('Content-Type', object.httpMetadata?.contentType ?? 'image/png');
  headers.set('Cache-Control', 'private, no-store');
  return new Response(object.body, { headers });
});

operationsApiRoutes.get('/canned-replies', async c => ok(c, await all(c.env.DB,
  `SELECT id,title,body,status,created_at,updated_at FROM canned_replies ORDER BY title`)));

operationsApiRoutes.post('/canned-replies', zValidator('json', ReplySchema), async c => {
  const input = c.req.valid('json');
  const id = crypto.randomUUID();
  const now = nowIso();
  try {
    await run(c.env.DB,
      `INSERT INTO canned_replies (id,title,body,status,created_by_admin_id,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?)`, id, input.title, input.body, input.status, c.get('adminId')!, now, now);
  } catch { return fail(c, 'REPLY_EXISTS', 'Bu başlıkta hazır cevap zaten var.', 409); }
  await audit(c.env.DB, c.get('adminId')!, 'canned_reply.created', 'canned_reply', id, {}, c.get('requestId'));
  return ok(c, { id }, 201);
});

operationsApiRoutes.put('/canned-replies/:id', zValidator('json', ReplySchema), async c => {
  const input = c.req.valid('json');
  const result = await run(c.env.DB,
    'UPDATE canned_replies SET title=?,body=?,status=?,updated_at=? WHERE id=?',
    input.title, input.body, input.status, nowIso(), c.req.param('id'));
  if (!result.meta.changes) return fail(c, 'NOT_FOUND', 'Hazır cevap bulunamadı.', 404);
  await audit(c.env.DB, c.get('adminId')!, 'canned_reply.updated', 'canned_reply', c.req.param('id'), {}, c.get('requestId'));
  return ok(c, { updated: true });
});

operationsApiRoutes.delete('/canned-replies/:id', async c => {
  const result = await run(c.env.DB, "UPDATE canned_replies SET status='disabled',updated_at=? WHERE id=?", nowIso(), c.req.param('id'));
  if (!result.meta.changes) return fail(c, 'NOT_FOUND', 'Hazır cevap bulunamadı.', 404);
  await audit(c.env.DB, c.get('adminId')!, 'canned_reply.disabled', 'canned_reply', c.req.param('id'), {}, c.get('requestId'));
  return ok(c, { disabled: true });
});

operationsApiRoutes.put('/conversations/:id/requirements', zValidator('json', RequirementsSchema), async c => {
  const conversationId = c.req.param('id');
  const conversation = await first<{ contact_id: string }>(c.env.DB,
    'SELECT contact_id FROM conversations WHERE id=? AND deleted_at IS NULL', conversationId);
  if (!conversation) return fail(c, 'NOT_FOUND', 'Konuşma bulunamadı.', 404);
  const input = c.req.valid('json');
  const now = nowIso();
  await run(c.env.DB,
    `INSERT INTO customer_requirements
      (id,contact_id,conversation_id,sector,website_type,requested_pages_json,admin_panel_required,catalog_required,
       ecommerce_required,multilanguage_required,domain_status,hosting_status,design_preferences,reference_websites_json,
       budget_min,budget_max,currency_code,delivery_expectation,quoted_price,discount_amount,payment_expectation,
       next_action,lead_stage,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(conversation_id) DO UPDATE SET
       sector=excluded.sector,website_type=excluded.website_type,requested_pages_json=excluded.requested_pages_json,
       admin_panel_required=excluded.admin_panel_required,catalog_required=excluded.catalog_required,
       ecommerce_required=excluded.ecommerce_required,multilanguage_required=excluded.multilanguage_required,
       domain_status=excluded.domain_status,hosting_status=excluded.hosting_status,
       design_preferences=excluded.design_preferences,reference_websites_json=excluded.reference_websites_json,
       budget_min=excluded.budget_min,budget_max=excluded.budget_max,currency_code=excluded.currency_code,
       delivery_expectation=excluded.delivery_expectation,quoted_price=excluded.quoted_price,
       discount_amount=excluded.discount_amount,payment_expectation=excluded.payment_expectation,
       next_action=excluded.next_action,lead_stage=excluded.lead_stage,updated_at=excluded.updated_at`,
    crypto.randomUUID(), conversation.contact_id, conversationId, input.sector ?? null, input.websiteType ?? null,
    JSON.stringify(input.requestedPages), nullableBool(input.adminPanelRequired), nullableBool(input.catalogRequired),
    nullableBool(input.ecommerceRequired), nullableBool(input.multilanguageRequired), input.domainStatus ?? null,
    input.hostingStatus ?? null, input.designPreferences ?? null, JSON.stringify(input.referenceWebsites),
    input.budgetMin ?? null, input.budgetMax ?? null, input.currencyCode?.toUpperCase() ?? null,
    input.deliveryExpectation ?? null, input.quotedPrice ?? null, input.discountAmount ?? null,
    input.paymentExpectation ?? null, input.nextAction ?? null, input.leadStage ?? null, now);
  await run(c.env.DB,
    'UPDATE conversations SET current_context_version=current_context_version+1,updated_at=? WHERE id=?', now, conversationId);
  await audit(c.env.DB, c.get('adminId')!, 'conversation.requirements_updated', 'conversation', conversationId,
    { contactId: conversation.contact_id }, c.get('requestId'));
  return ok(c, { updated: true });
});

operationsApiRoutes.post('/conversations/:id/notes', zValidator('json', NoteSchema), async c => {
  const conversationId = c.req.param('id');
  const conversation = await first<{ contact_id: string }>(c.env.DB,
    'SELECT contact_id FROM conversations WHERE id=? AND deleted_at IS NULL', conversationId);
  if (!conversation) return fail(c, 'NOT_FOUND', 'Konuşma bulunamadı.', 404);
  const id = crypto.randomUUID();
  const now = nowIso();
  await run(c.env.DB,
    `INSERT INTO customer_notes
      (id,contact_id,conversation_id,source,note_text,created_by_admin_id,created_at,updated_at)
     VALUES (?,?,?,'admin',?,?,?,?,?)`,
    id, conversation.contact_id, conversationId, c.req.valid('json').text, c.get('adminId')!, now, now);
  await audit(c.env.DB, c.get('adminId')!, 'customer_note.created', 'customer_note', id,
    { conversationId }, c.get('requestId'));
  return ok(c, { id }, 201);
});

operationsApiRoutes.patch('/conversations/:conversationId/notes/:noteId', zValidator('json', NoteSchema), async c => {
  const result = await run(c.env.DB,
    `UPDATE customer_notes SET note_text=?,updated_at=?
      WHERE id=? AND conversation_id=? AND source='admin' AND deleted_at IS NULL`,
    c.req.valid('json').text, nowIso(), c.req.param('noteId'), c.req.param('conversationId'));
  if (!result.meta.changes) return fail(c, 'NOT_FOUND', 'Düzenlenebilir not bulunamadı.', 404);
  await audit(c.env.DB, c.get('adminId')!, 'customer_note.updated', 'customer_note', c.req.param('noteId'),
    { conversationId: c.req.param('conversationId') }, c.get('requestId'));
  return ok(c, { updated: true });
});

operationsApiRoutes.delete('/conversations/:conversationId/notes/:noteId', async c => {
  const result = await run(c.env.DB,
    `UPDATE customer_notes SET deleted_at=?,updated_at=?
      WHERE id=? AND conversation_id=? AND source='admin' AND deleted_at IS NULL`,
    nowIso(), nowIso(), c.req.param('noteId'), c.req.param('conversationId'));
  if (!result.meta.changes) return fail(c, 'NOT_FOUND', 'Silinebilir not bulunamadı.', 404);
  await audit(c.env.DB, c.get('adminId')!, 'customer_note.deleted', 'customer_note', c.req.param('noteId'),
    { conversationId: c.req.param('conversationId') }, c.get('requestId'));
  return ok(c, { deleted: true });
});

operationsApiRoutes.post('/conversations/:id/ai-suggestion', async c => {
  const conversationId = c.req.param('id');
  const conversation = await first<{ contact_id: string }>(c.env.DB,
    'SELECT contact_id FROM conversations WHERE id=? AND deleted_at IS NULL', conversationId);
  if (!conversation) return fail(c, 'NOT_FOUND', 'Konuşma bulunamadı.', 404);
  const latest = await first<{ text_content: string | null }>(c.env.DB,
    `SELECT text_content FROM messages WHERE conversation_id=? AND contact_id=? AND direction='inbound'
      ORDER BY created_at DESC LIMIT 1`, conversationId, conversation.contact_id);
  if (!latest?.text_content) return fail(c, 'NO_INBOUND_MESSAGE', 'Öneri üretilecek müşteri mesajı bulunamadı.', 409);
  const context = await buildAiContext(c.env, conversationId, conversation.contact_id, latest.text_content);
  const decision = await decide(c.env, context, latest.text_content);
  await audit(c.env.DB, c.get('adminId')!, 'conversation.ai_suggestion_generated', 'conversation', conversationId,
    { action: decision.action, confidence: decision.confidence, sent: false }, c.get('requestId'));
  return ok(c, {
    action: decision.action,
    reply: decision.reply,
    confidence: decision.confidence,
    needsHuman: decision.needs_human,
    intent: decision.intent,
    sent: false
  });
});

operationsApiRoutes.get('/dead-letters', async c => ok(c, await all(c.env.DB,
  `SELECT id,source_queue,payload_json,error_code,status,attempts,failed_at,retried_at,resolved_at,created_at
     FROM dead_letter_jobs ORDER BY failed_at DESC LIMIT 500`)));

operationsApiRoutes.post('/dead-letters/:id/retry', async c => {
  try {
    const result = await retryDeadLetter(c.env, c.req.param('id'));
    await audit(c.env.DB, c.get('adminId')!, 'dead_letter.retried', 'dead_letter_job', c.req.param('id'), result, c.get('requestId'));
    return ok(c, { retried: true, ...result });
  } catch (error) {
    return fail(c, 'DEAD_LETTER_RETRY_FAILED', error instanceof Error ? error.message : 'Yeniden deneme başarısız.', 409);
  }
});

operationsApiRoutes.post('/dead-letters/:id/discard', async c => {
  const result = await run(c.env.DB,
    `UPDATE dead_letter_jobs SET status='discarded',resolved_at=?,resolved_by_admin_id=?
      WHERE id=? AND status IN ('pending','retrying')`, nowIso(), c.get('adminId')!, c.req.param('id'));
  if (!result.meta.changes) return fail(c, 'NOT_FOUND', 'Bekleyen başarısız iş bulunamadı.', 404);
  await audit(c.env.DB, c.get('adminId')!, 'dead_letter.discarded', 'dead_letter_job', c.req.param('id'), {}, c.get('requestId'));
  return ok(c, { discarded: true });
});

operationsApiRoutes.post('/contacts/import-file', async c => {
  const form = await c.req.formData();
  const file = form.get('file');
  const defaultCountryCode = String(form.get('defaultCountryCode') ?? 'TR').toUpperCase();
  if (!(file instanceof File)) return fail(c, 'FILE_REQUIRED', 'CSV dosyası seçin.', 422);
  if (!file.name.toLowerCase().endsWith('.csv') && file.type !== 'text/csv') return fail(c, 'CSV_REQUIRED', 'Yalnız CSV kabul edilir.', 422);
  if (file.size <= 0 || file.size > 5_000_000) return fail(c, 'CSV_SIZE_INVALID', 'CSV en fazla 5 MB olabilir.', 422);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes).replace(/^\uFEFF/, '');
  const rows = parseCsv(text);
  if (rows.length < 2) return fail(c, 'CSV_EMPTY', 'CSV veri satırı içermiyor.', 422);
  const headers = rows[0]!.map(normalizeHeader);
  const phoneIndex = findHeader(headers, ['telefon', 'phone', 'gsm', 'whatsapp']);
  if (phoneIndex < 0) return fail(c, 'CSV_PHONE_COLUMN_MISSING', 'telefon kolonu bulunamadı.', 422);
  const nameIndex = findHeader(headers, ['isim', 'adsoyad', 'name']);
  const companyIndex = findHeader(headers, ['firma', 'sirket', 'company']);
  const cityIndex = findHeader(headers, ['sehir', 'city']);
  const noteIndex = findHeader(headers, ['not', 'note']);
  const tagsIndex = findHeader(headers, ['etiket', 'etiketler', 'tag', 'tags']);
  const parsed: Array<Omit<ImportRow, 'id' | 'status' | 'reason'> & { rawPhone: string }> = [];
  const seen = new Set<string>();
  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index]!;
    if (row.every(cell => !cell.trim())) continue;
    const rawPhone = row[phoneIndex]?.trim() ?? '';
    const normalized = normalizePhone(rawPhone, defaultCountryCode);
    const phone = normalized.ok ? normalized.e164 : null;
    parsed.push({
      row_number: index + 1,
      phone_e164: phone,
      display_name: row[nameIndex]?.trim() || phone || rawPhone || `Satır ${index + 1}`,
      company_name: row[companyIndex]?.trim() || null,
      city: row[cityIndex]?.trim() || null,
      note_text: row[noteIndex]?.trim() || null,
      tags_json: JSON.stringify(splitTags(row[tagsIndex] ?? '')),
      rawPhone
    });
  }
  const phones = parsed.flatMap(row => row.phone_e164 ? [row.phone_e164] : []);
  const existing = new Set<string>();
  const optedOut = new Set<string>();
  for (let offset = 0; offset < phones.length; offset += 80) {
    const chunk = [...new Set(phones.slice(offset, offset + 80))];
    if (!chunk.length) continue;
    const placeholders = chunk.map(() => '?').join(',');
    for (const row of await all<{ phone_e164: string }>(c.env.DB,
      `SELECT phone_e164 FROM contacts WHERE phone_e164 IN (${placeholders}) AND deleted_at IS NULL`, ...chunk)) existing.add(row.phone_e164);
    for (const row of await all<{ phone_e164: string }>(c.env.DB,
      `SELECT p.phone_e164 FROM opt_outs o JOIN contacts p ON p.id=o.contact_id
        WHERE p.phone_e164 IN (${placeholders}) AND o.revoked_at IS NULL`, ...chunk)) optedOut.add(row.phone_e164);
  }
  const id = crypto.randomUUID();
  const r2Key = `imports/${id}/original.csv`;
  const checksum = await sha256HexBytes(bytes);
  await c.env.FILES.put(r2Key, bytes, {
    httpMetadata: { contentType: 'text/csv; charset=utf-8', cacheControl: 'private, no-store' },
    customMetadata: { importId: id, checksum }
  });
  const now = nowIso();
  const statements: D1PreparedStatement[] = [];
  let valid = 0, invalid = 0, duplicate = 0, excluded = 0;
  for (const row of parsed) {
    let status: ImportRow['status'] = 'eligible';
    let reason: string | null = null;
    if (!row.phone_e164) { status = 'invalid'; reason = 'Telefon numarası geçersiz.'; invalid += 1; }
    else if (seen.has(row.phone_e164)) { status = 'duplicate'; reason = 'CSV içinde tekrar.'; duplicate += 1; }
    else if (optedOut.has(row.phone_e164)) { status = 'opted_out'; reason = 'Kişi mesaj alımını durdurmuş.'; excluded += 1; }
    else if (existing.has(row.phone_e164)) { status = 'duplicate'; reason = 'Kişi zaten kayıtlı.'; duplicate += 1; }
    else { valid += 1; seen.add(row.phone_e164); }
    statements.push(c.env.DB.prepare(
      `INSERT INTO csv_import_rows
        (id,import_id,row_number,phone_e164,display_name,company_name,city,note_text,tags_json,status,reason,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(crypto.randomUUID(), id, row.row_number, row.phone_e164, row.display_name, row.company_name,
      row.city, row.note_text, row.tags_json, status, reason, now));
  }
  const resultJson = { totalRows: parsed.length, eligible: valid, invalid, duplicate, optedOut: excluded };
  statements.unshift(c.env.DB.prepare(
    `INSERT INTO csv_imports
      (id,r2_key,original_name,checksum,status,total_rows,valid_rows,invalid_rows,duplicate_rows,excluded_rows,result_json,created_by_admin_id,created_at)
     VALUES (?,?,?,?,'preview',?,?,?,?,?,?,?,?)`
  ).bind(id, r2Key, file.name.slice(0,255), checksum, parsed.length, valid, invalid, duplicate, excluded,
    JSON.stringify(resultJson), c.get('adminId')!, now));
  for (let offset = 0; offset < statements.length; offset += 100) {
    const results = await c.env.DB.batch(statements.slice(offset, offset + 100));
    if (results.some(result => !result.success)) throw new Error('CSV_IMPORT_PREVIEW_WRITE_FAILED');
  }
  await audit(c.env.DB, c.get('adminId')!, 'contacts.csv_preview_created', 'csv_import', id,
    resultJson, c.get('requestId'));
  return ok(c, { id, checksum, ...resultJson }, 201);
});

operationsApiRoutes.get('/contacts/imports/:id', async c => {
  const record = await first(c.env.DB,
    `SELECT id,original_name,checksum,status,total_rows,valid_rows,invalid_rows,duplicate_rows,excluded_rows,
            result_json,created_at,committed_at FROM csv_imports WHERE id=? AND created_by_admin_id=?`,
    c.req.param('id'), c.get('adminId')!);
  if (!record) return fail(c, 'NOT_FOUND', 'CSV içe aktarma kaydı bulunamadı.', 404);
  const rows = await all(c.env.DB,
    `SELECT id,row_number,phone_e164,display_name,company_name,city,note_text,tags_json,status,reason
       FROM csv_import_rows WHERE import_id=? ORDER BY row_number LIMIT 5000`, c.req.param('id'));
  return ok(c, { import: record, rows });
});

operationsApiRoutes.post('/contacts/imports/:id/commit', zValidator('json', ImportCommitSchema), async c => {
  const importId = c.req.param('id');
  const record = await first<{ status: string }>(c.env.DB,
    'SELECT status FROM csv_imports WHERE id=? AND created_by_admin_id=?', importId, c.get('adminId')!);
  if (!record) return fail(c, 'NOT_FOUND', 'CSV içe aktarma kaydı bulunamadı.', 404);
  const selected = c.req.valid('json').rowIds;
  const values: Array<string> = [importId];
  let selectedClause = '';
  if (selected?.length) {
    selectedClause = ` AND id IN (${selected.map(() => '?').join(',')})`;
    values.push(...selected);
  }
  const rows = await all<ImportRow>(c.env.DB,
    `SELECT id,row_number,phone_e164,display_name,company_name,city,note_text,tags_json,status,reason
       FROM csv_import_rows WHERE import_id=? AND status='eligible'${selectedClause} ORDER BY row_number`, ...values);
  let committed = 0, skipped = 0;
  for (const row of rows) {
    if (!row.phone_e164) { skipped += 1; continue; }
    const existing = await first(c.env.DB, 'SELECT id FROM contacts WHERE phone_e164=? AND deleted_at IS NULL', row.phone_e164);
    if (existing) {
      await run(c.env.DB, "UPDATE csv_import_rows SET status='duplicate',reason='Kişi commit sırasında zaten mevcuttu.' WHERE id=?", row.id);
      skipped += 1;
      continue;
    }
    const contactId = crypto.randomUUID();
    const now = nowIso();
    const statements: D1PreparedStatement[] = [
      c.env.DB.prepare(
        `INSERT INTO contacts
          (id,phone_e164,display_name,company_name,city,country_code,source,status,created_at,updated_at)
         VALUES (?,?,?,?,?,'TR','csv','lead',?,?)`
      ).bind(contactId, row.phone_e164, (row.display_name ?? row.phone_e164).slice(0,160),
        row.company_name?.slice(0,200) ?? null, row.city?.slice(0,120) ?? null, now, now)
    ];
    if (row.note_text) statements.push(c.env.DB.prepare(
      `INSERT INTO customer_notes
        (id,contact_id,source,note_text,created_by_admin_id,created_at,updated_at)
       VALUES (?,?,'admin',?,?,?,?)`
    ).bind(crypto.randomUUID(), contactId, row.note_text.slice(0,10_000), c.get('adminId')!, now, now));
    const writeResults = await c.env.DB.batch(statements);
    if (writeResults.some(result => !result.success)) throw new Error('CSV_CONTACT_COMMIT_FAILED');
    for (const tagName of parseTags(row.tags_json)) {
      await run(c.env.DB,
        `INSERT INTO tags (id,name,color,created_at) VALUES (?,?, '#7657ff',?) ON CONFLICT(name) DO NOTHING`,
        crypto.randomUUID(), tagName, now);
      const tag = await first<{ id: string }>(c.env.DB, 'SELECT id FROM tags WHERE name=?', tagName);
      if (tag) await run(c.env.DB,
        `INSERT OR IGNORE INTO contact_tags (contact_id,tag_id,created_at) VALUES (?,?,?)`, contactId, tag.id, now);
    }
    await run(c.env.DB, "UPDATE csv_import_rows SET status='committed',reason=NULL WHERE id=?", row.id);
    committed += 1;
  }
  await run(c.env.DB, "UPDATE csv_imports SET status='committed',committed_at=? WHERE id=?", nowIso(), importId);
  await audit(c.env.DB, c.get('adminId')!, 'contacts.csv_committed', 'csv_import', importId,
    { committed, skipped, selected: selected?.length ?? null }, c.get('requestId'));
  return ok(c, { committed, skipped });
});

operationsApiRoutes.get('/contacts/imports/:id/report.csv', async c => {
  const owned = await first(c.env.DB, 'SELECT id FROM csv_imports WHERE id=? AND created_by_admin_id=?', c.req.param('id'), c.get('adminId')!);
  if (!owned) return fail(c, 'NOT_FOUND', 'CSV içe aktarma kaydı bulunamadı.', 404);
  const rows = await all<ImportRow>(c.env.DB,
    `SELECT id,row_number,phone_e164,display_name,company_name,city,note_text,tags_json,status,reason
       FROM csv_import_rows WHERE import_id=? AND status<>'committed' ORDER BY row_number`, c.req.param('id'));
  const header = ['satir','telefon','isim','firma','sehir','etiketler','durum','neden'];
  const lines = [header, ...rows.map(row => [row.row_number, row.phone_e164 ?? '', row.display_name ?? '',
    row.company_name ?? '', row.city ?? '', parseTags(row.tags_json).join('|'), row.status, row.reason ?? ''])]
    .map(columns => columns.map(csvCell).join(','));
  return new Response('\uFEFF' + lines.join('\r\n'), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="wpai-import-${c.req.param('id')}-rapor.csv"`,
      'Cache-Control': 'private, no-store'
    }
  });
});

operationsApiRoutes.post('/contacts/imports/:id/send-template', zValidator('json', ImportTemplateSchema), async c => {
  const importId = c.req.param('id');
  const owned = await first(c.env.DB, 'SELECT id FROM csv_imports WHERE id=? AND created_by_admin_id=?', importId, c.get('adminId')!);
  if (!owned) return fail(c, 'NOT_FOUND', 'CSV içe aktarma kaydı bulunamadı.', 404);
  const input = c.req.valid('json');
  const template = await first<{ status: string }>(c.env.DB,
    'SELECT status FROM message_templates WHERE meta_name=? AND language_code=?', input.templateName, input.languageCode);
  if (!template || template.status !== 'APPROVED') return fail(c, 'TEMPLATE_NOT_APPROVED', 'Meta onaylı şablon seçin.', 409);
  const placeholders = input.rowIds.map(() => '?').join(',');
  const rows = await all<ImportRow>(c.env.DB,
    `SELECT id,row_number,phone_e164,display_name,company_name,city,note_text,tags_json,status,reason
       FROM csv_import_rows WHERE import_id=? AND id IN (${placeholders}) AND status='committed'`, importId, ...input.rowIds);
  let queued = 0, skipped = 0;
  for (const row of rows) {
    if (!row.phone_e164) { skipped += 1; continue; }
    const contact = await first<{ id: string }>(c.env.DB,
      'SELECT id FROM contacts WHERE phone_e164=? AND deleted_at IS NULL', row.phone_e164);
    if (!contact) { skipped += 1; continue; }
    const optOut = await first(c.env.DB,
      "SELECT id FROM opt_outs WHERE contact_id=? AND revoked_at IS NULL AND scope IN ('marketing','all_outbound')", contact.id);
    if (optOut) { skipped += 1; continue; }
    const now = nowIso();
    let conversation = await first<{ id: string }>(c.env.DB,
      "SELECT id FROM conversations WHERE contact_id=? AND status IN ('open','pending') AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1", contact.id);
    if (!conversation) {
      conversation = { id: crypto.randomUUID() };
      await run(c.env.DB,
        `INSERT INTO conversations (id,contact_id,status,ai_mode,created_at,updated_at)
         VALUES (?,?,'open','suggestion',?,?)`, conversation.id, contact.id, now, now);
    }
    const messageId = crypto.randomUUID();
    const variables = input.variables.map(value => value.replaceAll('{{name}}', row.display_name ?? row.phone_e164 ?? ''));
    await run(c.env.DB,
      `INSERT INTO messages
        (id,conversation_id,contact_id,direction,sender_type,message_type,text_content,delivery_status,created_at)
       VALUES (?,?,?,'outbound','admin','template',?,'queued',?)`,
      messageId, conversation.id, contact.id,
      JSON.stringify({ templateName: input.templateName, languageCode: input.languageCode, variables }), now);
    await c.env.OUTBOUND.send({
      jobId: crypto.randomUUID(), conversationId: conversation.id, contactId: contact.id,
      messageId, kind: 'template', enqueuedAt: now
    });
    queued += 1;
  }
  await audit(c.env.DB, c.get('adminId')!, 'contacts.import_template_queued', 'csv_import', importId,
    { queued, skipped, templateName: input.templateName }, c.get('requestId'));
  return ok(c, { queued, skipped });
});

function nullableBool(value: boolean | null | undefined): number | null {
  return value == null ? null : value ? 1 : 0;
}
function normalizeHeader(value: string): string {
  return value.trim().toLocaleLowerCase('tr-TR').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
}
function findHeader(headers: string[], candidates: string[]): number {
  const normalized = candidates.map(normalizeHeader);
  return headers.findIndex(header => normalized.includes(header));
}
function splitTags(value: string): string[] {
  return [...new Set(value.split(/[|;,]/).map(item => item.trim()).filter(Boolean).map(item => item.slice(0,80)))].slice(0,50);
}
function parseTags(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter(item => typeof item === 'string').map(item => item.slice(0,80)).slice(0,50) : [];
  } catch { return []; }
}
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { cell += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { row.push(cell); cell = ''; }
    else if (char === '\n') { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; }
    else cell += char;
  }
  if (cell.length || row.length) { row.push(cell.replace(/\r$/, '')); rows.push(row); }
  return rows;
}
function csvCell(value: unknown): string {
  const text = String(value ?? '');
  return `"${text.replaceAll('"', '""')}"`;
}
async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength); copy.set(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', copy.buffer));
  return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
