import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, 'migrations'));
  return {
    plugins: [
      cloudflareTest({
        remoteBindings: false,
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            SESSION_SIGNING_KEY: 'test-session-signing-key-that-is-long-enough',
            DATA_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef',
            ADMIN_BOOTSTRAP_TOKEN: 'test-bootstrap-token-1234567890'
          },
          serviceBindings: {
            ASSETS: async () => new Response('asset-not-found', { status: 404 })
          }
        }
      })
    ],
    test: {
      include: ['tests/worker/**/*.test.ts'],
      setupFiles: ['./tests/worker/setup.ts'],
      testTimeout: 20_000,
      hookTimeout: 20_000
    }
  };
});
