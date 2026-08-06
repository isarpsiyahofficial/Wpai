import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'bootstrap.mjs');
const ACCOUNT_ID = 'ad8e99c82c6c17d823f6877ff1efade4';
const D1_ID = '81983219-f57b-487b-8144-7c70bf9b1fe2';
const TOKEN = 't'.repeat(48);
const ACCOUNT_TOKEN = `cfat_${'a'.repeat(44)}`;
const GLOBAL_KEY = `cfk_${'g'.repeat(44)}`;

function cloudflareSuccess(result) {
  return JSON.stringify({ success: true, errors: [], messages: [], result });
}

function apiSuccess(data) {
  return JSON.stringify({ ok: true, data });
}

async function withServer(handler, action) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    return await action(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function runBootstrap(baseUrl, payload) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT], {
      cwd: path.dirname(HERE),
      env: {
        ...process.env,
        WPAI_BOOTSTRAP_TEST_MODE: '1',
        WPAI_CLOUDFLARE_API_BASE: baseUrl,
        WPAI_WORKER_URL: baseUrl
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => {
      const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
      if (!line) return reject(new Error(`Bootstrap JSON üretmedi. code=${code} stderr=${stderr}`));
      try { resolve({ code, body: JSON.parse(line), stderr }); }
      catch (error) { reject(new Error(`Bootstrap JSON okunamadı: ${line}\n${stderr}\n${error}`)); }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

function setupPayload(overrides = {}) {
  return {
    action: 'setup',
    accountId: ACCOUNT_ID,
    apiToken: TOKEN,
    adminName: 'İbrahim',
    adminEmail: 'isarpsiyah@gmail.com',
    adminPassword: '123456',
    ...overrides
  };
}

test('engine emits parseable JSON before any Cloudflare network request', async () => {
  const result = await runBootstrap('http://127.0.0.1:1', {
    action: 'invalid-runtime-self-test',
    accountId: ACCOUNT_ID,
    apiToken: TOKEN
  });
  assert.notEqual(result.code, 0);
  assert.equal(result.body.ok, false);
  assert.match(result.body.error, /Geçersiz Cloudflare bağlantı işlemi/);
  assert.equal(result.body.error.includes(TOKEN), false);
  assert.doesNotMatch(result.stderr, /EISDIR|lstat/);
});

test('healthy existing WPAI installation connects without npm, Wrangler or account-settings permission', async () => {
  const requested = [];
  await withServer((request, response) => {
    requested.push(`${request.method} ${request.url}`);
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/user/tokens/verify') return response.end(cloudflareSuccess({ status: 'active', id: 'token-id' }));
    if (request.url === `/accounts/${ACCOUNT_ID}/d1/database/${D1_ID}`) return response.end(cloudflareSuccess({ uuid: D1_ID, name: 'wa-ai-prod' }));
    if (request.url === '/health') return response.end(JSON.stringify({ ok: true, components: { worker: true, d1: true } }));
    if (request.url === `/accounts/${ACCOUNT_ID}/d1/database/${D1_ID}/query`) {
      let raw = '';
      request.on('data', chunk => { raw += chunk; });
      return request.on('end', () => {
        const body = JSON.parse(raw);
        const results = body.sql.includes('COUNT(*)') ? [{ total: 0 }] : [];
        response.end(cloudflareSuccess([{ success: true, results, meta: { changes: body.sql.includes('INSERT INTO admins') ? 1 : 0 } }]));
      });
    }
    if (request.url === '/api/auth/desktop/login') return response.end(apiSuccess({
      admin: { id: 'admin-1', name: 'İbrahim', email: 'isarpsiyah@gmail.com', role: 'owner' },
      accessToken: 'a'.repeat(64), refreshToken: 'r'.repeat(64)
    }));
    if (request.url === '/api/auth/desktop/logout') return response.end(apiSuccess({ loggedOut: true }));
    response.statusCode = 404;
    response.end(JSON.stringify({ success: false, errors: [{ code: 404, message: 'unexpected route' }] }));
  }, async baseUrl => {
    const result = await runBootstrap(baseUrl, setupPayload());
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.body.ok, true);
    assert.equal(result.body.mode, 'connect_existing');
    assert.equal(result.body.admin.created, true);
    assert.equal(requested.some(value => value.includes('/accounts/') && value.endsWith(`/accounts/${ACCOUNT_ID}`)), false);
    assert.equal(requested.some(value => value.includes('/r2/buckets')), false);
    assert.equal(requested.some(value => value.includes('/workers/scripts')), false);
  });
});

test('account-owned API token uses the account verification endpoint and completes setup', async () => {
  const requested = [];
  await withServer((request, response) => {
    requested.push(`${request.method} ${request.url}`);
    response.setHeader('Content-Type', 'application/json');
    if (request.url === `/accounts/${ACCOUNT_ID}/tokens/verify`) return response.end(cloudflareSuccess({ status: 'active', id: 'account-token-id' }));
    if (request.url === `/accounts/${ACCOUNT_ID}/d1/database/${D1_ID}`) return response.end(cloudflareSuccess({ uuid: D1_ID, name: 'wa-ai-prod' }));
    if (request.url === '/health') return response.end(JSON.stringify({ ok: true, components: { worker: true, d1: true } }));
    if (request.url === `/accounts/${ACCOUNT_ID}/d1/database/${D1_ID}/query`) {
      let raw = '';
      request.on('data', chunk => { raw += chunk; });
      return request.on('end', () => {
        const body = JSON.parse(raw);
        const results = body.sql.includes('COUNT(*)') ? [{ total: 0 }] : [];
        response.end(cloudflareSuccess([{ success: true, results, meta: { changes: body.sql.includes('INSERT INTO admins') ? 1 : 0 } }]));
      });
    }
    if (request.url === '/api/auth/desktop/login') return response.end(apiSuccess({
      admin: { id: 'admin-1', name: 'İbrahim', email: 'isarpsiyah@gmail.com', role: 'owner' },
      accessToken: 'a'.repeat(64), refreshToken: 'r'.repeat(64)
    }));
    if (request.url === '/api/auth/desktop/logout') return response.end(apiSuccess({ loggedOut: true }));
    response.statusCode = 404;
    response.end(JSON.stringify({ success: false, errors: [{ code: 404, message: 'unexpected route' }] }));
  }, async baseUrl => {
    const result = await runBootstrap(baseUrl, setupPayload({ apiToken: ACCOUNT_TOKEN }));
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.body.ok, true);
    assert.equal(result.body.mode, 'connect_existing');
    assert.equal(result.body.report.tokenType, 'account');
    assert.equal(requested.includes('GET /user/tokens/verify'), false);
    assert.equal(requested.includes(`GET /accounts/${ACCOUNT_ID}/tokens/verify`), true);
  });
});

test('global API key is rejected before a Cloudflare request is attempted', async () => {
  const result = await runBootstrap('http://127.0.0.1:1', setupPayload({ apiToken: GLOBAL_KEY }));
  assert.notEqual(result.code, 0);
  assert.equal(result.body.ok, false);
  assert.match(result.body.error, /Global API Key desteklenmiyor/);
  assert.doesNotMatch(result.stderr, /ECONNREFUSED/);
});

test('invalid token returns the real Cloudflare error instead of a generic connection failure', async () => {
  await withServer((_request, response) => {
    response.statusCode = 403;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }));
  }, async baseUrl => {
    const result = await runBootstrap(baseUrl, setupPayload());
    assert.notEqual(result.code, 0);
    assert.equal(result.body.ok, false);
    assert.match(result.body.error, /Cloudflare API tokeni doğrulanamadı/);
    assert.match(result.body.error, /Authentication error/);
    assert.equal(result.body.error.includes(TOKEN), false);
  });
});

test('missing D1 permission is reported with the exact permission needed', async () => {
  await withServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/user/tokens/verify') return response.end(cloudflareSuccess({ status: 'active' }));
    response.statusCode = 403;
    response.end(JSON.stringify({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }));
  }, async baseUrl => {
    const result = await runBootstrap(baseUrl, setupPayload());
    assert.notEqual(result.code, 0);
    assert.equal(result.body.ok, false);
    assert.match(result.body.error, /D1 Read/);
    assert.match(result.body.error, /D1 Write/);
  });
});

test('an existing complete owner is never silently overwritten when the supplied password is wrong', async () => {
  const fullAdminColumns = [
    'id', 'name', 'email', 'password_hash', 'role', 'status',
    'failed_login_count', 'locked_until', 'last_login_at',
    'created_at', 'updated_at', 'deleted_at'
  ];
  const owner = {
    _rowid: 1,
    id: 'owner-1',
    name: 'Gerçek Yönetici',
    email: 'owner@example.com',
    password_hash: 'pbkdf2-sha256$310000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    last_login_at: '2026-08-05T10:00:00.000Z',
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-05T10:00:00.000Z'
  };
  let insertAttempted = false;
  let credentialOverwriteAttempted = false;

  await withServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/user/tokens/verify') return response.end(cloudflareSuccess({ status: 'active' }));
    if (request.url === `/accounts/${ACCOUNT_ID}/d1/database/${D1_ID}`) return response.end(cloudflareSuccess({ uuid: D1_ID, name: 'wa-ai-prod' }));
    if (request.url === '/health') return response.end(JSON.stringify({ ok: true, components: { worker: true, d1: true } }));
    if (request.url === `/accounts/${ACCOUNT_ID}/d1/database/${D1_ID}/query`) {
      let raw = '';
      request.on('data', chunk => { raw += chunk; });
      return request.on('end', () => {
        const body = JSON.parse(raw);
        const sql = String(body.sql).replace(/\s+/g, ' ').trim();
        if (sql === 'PRAGMA table_info(admins)') {
          return response.end(cloudflareSuccess([{ success: true, results: fullAdminColumns.map(name => ({ name })), meta: { changes: 0 } }]));
        }
        if (sql === 'SELECT rowid AS _rowid,id,created_at,updated_at FROM admins') {
          return response.end(cloudflareSuccess([{ success: true, results: [owner], meta: { changes: 0 } }]));
        }
        if (sql.startsWith('UPDATE admins SET id=?,created_at=?,updated_at=? WHERE rowid=?')) {
          return response.end(cloudflareSuccess([{ success: true, results: [], meta: { changes: 1 } }]));
        }
        if (sql.startsWith('CREATE TABLE IF NOT EXISTS') || sql.startsWith('CREATE INDEX IF NOT EXISTS')) {
          return response.end(cloudflareSuccess([{ success: true, results: [], meta: { changes: 0 } }]));
        }
        if (sql.startsWith('PRAGMA table_info(')) {
          return response.end(cloudflareSuccess([{ success: true, results: [], meta: { changes: 0 } }]));
        }
        if (sql.startsWith('ALTER TABLE ')) {
          return response.end(cloudflareSuccess([{ success: true, results: [], meta: { changes: 1 } }]));
        }
        if (sql.startsWith('SELECT rowid AS _rowid,id,name,email,password_hash,last_login_at,created_at FROM admins')) {
          return response.end(cloudflareSuccess([{ success: true, results: [owner], meta: { changes: 0 } }]));
        }
        if (sql.startsWith('UPDATE admins SET id=?,name=?,email=?,password_hash=?')) credentialOverwriteAttempted = true;
        if (sql.includes('INSERT INTO admins')) insertAttempted = true;
        if (sql.includes("COUNT(*) AS total FROM admins WHERE role='owner'")) {
          return response.end(cloudflareSuccess([{ success: true, results: [{ total: 1 }], meta: { changes: 0 } }]));
        }
        return response.end(cloudflareSuccess([{ success: true, results: [], meta: { changes: 0 } }]));
      });
    }
    if (request.url === '/api/auth/desktop/login') {
      response.statusCode = 401;
      return response.end(JSON.stringify({ ok: false, error: { code: 'LOGIN_FAILED', message: 'E-posta veya parola hatalı.' } }));
    }
    response.statusCode = 404;
    response.end('{}');
  }, async baseUrl => {
    const result = await runBootstrap(baseUrl, setupPayload());
    assert.notEqual(result.code, 0);
    assert.equal(result.body.ok, false);
    assert.match(result.body.error, /daha önce oluşturulmuş bir yönetici hesabı var/);
    assert.equal(insertAttempted, false);
    assert.equal(credentialOverwriteAttempted, false);
  });
});
