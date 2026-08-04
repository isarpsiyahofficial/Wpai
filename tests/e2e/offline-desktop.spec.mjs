import { expect, test } from '@playwright/test';

test('offline local knowledge mode searches the packaged index and exposes no send workflow', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
    window.__TAURI_INTERNALS__ = {
      invoke: async (command, args) => {
        if (command === 'faiss_health') return { ok: true, version: '1.12.0', dimension: 1024 };
        if (command === 'faiss_status') return {
          ok: true, count: 2, dimension: 1024, sourceChecksum: 'a'.repeat(64),
          contentChecksum: 'b'.repeat(64), updatedAt: 1785859200, textIndexVersion: 1, textSearchReady: true
        };
        if (command === 'faiss_search_text') {
          if (!String(args?.query ?? '').includes('admin')) throw new Error('Unexpected query');
          return [{
            id: 'knowledge:test:v1:0', score: 0.91,
            metadata: { title: 'Kurumsal web sitesi', category: 'Hizmet', content: 'Admin panelli kurumsal web sitesi ve ürün kataloğu', scope: 'global', version: 1 }
          }];
        }
        if (command === 'show_desktop_notification') return null;
        throw new Error(`Unexpected desktop command: ${command}`);
      },
      transformCallback: () => 1,
      unregisterCallback: () => undefined,
      convertFileSrc: value => value,
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main', windowLabel: 'main' } }
    };
  });
  await page.route('**/api/**', route => route.abort('internetdisconnected'));
  await page.route('**/health', route => route.abort('internetdisconnected'));
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Yerel Bilgi Modu' })).toBeVisible();
  await expect(page.getByText('Müşteri mesajı gönderme, kayıt değiştirme ve senkronizasyon işlemleri kapalıdır.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Yerel Eğitim İndeksi' })).toBeVisible();
  await page.getByLabel('Onaylı yerel bilgilerde ara').fill('admin panelli site');
  await page.getByRole('button', { name: 'Yerel Bilgide Ara' }).click();
  await expect(page.getByText('Kurumsal web sitesi', { exact: true })).toBeVisible();
  await expect(page.getByText('Admin panelli kurumsal web sitesi ve ürün kataloğu', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Buluttan Tam Senkronize Et' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Giriş Yap' })).toHaveCount(0);
});
