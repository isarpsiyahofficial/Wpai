import { expect, test } from '@playwright/test';

const DEVICE_ID = `wpai-device-${'x'.repeat(48)}`;
const ACTIVATION_TOKEN = `wpai-activation-${'a'.repeat(64)}`;
const REFRESH = `refresh-${'r'.repeat(80)}`;
const NEXT_REFRESH = `refresh-${'n'.repeat(80)}`;

function success(data, status = 200) {
  return { status, contentType: 'application/json', body: JSON.stringify({ ok: true, data }) };
}

async function installAutomaticDesktop(page, { activationError = null } = {}) {
  await page.addInitScript(({ deviceId, activationToken }) => {
    let storedRefresh = null;
    window.__TAURI_INTERNALS__ = {
      invoke: async (command, args = {}) => {
        if (command === 'cloudflare_connection_status') {
          return {
            configured: true,
            accountId: 'hidden-account-id',
            storage: 'Windows Credential Manager',
            mode: storedRefresh ? 'device_session' : 'installer_activation',
            activationToken
          };
        }
        if (command === 'get_or_create_device_id') return deviceId;
        if (command === 'save_desktop_refresh_token') { storedRefresh = args.token; return null; }
        if (command === 'load_desktop_refresh_token') return storedRefresh;
        if (command === 'remove_desktop_refresh_token') { storedRefresh = null; return null; }
        if (command === 'show_desktop_notification') return null;
        throw new Error(`Unexpected desktop command: ${command}`);
      },
      transformCallback: () => 1,
      unregisterCallback: () => undefined,
      convertFileSrc: value => value,
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main', windowLabel: 'main' } }
    };
  }, { deviceId: DEVICE_ID, activationToken: ACTIVATION_TOKEN });

  await page.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/desktop/activate') {
      if (activationError) {
        await route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({ ok: false, error: { code: 'DESKTOP_ACTIVATION_INVALID', message: activationError } })
        });
        return;
      }
      const body = request.postDataJSON();
      expect(body.deviceId).toBe(DEVICE_ID);
      expect(body.activationToken).toBe(ACTIVATION_TOKEN);
      expect(body).not.toHaveProperty('email');
      expect(body).not.toHaveProperty('password');
      expect(body).not.toHaveProperty('apiToken');
      await route.fulfill(success({
        admin: { id: 'owner-1', name: 'WPAI', email: 'wpai@local.invalid', role: 'owner' },
        deviceId: 'device-row-1',
        accessToken: `access-${'a'.repeat(80)}`,
        refreshToken: REFRESH,
        accessExpiresAt: '2026-08-14T21:00:00.000Z',
        refreshExpiresAt: '2026-09-13T20:00:00.000Z'
      }));
      return;
    }
    if (url.pathname === '/api/auth/desktop/refresh') {
      const body = request.postDataJSON();
      expect(body.deviceId).toBe(DEVICE_ID);
      expect(body.refreshToken).toBe(REFRESH);
      await route.fulfill(success({
        admin: { id: 'owner-1', name: 'WPAI', email: 'wpai@local.invalid', role: 'owner' },
        deviceId: 'device-row-1',
        accessToken: `access-${'b'.repeat(80)}`,
        refreshToken: NEXT_REFRESH,
        accessExpiresAt: '2026-08-14T22:00:00.000Z',
        refreshExpiresAt: '2026-09-13T21:00:00.000Z'
      }));
      return;
    }
    if (url.pathname === '/api/branding') {
      await route.fulfill(success({
        app_name: 'WPAI Yönetim Paneli', company_name: 'Test İşletmesi', short_description: '', logo_key: null,
        primary_color: '#7657ff', secondary_color: '#22c7e8', updated_at: '2026-08-14T00:00:00.000Z'
      }));
      return;
    }
    if (url.pathname === '/api/dashboard') {
      await route.fulfill(success({ contacts: 0, activeConversations: 0, unreadMessages: 0, openHandoffs: 0, failedMessages: 0, unreadNotifications: 0 }));
      return;
    }
    if (url.pathname === '/api/ai/usage') {
      await route.fulfill(success({
        estimatedUsedNeurons: 0, providerReportedUsedNeurons: null, officialDailyAllocationNeurons: 10000,
        officialAllocationRemainingEstimate: 10000, configuredSafetyLimitNeurons: 10000,
        safetyLimitRemainingNeurons: 10000, safetyLimitUsagePercent: 0, inputTokens: 0, outputTokens: 0,
        requests: 0, successfulRequests: 0, failedRequests: 0, byModel: [], byOperation: [], dailyHistory: [],
        lastUpdatedAt: '2026-08-14T00:00:00.000Z', providerUsageAvailable: false,
        quota: { level: 'normal', configuredFallbackMode: 'suggestion', safeModeApplied: false }
      }));
      return;
    }
    if (url.pathname === '/health') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, components: { worker: true, d1: true } }) });
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      await route.fulfill(success([]));
      return;
    }
    await route.continue();
  });
}

test('first launch activates the Windows device automatically with no user credential field', async ({ page }) => {
  await installAutomaticDesktop(page);
  await page.goto('/');

  await expect(page.locator('.app-shell')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Gösterge Paneli' })).toBeVisible();
  await expect(page.locator('input[name="apiToken"]')).toHaveCount(0);
  await expect(page.getByLabel(/e-posta/i)).toHaveCount(0);
  await expect(page.getByLabel(/^parola$/i)).toHaveCount(0);
  await expect(page.getByText('Cloudflare User veya Account API Token')).toHaveCount(0);
});

test('an invalid installer activation reports the real device activation error and never asks for Cloudflare credentials', async ({ page }) => {
  await installAutomaticDesktop(page, { activationError: 'Bu kurulumun güvenli cihaz etkinleştirmesi geçersiz veya süresi dolmuş.' });
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'WPAI Cihaz Bağlantısı' })).toBeVisible();
  await expect(page.locator('.toast.error')).toContainText('güvenli cihaz etkinleştirmesi geçersiz veya süresi dolmuş');
  await expect(page.locator('input[name="apiToken"]')).toHaveCount(0);
  await expect(page.getByText('Cloudflare User veya Account API Token')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Cihaz Bağlantısını Yeniden Dene' })).toBeVisible();
});
