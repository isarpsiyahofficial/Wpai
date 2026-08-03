import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

const baseUrl = process.env.WPAI_BASE_URL ?? 'http://127.0.0.1:8787';
const bootstrapToken = 'live-like-bootstrap-token-1234567890';
const metaSecret = 'live-like-meta-app-secret-1234567890';
let cookie = '';
let csrf = '';

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function raw(path, options = {}) {
  const headers = new Headers(options.headers ?? {});
  if (options.auth !== false && cookie) headers.set('Cookie', cookie);
  if (options.csrf !== false && csrf && ['POST', 'PUT', 'PATCH', 'DELETE'].includes((options.method ?? 'GET').toUpperCase())) headers.set('X-CSRF-Token', csrf);

  let body = options.body;
  if (body && !(body instanceof FormData) && typeof body !== 'string') {
    headers.set('Content-Type', 'application/json');
    body = JSON.stringify(body);
  }

  return await fetch(`${baseUrl}${path}`, { ...options, headers, body, redirect: 'manual' });
}

async function json(path, options = {}, expectedStatus = 200) {
  const response = await raw(path, options);
  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); }
  catch { throw new Error(`${options.method ?? 'GET'} ${path} returned non-JSON ${response.status}: ${text.slice(0, 500)}`); }
  assert.equal(response.status, expectedStatus, `${options.method ?? 'GET'} ${path}: ${JSON.stringify(payload)}`);
  return { response, payload };
}

async function waitForWorker() {
  let last = '';
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      last = await response.text();
      if (response.status === 200) return JSON.parse(last);
    } catch (error) { last = String(error); }
    await sleep(500);
  }
  throw new Error(`Wrangler worker did not become ready: ${last}`);
}

async function waitForConversationWithMessage(metaMessageId) {
  let last = null;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const conversations = await json('/api/conversations?q=Canlı');
    last = conversations.payload.data;
    if (last.length === 1) {
      const conversationId = last[0].id;
      const detail = await json(`/api/conversations/${conversationId}`);
      if (detail.payload.data.messages.some(message => message.meta_message_id === metaMessageId)) {
        return { conversationId, detail: detail.payload.data };
      }
    }
    await sleep(100);
  }
  throw new Error(`Webhook payload was not persisted in time: ${JSON.stringify(last)}`);
}

const health = await waitForWorker();
assert.equal(health.ok, true);
for (const component of ['worker', 'd1', 'r2Binding', 'queuesBinding', 'workersAiBinding', 'vectorizeBinding']) {
  assert.equal(health.components[component], true, `health component ${component}`);
}

const healthResponse = await raw('/health', { auth: false });
assert.equal(healthResponse.headers.get('x-frame-options'), 'DENY');
assert.equal(healthResponse.headers.get('x-content-type-options'), 'nosniff');
assert.match(healthResponse.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);

const unauthenticated = await json('/api/dashboard', { auth: false }, 401);
assert.equal(unauthenticated.payload.ok, false);

const setup = await json('/api/auth/setup', {
  method: 'POST', auth: false, csrf: false,
  body: { name: 'Canlı Senaryo Yöneticisi', email: 'live@example.com', password: 'GüvenliParola123', bootstrapToken }
}, 201);
assert.equal(setup.payload.ok, true);
csrf = setup.payload.data.csrfToken;
cookie = (setup.response.headers.get('set-cookie') ?? '').split(';')[0];
assert.ok(cookie.includes('='), 'session cookie must be set');

const setupStatus = await json('/api/auth/setup-status', { auth: false });
assert.equal(setupStatus.payload.data.required, false);
const me = await json('/api/auth/me');
assert.equal(me.payload.data.admin.email, 'live@example.com');

const missingCsrf = await json('/api/ai/usage-limit', { method: 'PUT', csrf: false, body: { entitlementNeurons: 15000 } }, 403);
assert.equal(missingCsrf.payload.ok, false);

const contact = await json('/api/contacts', {
  method: 'POST',
  body: { displayName: 'Canlı Test Müşterisi', phone: '+905321234567', companyName: 'Üretim Benzeri Test Ltd.', email: 'customer@example.com', city: 'Antalya', countryCode: 'TR', source: 'manual' }
}, 201);
const contactId = contact.payload.data.id;
assert.ok(contactId);

const csv = 'telefon,isim,firma,sehir,not\n+905329876543,Zehra Test,Test Firma,İstanbul,Canlı senaryo notu\n+905329876543,Tekrar,Test Firma,İstanbul,Tekrar';
const csvPreview = await json('/api/contacts/import-csv', { method: 'POST', body: { csv, defaultCountryCode: 'TR', commit: false } });
assert.equal(csvPreview.payload.data.validUnique, 1);
assert.equal(csvPreview.payload.data.duplicateInFile, 1);
const csvCommit = await json('/api/contacts/import-csv', { method: 'POST', body: { csv, defaultCountryCode: 'TR', commit: true } });
assert.equal(csvCommit.payload.data.committed, 1);

const contacts = await json('/api/contacts?q=Canlı');
assert.ok(contacts.payload.data.some(item => item.id === contactId));

const knowledge = await json('/api/knowledge', {
  method: 'POST',
  body: { title: 'Canlı ortam güvenli fiyat kuralı', category: 'Satış', content: 'AI yalnız onaylı fiyat kayıtlarını kullanır ve başka müşterinin teklifini taşımaz.', status: 'approved', usagePermission: 'both' }
}, 201);
assert.ok(knowledge.payload.data.id);

const service = await json('/api/catalog/services', {
  method: 'POST',
  body: { name: 'Kurumsal Web Sitesi', description: 'Canlı senaryo hizmet kaydı', status: 'approved', features: ['Yönetim paneli', 'Responsive tasarım'] }
}, 201);
const serviceId = service.payload.data.id;
const price = await json('/api/catalog/prices', {
  method: 'POST',
  body: { serviceId, title: 'Onaylı başlangıç fiyatı', amountMin: 12500, amountMax: 25000, currencyCode: 'TRY', status: 'approved', rule: {} }
}, 201);
assert.ok(price.payload.data.id);
const catalog = await json('/api/catalog');
assert.ok(catalog.payload.data.services.some(item => item.id === serviceId));

await json('/api/meta/credentials', {
  method: 'PUT',
  body: {
    accessToken: 'live-like-access-token-not-real-but-long-enough-1234567890',
    appSecret: metaSecret,
    phoneNumberId: '123456789012345',
    businessAccountId: '987654321098765',
    verifyToken: 'live-like-verify-token-1234567890',
    adminWhatsAppPhone: '+905321112233'
  }
});

const challenge = await raw('/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=live-like-verify-token-1234567890&hub.challenge=2468', { auth: false });
assert.equal(challenge.status, 200);
assert.equal(await challenge.text(), '2468');

const webhookPayload = JSON.stringify({
  entry: [{ changes: [{ value: {
    contacts: [{ wa_id: '905321234567', profile: { name: 'Canlı Test Müşterisi' } }],
    messages: [{ id: 'wamid.live.like.1', from: '905321234567', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'Merhaba, web sitesi teklifi hakkında bilgi almak istiyorum.' } }]
  } }] }]
});
const signature = `sha256=${createHmac('sha256', metaSecret).update(webhookPayload).digest('hex')}`;
const webhookHeaders = { 'Content-Type': 'application/json', 'X-Hub-Signature-256': signature };
const webhookFirst = await json('/webhooks/whatsapp', { method: 'POST', auth: false, csrf: false, headers: webhookHeaders, body: webhookPayload });
assert.equal(webhookFirst.payload.received, true);
const webhookDuplicate = await json('/webhooks/whatsapp', { method: 'POST', auth: false, csrf: false, headers: webhookHeaders, body: webhookPayload });
assert.equal(webhookDuplicate.payload.received, true);
assert.equal(webhookDuplicate.payload.duplicate, true);

const persisted = await waitForConversationWithMessage('wamid.live.like.1');
const conversationId = persisted.conversationId;
assert.equal(persisted.detail.messages.filter(message => message.meta_message_id === 'wamid.live.like.1').length, 1);

const clientRequestId = '11111111-1111-4111-8111-111111111111';
const manualFirst = await json('/api/messages/text', {
  method: 'POST', body: { conversationId, text: 'Canlı ortam benzeri manuel yanıt.', clientRequestId }
}, 201);
assert.equal(manualFirst.payload.data.duplicate, false);
const manualDuplicate = await json('/api/messages/text', {
  method: 'POST', body: { conversationId, text: 'Canlı ortam benzeri manuel yanıt.', clientRequestId }
});
assert.equal(manualDuplicate.payload.data.duplicate, true);

const form = new FormData();
form.set('file', new File(['WPAI canlı senaryo dosya içeriği'], 'canli-senaryo.txt', { type: 'text/plain' }));
const uploaded = await json(`/api/conversations/${conversationId}/attachments`, { method: 'POST', body: form }, 201);
const attachmentId = uploaded.payload.data.attachmentId;
assert.ok(attachmentId);
const downloaded = await raw(`/api/conversations/${conversationId}/attachments/${attachmentId}`);
assert.equal(downloaded.status, 200);
assert.equal(await downloaded.text(), 'WPAI canlı senaryo dosya içeriği');
assert.equal(downloaded.headers.get('cache-control'), 'private, no-store');

const legacyFileRoute = await json(`/api/attachments/${attachmentId}`, {}, 410);
assert.equal(legacyFileRoute.payload.error.code, 'SCOPED_FILE_ROUTE_REQUIRED');

const usageBefore = await json('/api/ai/usage');
assert.equal(usageBefore.payload.data.providerUsageAvailable, false);
const usageAfter = await json('/api/ai/usage-limit', { method: 'PUT', body: { entitlementNeurons: 400000 } });
assert.equal(usageAfter.payload.data.configuredSafetyLimitNeurons, 400000);

const reports = await json('/api/reports/overview');
assert.ok(Array.isArray(reports.payload.data.daily));
const files = await json('/api/files');
assert.ok(files.payload.data.some(item => item.id === attachmentId));
const exported = await json(`/api/contacts/${contactId}/export`);
assert.equal(exported.payload.data.contact.id, contactId);

const notFound = await json('/api/this-route-must-not-exist', {}, 404);
assert.equal(notFound.payload.error.code, 'NOT_FOUND');

console.log(JSON.stringify({
  ok: true,
  contactId,
  conversationId,
  attachmentId,
  checks: [
    'health-and-security-headers', 'auth-and-csrf', 'contacts-and-csv', 'knowledge-and-pricing',
    'meta-verification-and-signed-webhook', 'webhook-idempotency', 'manual-message-idempotency',
    'r2-scoped-file-roundtrip', 'neuron-safety-limit', 'reports-and-export', 'api-not-found'
  ]
}, null, 2));
