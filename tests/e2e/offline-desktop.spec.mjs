import { expect, test } from '@playwright/test';

function installDesktopMock(page, initiallyConnected) {
  return page.addInitScript(({ connected }) => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
    if (localStorage.getItem('wpai-test-cloudflare') === null) {
      localStorage.setItem('wpai-test-cloudflare', connected ? 'connected' : 'disconnected');
    }
    window.__TAURI_INTERNALS__ = {
      invoke: async command => {
        const configured = localStorage.getItem('wpai-test-cloudflare') === 'connected';
        if (command === 'cloudflare_connection_status') {
          return {
            configured,
            accountId: 'hidden-account-id',
            storage: 'Windows Credential Manager',
            mode: configured ? 'device_session' : 'none',
            activationToken: null
          };
        }
        if (command === 'cloudflare_forget') {
          localStorage.setItem('wpai-test-cloudflare', 'disconnected');
          return { forgotten: true, accountId: 'hidden-account-id' };
        }
        if (command === 'remove_desktop_refresh_token') return null;
        if (command === 'load_desktop_refresh_token') return null;
        if (command === 'get_or_create_device_id') return 'device-1111111111111111111111111111111111111111';
        if (command === 'show_desktop_notification') return null;
        throw new Error(`Unexpected desktop command: ${command}`);
      },
      transformCallback: () => 1,
      unregisterCallback: () => undefined,
      convertFileSrc: value => value,
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main', windowLabel: 'main' } }
    };
  }, { connected: initiallyConnected });
}

test('offline startup stays in Settings and keeps the saved device connection', async ({ page }) => {
  await installDesktopMock(page, true);
  await page.route('**/api/**', route => route.abort('internetdisconnected'));
  await page.route('**/health', route => route.abort('internetdisconnected'));
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Ayarlar' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'WPAI Cihaz Bağlantısı' })).toBeVisible();
  await expect(page.getByText('İnternet bağlantısı yok', { exact: true })).toBeVisible();
  await expect(page.getByText('Hazır', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Güvenli cihaz oturumu', { exact: true })).toBeVisible();
  await expect(page.getByText('Yerel Bilgi Modu')).toHaveCount(0);
  await expect(page.getByText('Cloudflare Account ID')).toHaveCount(0);
  await expect(page.getByText('Cloudflare User veya Account API Token')).toHaveCount(0);
  await expect(page.locator('input[name="apiToken"]')).toHaveCount(0);
});

test('removing a saved device connection keeps it removed after reopening the app', async ({ page }) => {
  await installDesktopMock(page, true);
  await page.route('**/api/**', route => route.abort('internetdisconnected'));
  await page.route('**/health', route => route.abort('internetdisconnected'));
  page.on('dialog', dialog => void dialog.accept());
  await page.goto('/');

  await page.getByRole('button', { name: 'Bu Cihazın Bağlantısını Kaldır' }).click();
  await expect(page.getByText('Bağlantı bekleniyor', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Otomatik bağlantı hazırlanıyor', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cihaz Bağlantısını Yeniden Dene' })).toBeVisible();
  await expect(page.locator('input[name="apiToken"]')).toHaveCount(0);

  await page.reload();
  await expect(page.getByText('Bağlantı bekleniyor', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Otomatik bağlantı hazırlanıyor', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cihaz Bağlantısını Yeniden Dene' })).toBeVisible();
  await expect(page.getByText('Yerel Bilgi Modu')).toHaveCount(0);
  await expect(page.locator('input[name="apiToken"]')).toHaveCount(0);
});
