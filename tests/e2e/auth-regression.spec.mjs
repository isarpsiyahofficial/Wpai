import { expect, test } from '@playwright/test';

const DEVICE_ID = `wpai-device-${'x'.repeat(48)}`;
const REFRESH = `refresh-${'r'.repeat(80)}`;
const NEXT_REFRESH = `refresh-${'n'.repeat(80)}`;

function success(data, status = 200) {
  return { status, contentType: 'application/json', body: JSON.stringify({ ok: true, data }) };
}

async function installPasswordlessDesktop(page, { setupError = null } = {}) {
  await page.addInitScript(({ deviceId, refresh, setupErrorMessage }) => {
    let storedRefresh = null;
    window.__TAURI_INTERNALS__ = {
      invoke: async (command, args = {}) => {
        if (command === 'cloudflare_connection_status') {
          return { configured: false, accountId: 'hidden-account-id', storage: 'Windows Credential Manager' };
        }
        if (command === 'get_or_create_device_id') return deviceId;
        if (command === 'save_desktop_refresh_token') { storedRefresh = args.token; return null; }
        if (command === 'load_desktop_refresh_token') return storedRefresh;
        if (command === 'remove_desktop_refresh_token') { storedRefresh = null; return null; }
        if (command === 'cloudflare_setup') {
          if (setupErrorMessage) throw new Error(setupErrorMessage);
          if ('adminEmail' in args || 'adminPassword' in args || 'adminName' in args) {
            throw new Error('Legacy administrator credentials reached native setup');
          }
          return {
            ok: true,
            mode: 'device_session',
            version: 'device-bootstrap-v6',
            admin: { id: 'owner-1', name: 'WPAI', email: 'wpai@local.invalid', role: 'owner' },
            session: { refreshToken: refresh, refreshExpiresAt: '2026-09-06T00:00:00.000Z', deviceId: 'device-row-1' },
            report: { emailPromptRequired: false, passwordPromptRequired: false }
          };
        }
        if (command === 'show_desktop_notification') return null;
        throw new Error(`Unexpected desktop command: ${command}`);
      },
      transformCallback: () => 1,
      unregisterCallback: () => undefined,
      convertFileSrc: value => value,
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main', windowLabel: 'main' } }
    };
  }, { deviceId: DEVICE_ID, refresh: REFRESH, setupErrorMessage: setupError });

  await page.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/desktop/refresh') {
      const body = request.postDataJSON();
      expect(body.deviceId).toBe(DEVICE_ID);
      expect(body.refreshToken).toBe(REFRESH);
      await route.fulfill(success({
        admin: { id: 'owner-1', name: 'WPAI', email: 'wpai@local.invalid', role: 'owner' },
        deviceId: 'device-row-1',
        accessToken: `access-${'a'.repeat(80)}`,
        refreshToken: NEXT_REFRESH,
        accessExpiresAt: '2026-08-07T20:00:00.000Z',
        refreshExpiresAt: '2026-09-06T00:00:00.000Z'
      }));
      return;
    }
    if (url.pathname === '/api/branding') {
      await route.fulfill(success({
        app_name: 'WPAI Yönetim Paneli', company_name: 'Test İşletmesi', short_description: '', logo_key: null,
        primary_color: '#7657ff', secondary_color: '#22c7e8', updated_at: '2026-08-07T00:00:00.000Z'
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

test('passwordless desktop setup asks only for Cloudflare API token and opens a device session', async ({ page }) => {
  await installPasswordlessDesktop(page);
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Cloudflare Bağlantısı' })).toBeVisible();
  await expect(page.getByLabel('Cloudflare User veya Account API Token')).toBeVisible();
  await expect(page.getByText('Yönetici e-postası, kullanıcı adı veya parola istenmez.')).toBeVisible();
  await expect(page.getByLabel(/e-posta/i)).toHaveCount(0);
  await expect(page.getByLabel(/yeni parola/i)).toHaveCount(0);
  await expect(page.getByLabel(/parola tekrarı/i)).toHaveCount(0);

  await page.getByLabel('Cloudflare User veya Account API Token').fill(`cfat_${'a'.repeat(44)}`);
  await page.getByRole('button', { name: 'Bağlantıyı Kur ve Panele Aç' }).click();

  await expect(page.locator('.app-shell')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Gösterge Paneli' })).toBeVisible();
  await expect(page.locator('.toast.success')).toContainText('E-posta veya parola gerekmiyor');
});

test('a D1 schema timeout is shown as its real stage and never rewritten as a missing-permission error', async ({ page }) => {
  await installPasswordlessDesktop(page, {
    setupError: 'admins şema kontrolü zaman aşımına uğradı [device-bootstrap-v6].'
  });
  await page.goto('/');
  await page.getByLabel('Cloudflare User veya Account API Token').fill(`cfat_${'a'.repeat(44)}`);
  await page.getByRole('button', { name: 'Bağlantıyı Kur ve Panele Aç' }).click();

  await expect(page.locator('.toast.error')).toContainText('admins şema kontrolü zaman aşımına uğradı');
  await expect(page.locator('.toast.error')).not.toContainText('D1 Read');
  await expect(page.locator('.toast.error')).not.toContainText('D1 Write');
  await expect(page.locator('.toast.error')).not.toContainText('izin');
});
