import { expect, test } from '@playwright/test';

function success(data, status = 200) {
  return { status, contentType: 'application/json', body: JSON.stringify({ ok: true, data }) };
}

function failure(code, message, status) {
  return { status, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code, message, requestId: 'auth-regression' } }) };
}

async function installAuthMocks(page, options) {
  const captured = { setup: null };
  await page.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.pathname;

    if (pathname === '/health') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        ok: true,
        components: { worker: true, d1: true, r2Binding: true, queuesBinding: true, workersAiBinding: true, vectorizeBinding: true }
      }) });
      return;
    }
    if (!pathname.startsWith('/api/')) {
      await route.continue();
      return;
    }
    if (pathname === '/api/auth/setup-status') {
      await route.fulfill(success({ required: options.mode === 'setup' }));
      return;
    }
    if (pathname === '/api/auth/me') {
      await route.fulfill(failure('UNAUTHORIZED', 'Oturum gerekli.', 401));
      return;
    }
    if (pathname === '/api/auth/setup') {
      captured.setup = request.postDataJSON();
      await route.fulfill(success({
        admin: { id: 'admin-1', name: 'Test Yönetici', email: 'owner@example.com', role: 'owner' },
        csrfToken: 'csrf-auth-regression'
      }, 201));
      return;
    }
    if (pathname === '/api/auth/login') {
      if (options.failLogin) {
        await route.fulfill(failure('INVALID_CREDENTIALS', 'E-posta veya parola hatalı.', 401));
      } else {
        await route.fulfill(success({
          admin: { id: 'admin-1', name: 'Test Yönetici', email: 'owner@example.com', role: 'owner' },
          csrfToken: 'csrf-auth-regression'
        }));
      }
      return;
    }
    if (pathname === '/api/branding') {
      await route.fulfill(success({
        app_name: 'WPAI Yönetim Paneli', company_name: 'Test İşletmesi', short_description: '', logo_key: null,
        primary_color: '#7657ff', secondary_color: '#22c7e8', updated_at: '2026-08-04T00:00:00.000Z'
      }));
      return;
    }
    if (pathname === '/api/dashboard') {
      await route.fulfill(success({ contacts: 0, activeConversations: 0, unreadMessages: 0, openHandoffs: 0, failedMessages: 0, unreadNotifications: 0 }));
      return;
    }
    await route.fulfill(success([]));
  });
  return captured;
}

test('a six-character numeric password completes first administrator setup', async ({ page }) => {
  const captured = await installAuthMocks(page, { mode: 'setup', failLogin: false });
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'İlk Yönetici Kurulumu' })).toBeVisible();
  await expect(page.getByLabel('Yeni parola')).toHaveAttribute('minlength', '6');
  await page.getByLabel('Ad soyad').fill('Test Yönetici');
  await page.getByLabel('E-posta').fill('owner@example.com');
  await page.getByLabel('Yeni parola').fill('123456');
  await page.getByLabel('Parola tekrarı').fill('123456');
  await page.getByLabel('Kurulum anahtarı').fill('bootstrap-token-for-regression');
  await page.getByRole('button', { name: 'Yönetici Hesabını Oluştur' }).click();

  await expect(page.locator('.app-shell')).toBeVisible();
  expect(captured.setup?.password).toBe('123456');
});

test('a rejected login always displays a readable error instead of appearing inactive', async ({ page }) => {
  await installAuthMocks(page, { mode: 'login', failLogin: true });
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'WPAI Yönetim Paneli' })).toBeVisible();
  await expect(page.getByLabel('Parola')).toHaveAttribute('minlength', '1');
  await page.getByLabel('E-posta').fill('owner@example.com');
  await page.getByLabel('Parola').fill('123456');
  await page.getByRole('button', { name: 'Giriş Yap' }).click();

  await expect(page.getByRole('alert')).toContainText('E-posta veya parola hatalı.');
  await expect(page.locator('.toast.error')).toContainText('E-posta veya parola hatalı.');
});
