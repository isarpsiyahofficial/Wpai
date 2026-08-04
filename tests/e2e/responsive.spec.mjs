import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

const NOW = '2026-08-03T10:00:00.000Z';
const LONG_NAME = 'Çok Uzun Ünvanlı Uluslararası Dijital Dönüşüm ve Yazılım Teknolojileri Limited Şirketi';
const LONG_TEXT = 'Bu içerik gerçek üretim verilerinde karşılaşılabilecek uzun Türkçe açıklamaları, müşteri taleplerini, fiyat konuşmalarını ve teknik ayrıntıları temsil eder. Metin hiçbir alanda başka bir öğenin üzerine binmemeli, ekranın dışına taşmamalı ve okunabilir biçimde satıra kırılmalıdır.';

const usage = {
  usedNeurons: 8234.56789,
  entitlementNeurons: 12500,
  freeAllocationNeurons: 10000,
  remainingNeurons: 4265.43211,
  overageNeurons: 0,
  usagePercent: 65.8765,
  estimatedUsedNeurons: 8234.56789,
  providerReportedUsedNeurons: null,
  effectiveUsedNeurons: 8234.56789,
  officialDailyAllocationNeurons: 10000,
  officialAllocationRemainingEstimate: 1765.43211,
  configuredSafetyLimitNeurons: 12500,
  safetyLimitRemainingNeurons: 4265.43211,
  safetyLimitOverageNeurons: 0,
  safetyLimitUsagePercent: 65.8765,
  inputTokens: 9876543,
  outputTokens: 1234567,
  requests: 284,
  successfulRequests: 279,
  failedRequests: 5,
  byModel: [
    { key: '@cf/meta/llama-3.1-8b-instruct-fp8-fast', estimatedNeurons: 7234.5, inputTokens: 8765432, outputTokens: 1123456, requests: 250, successfulRequests: 247, failedRequests: 3 },
    { key: '@cf/baai/bge-m3', estimatedNeurons: 1000.06789, inputTokens: 1111111, outputTokens: 111111, requests: 34, successfulRequests: 32, failedRequests: 2 }
  ],
  byOperation: [
    { key: 'customer_auto_reply_with_long_operation_identifier', estimatedNeurons: 6234.5, inputTokens: 7000000, outputTokens: 1000000, requests: 210, successfulRequests: 208, failedRequests: 2 },
    { key: 'conversation_summary', estimatedNeurons: 2000.06789, inputTokens: 2876543, outputTokens: 234567, requests: 74, successfulRequests: 71, failedRequests: 3 }
  ],
  dailyHistory: Array.from({ length: 30 }, (_, index) => ({
    date: `2026-07-${String(index + 5).padStart(2, '0')}`,
    estimatedNeurons: index * 317.125,
    inputTokens: index * 12000,
    outputTokens: index * 2200,
    requests: index * 3,
    successfulRequests: index * 3,
    failedRequests: index % 4 === 0 ? 1 : 0
  })),
  periodStart: '2026-08-03T00:00:00.000Z',
  resetAt: '2026-08-04T00:00:00.000Z',
  historyStart: '2026-07-05T00:00:00.000Z',
  lastUpdatedAt: NOW,
  source: 'recorded_workers_ai_usage',
  usageSource: 'estimated_from_recorded_tokens',
  providerUsageAvailable: false,
  providerUsageMessage: 'Cloudflare sağlayıcı hesabından gerçek zamanlı Neuron toplamı okunamadığı için bu değer, uygulamanın kaydettiği tokenlar ve resmî model katsayılarından hesaplanan tahmindir.',
  quota: {
    warningThresholdPercent: 70,
    criticalThresholdPercent: 90,
    stopThresholdPercent: 100,
    level: 'normal',
    configuredFallbackMode: 'suggestion',
    currentGlobalMode: 'auto',
    autoReplyEnabled: true,
    safeModeApplied: false
  }
};

const conversations = [
  {
    id: 'conversation-1', contact_id: 'contact-1', status: 'open', ai_mode: 'auto', human_takeover: 0, unread_count: 12,
    last_message_at: NOW, display_name: 'İbrahim Çok Uzun Müşteri Soyadı ve Ünvanı', phone_e164: '+905321234567', company_name: LONG_NAME,
    last_message: `${LONG_TEXT} Son mesaj önizlemesi de özellikle uzundur.`
  },
  {
    id: 'conversation-2', contact_id: 'contact-2', status: 'open', ai_mode: 'suggestion', human_takeover: 1, unread_count: 1,
    last_message_at: NOW, display_name: 'Zehra Hanım', phone_e164: '+905329876543', company_name: null,
    last_message: 'Teklif ve kapsam için yönetici yanıtı bekleniyor.'
  }
];

const conversationDetail = {
  conversation: {
    id: 'conversation-1', contact_id: 'contact-1', display_name: conversations[0].display_name,
    phone_e164: conversations[0].phone_e164, company_name: LONG_NAME, ai_mode: 'auto', human_takeover: 0, last_inbound_at: NOW
  },
  messages: Array.from({ length: 12 }, (_, index) => ({
    id: `message-${index}`,
    direction: index % 2 ? 'outbound' : 'inbound',
    sender_type: index % 2 ? 'admin' : 'customer',
    message_type: 'text',
    text_content: index === 4 ? `https://ornek.example/${'uzun-yol-'.repeat(15)} ${LONG_TEXT}` : `${LONG_TEXT} Mesaj sıra numarası ${index + 1}.`,
    delivery_status: index % 2 ? 'delivered' : 'received',
    ai_generated: index === 5 ? 1 : 0,
    created_at: NOW,
    original_name: index === 6 ? 'müşteri-teknik-gereksinimler-ve-çok-uzun-dosya-adı-2026-final.pdf' : null,
    attachment_id: index === 6 ? 'attachment-1' : null
  })),
  notes: [],
  requirements: { lead_stage: 'proposal' },
  summary: { summary_text: `${LONG_TEXT} ${LONG_TEXT}` },
  handoff: null,
  lastDecision: { intent: 'pricing_question', confidence: 0.934 }
};

const contacts = Array.from({ length: 8 }, (_, index) => ({
  id: `contact-${index + 1}`,
  phone_e164: `+90532${String(1000000 + index).slice(-7)}`,
  display_name: index === 0 ? conversations[0].display_name : `Müşteri ${index + 1}`,
  company_name: index === 0 ? LONG_NAME : `Firma ${index + 1}`,
  email: index === 0 ? 'cok.uzun.eposta.adresi@uluslararasi-teknoloji.example.com' : `musteri${index + 1}@example.com`,
  city: 'Antalya', status: 'lead', source: 'manual', created_at: NOW
}));

const files = [{
  id: 'attachment-1', conversation_id: 'conversation-1', contact_id: 'contact-1',
  original_name: 'müşteri-tarafından-gönderilen-çok-uzun-teknik-şartname-ve-ekler-final-v12.pdf',
  mime_type: 'application/pdf', size_bytes: 12345678, source: 'whatsapp', scan_status: 'clean', created_at: NOW,
  display_name: conversations[0].display_name, phone_e164: conversations[0].phone_e164
}];

const notifications = [{
  id: 'notification-1', type: 'ai_handoff_with_long_identifier', priority: 'critical', status: 'unread',
  title: 'Ciddi fiyat pazarlığı ve sözleşme maddesi için yönetici müdahalesi gerekiyor', body: `${LONG_TEXT} ${LONG_TEXT}`, created_at: NOW
}];

const knowledge = [{
  id: 'knowledge-1', title: 'Web sitesi paketleri, teslim kapsamı ve kesin fiyat konuşma sınırları', category: 'Satış ve fiyatlandırma',
  content: `${LONG_TEXT} ${LONG_TEXT}`, status: 'approved', usage_permission: 'both', source_type: 'admin', vector_status: 'ready', vector_version: 4, updated_at: NOW
}];

const catalog = {
  services: [{ id: 'service-1', name: 'Kurumsal Web Sitesi ve Çok Dilli Yönetim Paneli Paketi', description: LONG_TEXT, status: 'approved', features_json: '[]', updated_at: NOW }],
  prices: [{ id: 'price-1', service_id: 'service-1', title: 'Kurumsal paket başlangıç ve kapsam bazlı fiyat aralığı', amount_min: 12500, amount_max: 987654.75, currency_code: 'TRY', status: 'approved', updated_at: NOW }]
};

const report = {
  daily: Array.from({ length: 14 }, (_, index) => ({ day: `2026-07-${String(index + 18).padStart(2, '0')}`, total: (index + 1) * 3 })),
  delivery: [{ status: 'delivered', total: 1234 }, { status: 'failed_with_retry_pending', total: 17 }],
  openHandoffs: 7,
  leadStages: [{ stage: 'proposal_waiting_customer_approval', total: 21 }, { stage: 'qualified', total: 44 }],
  ai: { total: 284, neurons: 8234.56789 }
};

const aiSettings = {
  globalMode: 'auto', autoReplyEnabled: true, suggestionMode: true,
  businessInstructions: `${LONG_TEXT}\n${LONG_TEXT}`,
  handoffRules: ['Fiyat pazarlığında insana devret.', 'Hukuki kesinlik istenirse cevap verme.', 'Müşteriler arasında veri taşıma.'],
  minimumConfidence: 0.78, recentMessageCount: 12, debounceSeconds: 7
};

const infra = {
  accountId: 'ad8e99c82c6c17d823f6877ff1efade4', accountName: 'WPAI Production', checkedAt: NOW, overall: 'repair_required',
  components: [
    { key: 'd1', label: 'D1 veritabanı wa-ai-prod', status: 'ready', current: 'wa-ai-prod', expected: 'wa-ai-prod', repairable: false, details: LONG_TEXT },
    { key: 'r2', label: 'R2 dosya alanı wa-ai-files-prod', status: 'missing', current: 'bulunamadı', expected: 'wa-ai-files-prod', repairable: true, details: LONG_TEXT },
    { key: 'queues', label: 'WhatsApp ve AI kuyrukları', status: 'misconfigured', current: '4/5', expected: '5/5', repairable: false, details: LONG_TEXT }
  ],
  plan: [{ action: 'create', resource: 'wa-ai-files-prod', destructive: false, paid: false }]
};

const pages = [
  ['dashboard', 'Gösterge Paneli'],
  ['whatsapp', 'WhatsApp'],
  ['contacts', 'Kişiler'],
  ['knowledge', 'Bilgi Bankası'],
  ['files', 'Dosyalar'],
  ['ai', 'AI Kontrolü'],
  ['training', 'AI Eğitim Merkezi'],
  ['notifications', 'Bildirimler'],
  ['reports', 'Raporlar'],
  ['settings', 'Ayarlar']
];

const viewports = [
  { name: 'phone-320x568', width: 320, height: 568 },
  { name: 'phone-390x844', width: 390, height: 844 },
  { name: 'tablet-768x1024', width: 768, height: 1024 },
  { name: 'laptop-1366x768', width: 1366, height: 768 },
  { name: 'desktop-1920x1080', width: 1920, height: 1080 }
];

function apiSuccess(data, status = 200) {
  return { status, contentType: 'application/json', body: JSON.stringify({ ok: true, data }) };
}

function apiFailure(code, message, status = 500) {
  return { status, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code, message, requestId: 'e2e-request' } }) };
}

async function installMocks(page, options = {}) {
  const auth = options.auth ?? 'ready';
  await page.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.pathname;
    const method = request.method();

    if (pathname === '/health') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        ok: true,
        components: { worker: true, d1: true, r2Binding: true, queuesBinding: true, workersAiBinding: true, vectorizeBinding: true, metaConfiguration: 'configured' }
      }) });
      return;
    }

    if (!pathname.startsWith('/api/')) {
      await route.continue();
      return;
    }

    if (pathname === '/api/auth/setup-status') {
      await route.fulfill(apiSuccess({ required: auth === 'setup' }));
      return;
    }
    if (pathname === '/api/auth/me') {
      if (auth === 'login') await route.fulfill(apiFailure('UNAUTHORIZED', 'Oturum gerekli.', 401));
      else await route.fulfill(apiSuccess({ admin: { id: 'admin-1', name: LONG_NAME, email: 'owner@example.com', role: 'owner' }, csrfToken: 'csrf-e2e-token' }));
      return;
    }
    if (pathname === '/api/auth/setup' || pathname === '/api/auth/login') {
      await route.fulfill(apiSuccess({ admin: { id: 'admin-1', name: 'Test Yönetici', email: 'owner@example.com', role: 'owner' }, csrfToken: 'csrf-e2e-token' }, pathname.endsWith('/setup') ? 201 : 200));
      return;
    }
    if (options.failDashboard && pathname === '/api/dashboard') {
      await route.fulfill(apiFailure('UPSTREAM_UNAVAILABLE', LONG_TEXT, 503));
      return;
    }

    const key = `${method} ${pathname}`;
    const get = {
      'GET /api/dashboard': { contacts: 98765, activeConversations: 4321, unreadMessages: 321, openHandoffs: 17, failedMessages: 9, unreadNotifications: 88 },
      'GET /api/ai/usage': usage,
      'GET /api/conversations': conversations,
      'GET /api/conversations/conversation-1': conversationDetail,
      'GET /api/conversations/conversation-2': { ...conversationDetail, conversation: { ...conversationDetail.conversation, id: 'conversation-2', display_name: 'Zehra Hanım', human_takeover: 1, ai_mode: 'human' } },
      'GET /api/templates': [{ id: 'template-1', meta_name: 'ilk_tanitim_mesaji_uzun_sablon_adi', language_code: 'tr', category: 'MARKETING', status: 'APPROVED', components_json: '[]' }],
      'GET /api/contacts': contacts,
      'GET /api/files': files,
      'GET /api/notifications': notifications,
      'GET /api/reports/overview': report,
      'GET /api/knowledge': knowledge,
      'GET /api/catalog': catalog,
      'GET /api/ai/settings': aiSettings,
      'GET /api/meta/status': { configured: true, status: 'configured', verifiedAt: NOW, phoneNumberIdMasked: '***4567' },
      'GET /api/settings': { aiModel: '@cf/meta/llama-3.1-8b-instruct-fp8-fast', embeddingModel: '@cf/baai/bge-m3', timezone: 'Europe/Istanbul' },
      'GET /api/branding': { app_name: 'WPAI Yönetim Paneli', company_name: LONG_NAME, short_description: LONG_TEXT, logo_key: null, primary_color: '#7657ff', secondary_color: '#22c7e8', updated_at: NOW },
      'GET /api/canned-replies': [{ id: 'reply-1', title: 'Kurumsal paket açıklaması', body: LONG_TEXT, status: 'active', updated_at: NOW }],
      'GET /api/dead-letters': [{ id: 'dead-letter-1', source_queue: 'wa-outbound', payload_json: JSON.stringify({ messageId: 'message-1', secret: '[REDACTED]' }), error_code: 'META_TEMPORARY_ERROR', status: 'pending', attempts: 4, failed_at: NOW, retried_at: null, resolved_at: null }],
      'GET /api/training/overview': { sessions: [], items: [], sources: [], jobs: [], index: { indexName: 'wa-ai-knowledge-prod', embeddingModel: '@cf/baai/bge-m3', dimensions: 1024, metric: 'cosine', activeChunks: 14, pendingJobs: 0, failedJobs: 0 } }
    };

    if (pathname === '/api/conversations' && method === 'GET') {
      await route.fulfill(apiSuccess(conversations));
      return;
    }
    if (pathname === '/api/contacts' && method === 'GET') {
      await route.fulfill(apiSuccess(contacts));
      return;
    }
    if (get[key]) {
      await route.fulfill(apiSuccess(get[key]));
      return;
    }
    if (pathname === '/api/cloudflare/scan' && method === 'POST') {
      await route.fulfill(apiSuccess(infra));
      return;
    }
    if (pathname === '/api/cloudflare/repair' && method === 'POST') {
      await route.fulfill(apiSuccess({ report: { ...infra, overall: 'ready', components: infra.components.map(item => ({ ...item, status: 'ready' })) }, applied: ['r2'], skipped: [] }));
      return;
    }
    if (pathname === '/api/ai/usage-limit' && method === 'PUT') {
      await route.fulfill(apiSuccess({ ...usage, configuredSafetyLimitNeurons: 400000, safetyLimitRemainingNeurons: 391765.43211 }));
      return;
    }
    if (pathname === '/api/ai/assistant' && method === 'POST') {
      await route.fulfill(apiSuccess({ threadId: '11111111-1111-4111-8111-111111111111', answer: `${LONG_TEXT} Yönetici onayı olmadan kesin fiyat vermeyeceğim.` }));
      return;
    }
    if (pathname === '/api/templates/sync' && method === 'POST') {
      await route.fulfill(apiSuccess({ count: 1 }));
      return;
    }
    if (pathname === '/api/messages/template' && method === 'POST') {
      await route.fulfill(apiSuccess({ conversationId: 'conversation-1' }));
      return;
    }
    if (pathname === '/api/meta/verify' && method === 'POST') {
      await route.fulfill(apiSuccess({ displayPhoneNumber: '+90 532 123 45 67' }));
      return;
    }
    if (/^\/api\/contacts\/[^/]+\/export$/.test(pathname)) {
      await route.fulfill(apiSuccess({ exportedAt: NOW, contact: contacts[0], conversations, messages: conversationDetail.messages }));
      return;
    }

    await route.fulfill(apiSuccess({ accepted: true, updated: true, id: 'created-e2e-id' }, method === 'POST' ? 201 : 200));
  });
}

async function assertLayout(page, contextLabel) {
  const result = await page.evaluate(() => {
    const root = document.documentElement;
    const body = document.body;
    const viewportWidth = window.innerWidth;
    const overflow = Math.max(root.scrollWidth, body.scrollWidth) - viewportWidth;

    const visible = element => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };

    const exemptSelector = [
      '.table-panel', '.conversation-scroll', '.messages', '.console-messages', '.neuron-history-wrap',
      '.sidebar nav', '.webhook code', '.conversation-row', 'textarea', 'input', 'select'
    ].join(',');

    const clipped = [...document.querySelectorAll('h1,h2,h3,h4,p,span,strong,small,button,label,a,code')]
      .filter(visible)
      .filter(element => !element.closest(exemptSelector))
      .filter(element => {
        const style = getComputedStyle(element);
        if (style.textOverflow === 'ellipsis') return false;
        if (['auto', 'scroll'].includes(style.overflowX)) return false;
        return element.scrollWidth > element.clientWidth + 2;
      })
      .slice(0, 20)
      .map(element => ({ selector: element.tagName.toLowerCase(), className: element.className, text: element.textContent?.trim().slice(0, 100), scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }));

    const overlapContainers = ['.topbar', '.panel-heading', '.notification', '.knowledge-list article', '.catalog-row', '.danger-panel', '.webhook', '.key-value', '.form-actions'];
    const overlaps = [];
    for (const selector of overlapContainers) {
      for (const container of document.querySelectorAll(selector)) {
        if (!visible(container)) continue;
        const children = [...container.children].filter(visible).filter(child => {
          const position = getComputedStyle(child).position;
          return position !== 'absolute' && position !== 'fixed';
        });
        for (let first = 0; first < children.length; first += 1) {
          for (let second = first + 1; second < children.length; second += 1) {
            const a = children[first].getBoundingClientRect();
            const b = children[second].getBoundingClientRect();
            const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
            const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
            if (width > 1 && height > 1) overlaps.push({ selector, first, second, width, height });
          }
        }
      }
    }

    const unnamed = [...document.querySelectorAll('button,input,select,textarea,a[href]')]
      .filter(visible)
      .filter(element => {
        if (element instanceof HTMLInputElement && element.type === 'hidden') return false;
        const labels = 'labels' in element && element.labels ? [...element.labels].map(label => label.textContent ?? '').join(' ') : '';
        const name = element.getAttribute('aria-label') || element.getAttribute('title') || element.getAttribute('placeholder') || element.textContent || labels || element.getAttribute('name');
        return !String(name ?? '').trim();
      })
      .slice(0, 20)
      .map(element => ({ tag: element.tagName, type: element.getAttribute('type'), className: element.className }));

    return { overflow, clipped, overlaps, unnamed };
  });

  expect(result.overflow, `${contextLabel}: document horizontal overflow`).toBeLessThanOrEqual(2);
  expect(result.clipped, `${contextLabel}: clipped text`).toEqual([]);
  expect(result.overlaps, `${contextLabel}: overlapping sibling elements`).toEqual([]);
  expect(result.unnamed, `${contextLabel}: unnamed interactive controls`).toEqual([]);
}

for (const viewport of viewports) {
  test(`all populated pages stay responsive at ${viewport.name}`, async ({ page }, testInfo) => {
    const consoleErrors = [];
    const pageErrors = [];
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    page.on('pageerror', error => pageErrors.push(error.message));

    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await installMocks(page);
    await page.goto('/');
    await expect(page.locator('.app-shell')).toBeVisible();

    for (const [pageId, label] of pages) {
      await page.getByRole('button', { name: label, exact: true }).click();
      await expect(page.locator('.topbar h1')).toHaveText(label);
      await page.waitForTimeout(180);
      await assertLayout(page, `${viewport.name}/${pageId}`);
      const screenshot = testInfo.outputPath('screenshots', `${viewport.name}-${pageId}.png`);
      fs.mkdirSync(path.dirname(screenshot), { recursive: true });
      await page.screenshot({ path: screenshot, fullPage: true, animations: 'disabled' });
    }

    expect(pageErrors, `${viewport.name}: uncaught browser errors`).toEqual([]);
    expect(consoleErrors.filter(value => !value.includes('favicon')), `${viewport.name}: console errors`).toEqual([]);
  });
}

test('critical administrator workflows remain usable with production-sized content', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await installMocks(page);
  await page.goto('/');

  await page.getByRole('button', { name: 'Kişiler', exact: true }).click();
  await page.getByLabel('İsim').fill('Yeni Test Müşterisi');
  await page.getByLabel('Telefon').fill('+905551112233');
  await page.getByRole('button', { name: 'Kişi Ekle', exact: true }).click();
  await expect(page.locator('.toast.success')).toContainText('Kişi eklendi');

  await page.getByRole('button', { name: 'WhatsApp', exact: true }).click();
  await page.getByPlaceholder('Müşteriye manuel mesaj yazın…').fill('Canlı ortam benzeri manuel mesaj doğrulaması.');
  await page.getByRole('button', { name: 'Gönder', exact: true }).click();
  await expect(page.locator('.toast.success')).toContainText('Mesaj gönderim kuyruğuna alındı');
  await page.getByLabel('Konuşma AI modu').selectOption('suggestion');
  await expect(page.locator('.toast.success')).toContainText('AI modu güncellendi');

  await page.getByRole('button', { name: 'AI Kontrolü', exact: true }).click();
  await page.getByLabel('Yapılandırılmış günlük güvenlik limiti').fill('400000');
  await page.getByRole('button', { name: 'Güvenlik Limitini Kaydet', exact: true }).click();
  await expect(page.locator('.toast.success')).toContainText('Neuron güvenlik limiti güncellendi');
  await page.getByPlaceholder('Örn: Fiyat pazarlığı olduğunda beni devreye sok ve kesin rakam verme.').fill('Başka müşterinin fiyatını bu müşteriye taşır mısın?');
  await page.getByRole('button', { name: 'AI ile Konuş', exact: true }).click();
  await expect(page.locator('.console-messages')).toContainText('kesin fiyat vermeyeceğim');

  await page.getByRole('button', { name: 'Ayarlar', exact: true }).click();
  await page.getByLabel('Sınırlı Cloudflare API Token', { exact: true }).fill('test-cloudflare-api-token-that-is-long-enough-for-live-like-check');
  await page.getByRole('button', { name: 'Tam Sistem Taraması', exact: true }).click();
  await expect(page.locator('.infra-grid')).toContainText('D1 veritabanı wa-ai-prod');
  await assertLayout(page, 'critical workflows/settings');
});

test('setup and login screens are responsive on the narrowest supported phone', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await installMocks(page, { auth: 'setup' });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'İlk Yönetici Kurulumu' })).toBeVisible();
  await assertLayout(page, 'setup/320');

  await page.unroute('**/*');
  await installMocks(page, { auth: 'login' });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'WPAI Yönetim Paneli' })).toBeVisible();
  await assertLayout(page, 'login/320');
});

test('API failure produces a readable error state without breaking layout', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installMocks(page, { failDashboard: true });
  await page.goto('/');
  await expect(page.locator('.toast.error')).toContainText(LONG_TEXT.slice(0, 60));
  await assertLayout(page, 'dashboard API failure');
});
