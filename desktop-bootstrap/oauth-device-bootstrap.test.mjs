import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'oauth-device-bootstrap.mjs');
const ACCOUNT_ID = 'ad8e99c82c6c17d823f6877ff1efade4';

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wpai-oauth-bootstrap-'));
  const project = path.join(root, 'project');
  fs.mkdirSync(project, { recursive: true });
  const fakeNpm = path.join(root, 'fake-npm.mjs');
  fs.writeFileSync(fakeNpm, 'process.exit(0);\n');
  const fakeWrangler = path.join(root, 'fake-wrangler.mjs');
  fs.writeFileSync(fakeWrangler, `
const args = process.argv.slice(2);
for (const key of ['CLOUDFLARE_API_TOKEN','CLOUDFLARE_API_KEY','CLOUDFLARE_EMAIL','CF_API_TOKEN','CF_API_KEY','CF_EMAIL']) {
  if (process.env[key]) { console.error('provider token env leaked into Wrangler OAuth: ' + key); process.exit(17); }
}
if (args[0] === 'whoami') {
  if (process.env.MOCK_WRANGLER_AUTH === 'fail') { console.error('Not logged in'); process.exit(1); }
  console.log('Account ID: ${ACCOUNT_ID}'); process.exit(0);
}
if (args[0] === 'login') { console.log('OAuth login complete'); process.exit(0); }
if (args[0] === 'd1' || args[0] === 'deploy') { console.log('ok'); process.exit(0); }
console.error('unexpected wrangler args', args.join(' ')); process.exit(2);
`);
  return { root, project, fakeNpm, fakeWrangler };
}

async function runBootstrap(fixture, input, extraEnv = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT], {
      env: {
        ...process.env,
        WPAI_BOOTSTRAP_ROOT: fixture.root,
        WPAI_PROJECT_DIR: fixture.project,
        WPAI_NODE_PATH: process.execPath,
        WPAI_NPM_CLI: fixture.fakeNpm,
        WPAI_WRANGLER_BIN: fixture.fakeWrangler,
        WPAI_BOOTSTRAP_SKIP_NPM: '1',
        ...extraEnv
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr, body: JSON.parse(stdout.trim()) }));
    child.stdin.end(JSON.stringify(input));
  });
}

async function withWorker(handler, fn) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  try { return await fn(`http://127.0.0.1:${address.port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('existing Wrangler OAuth deploys and creates a device session without email, password or API token input', async () => {
  const fixture = makeFixture();
  try {
    await withWorker(async (req, res) => {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw || '{}');
      assert.equal(req.url, '/api/auth/desktop/activate');
      assert.equal(body.deviceId, `device-${'1'.repeat(40)}`);
      assert.equal(typeof body.activationToken, 'string');
      assert.ok(body.activationToken.length >= 40);
      assert.equal('email' in body, false);
      assert.equal('password' in body, false);
      assert.equal('apiToken' in body, false);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, data: {
        admin: { id: 'owner-1', name: 'WPAI', email: 'local@invalid', role: 'owner' },
        deviceId: 'device-row-1',
        accessToken: `access-${'a'.repeat(64)}`,
        refreshToken: `refresh-${'b'.repeat(64)}`,
        accessExpiresAt: '2099-01-01T00:00:00.000Z',
        refreshExpiresAt: '2099-02-01T00:00:00.000Z'
      } }));
    }, async workerUrl => {
      const result = await runBootstrap(fixture, {
        action: 'bootstrap',
        deviceId: `device-${'1'.repeat(40)}`,
        deviceName: 'WPAI Windows',
        appVersion: '1.3.6'
      }, {
        WPAI_WORKER_URL: workerUrl,
        CLOUDFLARE_API_TOKEN: 'expired-token-must-never-reach-wrangler-oauth',
        CF_API_TOKEN: 'legacy-expired-token-must-also-be-removed'
      });
      assert.equal(result.code, 0, result.stderr || result.stdout);
      assert.equal(result.body.ok, true);
      assert.equal(result.body.mode, 'wrangler_oauth_device');
      assert.ok(result.body.session.refreshToken.startsWith('refresh-'));
      assert.equal(result.stdout.includes('expired-token'), false);
    });
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('missing Wrangler OAuth returns a specific browser-login requirement instead of asking for a token', async () => {
  const fixture = makeFixture();
  try {
    const result = await runBootstrap(fixture, {
      action: 'bootstrap',
      deviceId: `device-${'2'.repeat(40)}`,
      deviceName: 'WPAI Windows',
      appVersion: '1.3.6'
    }, { MOCK_WRANGLER_AUTH: 'fail', CLOUDFLARE_API_TOKEN: 'expired-token' });
    assert.equal(result.code, 1);
    assert.equal(result.body.ok, false);
    assert.match(result.body.error, /WRANGLER_OAUTH_REQUIRED/);
    assert.doesNotMatch(result.body.error, /API tokeni girin/i);
    assert.doesNotMatch(result.body.error, /e-posta|parola/i);
    assert.doesNotMatch(result.body.error, /expired-token/i);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('OAuth login action uses Wrangler login and never receives administrator credentials', async () => {
  const fixture = makeFixture();
  try {
    const result = await runBootstrap(fixture, { action: 'login' }, { CLOUDFLARE_API_TOKEN: 'expired-token' });
    assert.equal(result.code, 0, result.stdout);
    assert.equal(result.body.ok, true);
    assert.equal(result.body.mode, 'wrangler_oauth');
    assert.doesNotMatch(result.stdout, /expired-token/i);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
