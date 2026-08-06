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

function d1Success(results = [], changes = 0) {
  return cfSuccess([{ success: true, results, meta: { changes } }]);
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

function runBootstrap(baseUrl, input = {}) {
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
      adminPassword: '123456',
      ...input
    }));
  });
}

function commonRoute(request, response) {
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

function readJsonRequest(request, callback) {
  let raw = '';
  request.on('data', chunk => { raw += chunk; });
  request.on('end', () => callback(JSON.parse(raw || '{}')));
}

test('legacy authentication schema is repaired before the first administrator login', async () => {
  const adminColumns = new Set(['id', 'name', 'email', 'password_hash', 'created_at']);
  const addedColumns = [];
  const createdTables = new Set();

  await withServer((request, response) => {
    if (commonRoute(request, response)) return;
    response.setHeader('Content-Type', 'application/json');
    if (request.url === `/accounts/${ACCOUNT_ID}/d1/database/${D1_ID}/query`) {
      return readJsonRequest(request, body => {
        const sql = String(body.sql).replace(/\s+/g, ' ').trim();
        if (sql === 'PRAGMA table_info(admins)') {
          return response.end(d1Success([...adminColumns].map(name => ({ name }))));
        }
        const alter = sql.match(/^ALTER TABLE admins ADD COLUMN (\w+) /);
        if (alter) {
          adminColumns.add(alter[1]);
          addedColumns.push(alter[1]);
          return response.end(d1Success([], 1));
        }
        const create = sql.match(/^CREATE TABLE IF NOT EXISTS (\w+)/);
        if (create) {
          createdTables.add(create[1]);
          return response.end(d1Success());
        }
        if (sql.startsWith('PRAGMA table_info(')) return response.end(d1Success([]));
        if (sql.startsWith('ALTER TABLE ')) return response.end(d1Success([], 1));
        if (sql.startsWith('CREATE INDEX IF NOT EXISTS')) return response.end(d1Success());
        if (sql.startsWith('SELECT id,name,email,password_hash,last_login_at,created_at FROM admins')) return response.end(d1Success([]));
        if (sql.startsWith("SELECT COUNT(*) AS total FROM admins WHERE role='owner'")) return response.end(d1Success([{ total: 0 }]));
        if (sql.startsWith('INSERT INTO admins')) return response.end(d1Success([], 1));
        return response.end(d1Success());
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
  });

  assert.equal(adminColumns.has('deleted_at'), true);
  assert.equal(adminColumns.has('failed_login_count'), true);
  assert.equal(addedColumns.includes('deleted_at'), true);
  assert.equal(createdTables.has('desktop_devices'), true);
  assert.equal(createdTables.has('desktop_sessions'), true);
  assert.equal(createdTables.has('login_attempts'), true);
});

async function runSingleOwnerRecovery(lastLoginAt) {
  const fullAdminColumns = ['id', 'name', 'email', 'password_hash', 'role', 'status', 'failed_login_count', 'locked_until', 'last_login_at', 'created_at', 'updated_at', 'deleted_at'];
  let owner = {
    id: 'existing-owner',
    name: 'Önceki Yönetici',
    email: 'old-owner@example.com',
    password_hash: encodedPasswordHash('old-password'),
    last_login_at: lastLoginAt,
    created_at: '2026-08-01T00:00:00.000Z'
  };
  const evidence = { adminRevoked: false, desktopRevoked: false, deviceRevoked: false, throttleCleared: false, updated: false, audit: false };

  await withServer((request, response) => {
    if (commonRoute(request, response)) return;
    response.setHeader('Content-Type', 'application/json');
    if (request.url === `/accounts/${ACCOUNT_ID}/d1/database/${D1_ID}/query`) {
      return readJsonRequest(request, body => {
        const sql = String(body.sql).replace(/\s+/g, ' ').trim();
        if (sql === 'PRAGMA table_info(admins)') return response.end(d1Success(fullAdminColumns.map(name => ({ name }))));
        if (sql.startsWith('PRAGMA table_info(')) return response.end(d1Success([]));
        if (sql.startsWith('CREATE TABLE IF NOT EXISTS') || sql.startsWith('CREATE INDEX IF NOT EXISTS') || sql.startsWith('ALTER TABLE ')) return response.end(d1Success());
        if (sql.startsWith('SELECT id,name,email,password_hash,last_login_at,created_at FROM admins')) return response.end(d1Success([owner]));
        if (sql.startsWith('SELECT id,status,deleted_at FROM admins WHERE email=?')) return response.end(d1Success([]));
        if (sql.startsWith('UPDATE admin_sessions SET revoked_at=?')) { evidence.adminRevoked = true; return response.end(d1Success([], 1)); }
        if (sql.startsWith('UPDATE desktop_sessions SET revoked_at=?')) { evidence.desktopRevoked = true; return response.end(d1Success([], 1)); }
        if (sql.startsWith("UPDATE desktop_devices SET status='revoked'")) { evidence.deviceRevoked = true; return response.end(d1Success([], 1)); }
        if (sql.startsWith('DELETE FROM login_attempts WHERE email_hash IN')) { evidence.throttleCleared = true; return response.end(d1Success([], 2)); }
        if (sql.startsWith('UPDATE admins SET name=?')) {
          assert.equal(body.params[0], 'İbrahim');
          assert.equal(body.params[1], 'isarpsiyah@gmail.com');
          assert.match(body.params[2], /^pbkdf2-sha256\$310000\$/);
          owner = { ...owner, name: body.params[0], email: body.params[1], password_hash: body.params[2], last_login_at: null };
          evidence.updated = true;
          return response.end(d1Success([], 1));
        }
        if (sql.startsWith('INSERT INTO audit_logs')) { evidence.audit = true; return response.end(d1Success([], 1)); }
        if (sql.startsWith("SELECT COUNT(*) AS total FROM admins WHERE role='owner'")) return response.end(d1Success([{ total: 1 }]));
        return response.end(d1Success());
      });
    }
    if (request.url === '/api/auth/desktop/login') {
      return readJsonRequest(request, body => {
        assert.equal(evidence.updated, true);
        assert.equal(body.email, 'isarpsiyah@gmail.com');
        assert.equal(body.password, '123456');
        response.end(apiSuccess({
          admin: { id: owner.id, name: owner.name, email: owner.email, role: 'owner' },
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

  assert.deepEqual(evidence, { adminRevoked: true, desktopRevoked: true, deviceRevoked: true, throttleCleared: true, updated: true, audit: true });
}

test('a stale single owner is recovered with the entered administrator details', async () => {
  await runSingleOwnerRecovery(null);
});

test('a previously used single owner is recovered and every old session is revoked', async () => {
  await runSingleOwnerRecovery('2026-08-05T10:00:00.000Z');
});

test('multiple active owners are never overwritten automatically', async () => {
  const fullAdminColumns = ['id', 'name', 'email', 'password_hash', 'role', 'status', 'failed_login_count', 'locked_until', 'last_login_at', 'created_at', 'updated_at', 'deleted_at'];
  let updated = false;
  const owners = [
    { id: 'owner-1', name: 'Bir', email: 'one@example.com', password_hash: encodedPasswordHash('one-pass'), last_login_at: null, created_at: '2026-08-01' },
    { id: 'owner-2', name: 'İki', email: 'two@example.com', password_hash: encodedPasswordHash('two-pass'), last_login_at: null, created_at: '2026-08-02' }
  ];

  await withServer((request, response) => {
    if (commonRoute(request, response)) return;
    response.setHeader('Content-Type', 'application/json');
    if (request.url === `/accounts/${ACCOUNT_ID}/d1/database/${D1_ID}/query`) {
      return readJsonRequest(request, body => {
        const sql = String(body.sql).replace(/\s+/g, ' ').trim();
        if (sql === 'PRAGMA table_info(admins)') return response.end(d1Success(fullAdminColumns.map(name => ({ name }))));
        if (sql.startsWith('PRAGMA table_info(')) return response.end(d1Success([]));
        if (sql.startsWith('CREATE TABLE IF NOT EXISTS') || sql.startsWith('CREATE INDEX IF NOT EXISTS') || sql.startsWith('ALTER TABLE ')) return response.end(d1Success());
        if (sql.startsWith('SELECT id,name,email,password_hash,last_login_at,created_at FROM admins')) return response.end(d1Success(owners));
        if (sql.startsWith('UPDATE admins SET name=?')) updated = true;
        if (sql.startsWith("SELECT COUNT(*) AS total FROM admins WHERE role='owner'")) return response.end(d1Success([{ total: 2 }]));
        return response.end(d1Success());
      });
    }
    if (request.url === '/api/auth/desktop/login') {
      response.statusCode = 401;
      return response.end(JSON.stringify({ ok: false, error: { code: 'LOGIN_FAILED', message: 'E-posta veya parola hatalı.' } }));
    }
    response.statusCode = 404;
    response.end('{}');
  }, async baseUrl => {
    const result = await runBootstrap(baseUrl);
    assert.equal(result.code, 1);
    assert.equal(result.body.ok, false);
    assert.match(result.body.error, /yönetici/i);
    assert.equal(updated, false);
  });
});
