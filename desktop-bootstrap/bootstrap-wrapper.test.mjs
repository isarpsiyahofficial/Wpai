import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'bootstrap.mjs');
const ACCOUNT_ID = 'ad8e99c82c6c17d823f6877ff1efade4';
const D1_ID = '81983219-f57b-487b-8144-7c70bf9b1fe2';
const TOKEN = 't'.repeat(48);

function cfSuccess(result) {
  return JSON.stringify({ success: true, errors: [], messages: [], result });
}

function apiSuccess(data) {
  return JSON.stringify({ ok: true, data });
}

function encodedPasswordHash(password) {
  const salt = Buffer.alloc(16, 7);
  const hash = crypto.pbkdf2Sync(password, salt, 310000, 32, 'sha256');
  return `pbkdf2-sha256$310000$${salt.toString('base64')}$${hash.toString('base64')}`;
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

function runBootstrap(baseUrl) {
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
      resolve({ code, body: JSON.parse(line), stderr });
    });
    child.stdin.end(JSON.stringify({
      action: 'setup',
      accountId: ACCOUNT_ID,
      apiToken: TOKEN,
      adminName: 'İbrahim',
      adminEmail: 'isarpsiyah@gmail.com',
      adminPassword: '123456'
    }));
  });
}

function commonRoutes(request, response) {
  response.setHeader('Content-Type', 'application/json');
  if (request.url === '/user/tokens/verify') {
    response.end(cfSuccess({ status: 'active', id: 'token-id' }));
    return true;
  }
  if (request.url === `/accounts/${ACCOUNT_ID}/d1/database/${D1_ID}`) {
    response.end(cfSuccess({ uuid: D1_ID, name: 'wa-ai-prod' }));
    return true;
  }
  if (request.url === '/health') {
    response.end(JSON.stringify({ ok: true, components: { worker: true, d1: true } }));
    return true;
  }
  return false;
}

test('legacy admins table without deleted_at is repaired before owner lookup', async () => {
  let repaired = false;
  let alterCount = 0;
  let wrapperProbeCount = 0;

  await withServer((request, response) => {
    if (commonRoutes(request, response)) return;
    response.setHeader('Content-Type', 'application/json');
    if (request.url === `/accounts/${ACCOUNT_ID}/d1/database/${D1_ID}/query`) {
      let raw = '';
      request.on('data', chunk => { raw += chunk; });
      return request.on('end', () => {
        const body = JSON.parse(raw);
        if (body.sql === 'SELECT deleted_at FROM admins LIMIT 0') {
          wrapperProbeCount += 1;
          if (!repaired) {
            response.statusCode = 400;
            return response.end(JSON.stringify({ success: false, errors: [{ code: 7500, message: 'no such column: deleted_at at offset 7: SQLITE_ERROR' }] }));
          }
          return response.end(cfSuccess([{ success: true, results: [], meta: { changes: 0 } }]));
        }
        if (body.sql === 'ALTER TABLE admins ADD COLUMN deleted_at TEXT') {
          repaired = true;
          alterCount += 1;
          return response.end(cfSuccess([{ success: true, results: [], meta: { changes: 0 } }]));
        }
        const results = body.sql.includes('COUNT(*)') ? [{ total: 0 }] : [];
        return response.end(cfSuccess([{ success: true, results, meta: { changes: body.sql.includes('INSERT INTO admins') ? 1 : 0 } }]));
      });
    }
    if (request.url === '/api/auth/desktop/login') return response.end(apiSuccess({
      admin: { id: 'admin-1', name: 'İbrahim', email: 'isarpsiyah@gmail.com', role: 'owner' },
      accessToken: 'a'.repeat(64),
      refreshToken: 'r'.repeat(64)
    }));
    if (request.url === '/api/auth/desktop/logout') return response.end(apiSuccess({ loggedOut: true }));
    response.statusCode = 404;
    response.end('{}');
  }, async baseUrl => {
    const result = await runBootstrap(baseUrl);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.body.ok, true);
    assert.equal(repaired, true);
    assert.equal(alterCount, 1);
    assert.equal(wrapperProbeCount, 2);
    assert.equal(JSON.stringify(result.body).includes('D1 Read izni yoktur'), false);
  });
});

async function runOwnerRecoveryScenario({ lastLoginAt }) {
  let owner = {
    id: 'existing-owner',
    name: 'Önceki Yönetici',
    email: 'old-owner@example.com',
    password_hash: encodedPasswordHash('old-password'),
    last_login_at: lastLoginAt,
    created_at: '2026-08-01T00:00:00.000Z'
  };
  const revoked = { admin: false, desktop: false, device: false };
  let recovered = false;
  let auditWritten = false;

  await withServer((request, response) => {
    if (commonRoutes(request, response)) return;
    response.setHeader('Content-Type', 'application/json');
    if (request.url === `/accounts/${ACCOUNT_ID}/d1/database/${D1_ID}/query`) {
      let raw = '';
      request.on('data', chunk => { raw += chunk; });
      return request.on('end', () => {
        const body = JSON.parse(raw);
        const sql = String(body.sql).replace(/\s+/g, ' ').trim();
        if (sql === 'SELECT deleted_at FROM admins LIMIT 0') {
          return response.end(cfSuccess([{ success: true, results: [], meta: { changes: 0 } }]));
        }
        if (sql.startsWith('SELECT id,name,email,password_hash,last_login_at,created_at FROM admins')) {
          return response.end(cfSuccess([{ success: true, results: [owner], meta: { changes: 0 } }]));
        }
        if (sql.startsWith('SELECT id,status,deleted_at FROM admins WHERE email=?')) {
          assert.deepEqual(body.params, ['isarpsiyah@gmail.com', 'existing-owner']);
          return response.end(cfSuccess([{ success: true, results: [], meta: { changes: 0 } }]));
        }
        if (sql.startsWith('UPDATE admin_sessions SET revoked_at=?')) {
          revoked.admin = true;
          return response.end(cfSuccess([{ success: true, results: [], meta: { changes: 1 } }]));
        }
        if (sql.startsWith('UPDATE desktop_sessions SET revoked_at=?')) {
          revoked.desktop = true;
          return response.end(cfSuccess([{ success: true, results: [], meta: { changes: 1 } }]));
        }
        if (sql.startsWith("UPDATE desktop_devices SET status='revoked'")) {
          revoked.device = true;
          return response.end(cfSuccess([{ success: true, results: [], meta: { changes: 1 } }]));
        }
        if (sql.startsWith('UPDATE admins SET name=?')) {
          assert.equal(body.params[0], 'İbrahim');
          assert.equal(body.params[1], 'isarpsiyah@gmail.com');
          assert.match(body.params[2], /^pbkdf2-sha256\$310000\$/);
          assert.equal(body.params[4], 'existing-owner');
          owner = { ...owner, name: body.params[0], email: body.params[1], password_hash: body.params[2], last_login_at: null };
          recovered = true;
          return response.end(cfSuccess([{ success: true, results: [], meta: { changes: 1 } }]));
        }
        if (sql.startsWith('INSERT INTO audit_logs')) {
          auditWritten = true;
          return response.end(cfSuccess([{ success: true, results: [], meta: { changes: 1 } }]));
        }
        if (sql.startsWith("SELECT COUNT(*) AS total FROM admins WHERE role='owner'")) {
          return response.end(cfSuccess([{ success: true, results: [{ total: 1 }], meta: { changes: 0 } }]));
        }
        return response.end(cfSuccess([{ success: true, results: [], meta: { changes: 0 } }]));
      });
    }
    if (request.url === '/api/auth/desktop/login') {
      let raw = '';
      request.on('data', chunk => { raw += chunk; });
      return request.on('end', () => {
        const body = JSON.parse(raw);
        assert.equal(recovered, true);
        assert.equal(body.email, 'isarpsiyah@gmail.com');
        assert.equal(body.password, '123456');
        response.end(apiSuccess({
          admin: { id: 'existing-owner', name: 'İbrahim', email: 'isarpsiyah@gmail.com', role: 'owner' },
          accessToken: 'a'.repeat(64),
          refreshToken: 'r'.repeat(64)
        }));
      });
    }
    if (request.url === '/api/auth/desktop/logout') return response.end(apiSuccess({ loggedOut: true }));
    response.statusCode = 404;
    response.end('{}');
  }, async baseUrl => {
    const result = await runBootstrap(baseUrl);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.body.ok, true);
    assert.equal(result.body.admin.email, 'isarpsiyah@gmail.com');
  });

  assert.deepEqual(revoked, { admin: true, desktop: true, device: true });
  assert.equal(recovered, true);
  assert.equal(auditWritten, true);
}

test('an owner left by a failed setup is recovered and the entered administrator can log in', async () => {
  await runOwnerRecoveryScenario({ lastLoginAt: null });
});

test('a previously claimed single owner can be explicitly recovered with the validated Cloudflare token', async () => {
  await runOwnerRecoveryScenario({ lastLoginAt: '2026-08-05T10:00:00.000Z' });
});
