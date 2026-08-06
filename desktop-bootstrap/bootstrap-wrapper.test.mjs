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

function passwordHash(password) {
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
      adminEmail: 'allinagunes@gmail.com',
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

function readJson(request, callback) {
  let raw = '';
  request.on('data', chunk => { raw += chunk; });
  request.on('end', () => callback(JSON.parse(raw || '{}')));
}

test('an admins table missing name is repaired and the entered owner can log in', async () => {
  const columns = new Set(['id', 'email', 'password_hash', 'created_at']);
  const added = [];
  let owner = {
    _rowid: 1,
    id: 'legacy-owner',
    name: null,
    email: 'legacy@example.com',
    password_hash: passwordHash('old-password'),
    last_login_at: null,
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: null
  };
  const evidence = {
    ownerUpdated: false,
    adminSessionsRevoked: false,
    desktopSessionsRevoked: false,
    devicesRevoked: false,
    throttleCleared: false
  };

  await withServer((request, response) => {
    if (commonRoute(request, response)) return;
    response.setHeader('Content-Type', 'application/json');

    if (request.url === `/accounts/${ACCOUNT_ID}/d1/database/${D1_ID}/query`) {
      return readJson(request, body => {
        const sql = String(body.sql).replace(/\s+/g, ' ').trim();
        if (sql === 'PRAGMA table_info(admins)') {
          return response.end(d1Success([...columns].map(name => ({ name }))));
        }
        const adminAlter = sql.match(/^ALTER TABLE admins ADD COLUMN (\w+) /);
        if (adminAlter) {
          columns.add(adminAlter[1]);
          added.push(adminAlter[1]);
          return response.end(d1Success([], 1));
        }
        if (sql === 'SELECT rowid AS _rowid,id,created_at,updated_at FROM admins') {
          return response.end(d1Success([owner]));
        }
        if (sql.startsWith('UPDATE admins SET id=?,created_at=?,updated_at=? WHERE rowid=?')) {
          owner = { ...owner, id: body.params[0], created_at: body.params[1], updated_at: body.params[2] };
          return response.end(d1Success([], 1));
        }
        if (sql.startsWith('CREATE TABLE IF NOT EXISTS') || sql.startsWith('CREATE INDEX IF NOT EXISTS')) {
          return response.end(d1Success());
        }
        if (sql.startsWith('PRAGMA table_info(')) return response.end(d1Success([]));
        if (sql.startsWith('ALTER TABLE ')) return response.end(d1Success([], 1));
        if (sql.startsWith('SELECT rowid AS _rowid,id,name,email,password_hash,last_login_at,created_at FROM admins')) {
          return response.end(d1Success([owner]));
        }
        if (sql.startsWith('SELECT rowid AS _rowid FROM admins WHERE email=?')) return response.end(d1Success([]));
        if (sql.startsWith('UPDATE admin_sessions SET revoked_at=?')) {
          evidence.adminSessionsRevoked = true;
          return response.end(d1Success([], 1));
        }
        if (sql.startsWith('UPDATE desktop_sessions SET revoked_at=?')) {
          evidence.desktopSessionsRevoked = true;
          return response.end(d1Success([], 1));
        }
        if (sql.startsWith("UPDATE desktop_devices SET status='revoked'")) {
          evidence.devicesRevoked = true;
          return response.end(d1Success([], 1));
        }
        if (sql.startsWith('DELETE FROM login_attempts WHERE email_hash IN')) {
          evidence.throttleCleared = true;
          return response.end(d1Success([], 2));
        }
        if (sql.startsWith('UPDATE admins SET id=?,name=?,email=?,password_hash=?')) {
          owner = {
            ...owner,
            id: body.params[0],
            name: body.params[1],
            email: body.params[2],
            password_hash: body.params[3],
            last_login_at: null
          };
          evidence.ownerUpdated = true;
          return response.end(d1Success([], 1));
        }
        if (sql.startsWith('INSERT INTO audit_logs')) return response.end(d1Success([], 1));
        if (sql.startsWith("SELECT COUNT(*) AS total FROM admins WHERE role='owner'")) {
          return response.end(d1Success([{ total: 1 }]));
        }
        return response.end(d1Success());
      });
    }

    if (request.url === '/api/auth/desktop/login') {
      return readJson(request, body => {
        assert.equal(evidence.ownerUpdated, true);
        assert.equal(body.email, 'allinagunes@gmail.com');
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
    assert.equal(result.body.admin.email, 'allinagunes@gmail.com');
  });

  assert.equal(added.includes('name'), true);
  assert.equal(added.includes('role'), true);
  assert.deepEqual(evidence, {
    ownerUpdated: true,
    adminSessionsRevoked: true,
    desktopSessionsRevoked: true,
    devicesRevoked: true,
    throttleCleared: true
  });
});

test('a clean database with no owner continues to the normal first-owner setup', async () => {
  const fullColumns = ['id', 'name', 'email', 'password_hash', 'role', 'status', 'failed_login_count', 'locked_until', 'last_login_at', 'created_at', 'updated_at', 'deleted_at'];

  await withServer((request, response) => {
    if (commonRoute(request, response)) return;
    response.setHeader('Content-Type', 'application/json');
    if (request.url === `/accounts/${ACCOUNT_ID}/d1/database/${D1_ID}/query`) {
      return readJson(request, body => {
        const sql = String(body.sql).replace(/\s+/g, ' ').trim();
        if (sql === 'PRAGMA table_info(admins)') return response.end(d1Success(fullColumns.map(name => ({ name }))));
        if (sql === 'SELECT rowid AS _rowid,id,created_at,updated_at FROM admins') return response.end(d1Success([]));
        if (sql.startsWith('CREATE TABLE IF NOT EXISTS') || sql.startsWith('CREATE INDEX IF NOT EXISTS')) return response.end(d1Success());
        if (sql.startsWith('PRAGMA table_info(')) return response.end(d1Success([]));
        if (sql.startsWith('ALTER TABLE ')) return response.end(d1Success([], 1));
        if (sql.startsWith('SELECT rowid AS _rowid,id,name,email,password_hash,last_login_at,created_at FROM admins')) return response.end(d1Success([]));
        if (sql.startsWith("SELECT COUNT(*) AS total FROM admins WHERE role='owner'")) return response.end(d1Success([{ total: 0 }]));
        if (sql.startsWith('INSERT INTO admins')) return response.end(d1Success([], 1));
        return response.end(d1Success());
      });
    }
    if (request.url === '/api/auth/desktop/login') return response.end(apiSuccess({
      admin: { id: 'new-owner', name: 'İbrahim', email: 'allinagunes@gmail.com', role: 'owner' },
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
});

test('multiple active owners are never overwritten automatically', async () => {
  const fullColumns = ['id', 'name', 'email', 'password_hash', 'role', 'status', 'failed_login_count', 'locked_until', 'last_login_at', 'created_at', 'updated_at', 'deleted_at'];
  const owners = [
    { _rowid: 1, id: 'owner-1', name: 'Bir', email: 'one@example.com', password_hash: passwordHash('one-pass'), last_login_at: null, created_at: '2026-08-01' },
    { _rowid: 2, id: 'owner-2', name: 'İki', email: 'two@example.com', password_hash: passwordHash('two-pass'), last_login_at: null, created_at: '2026-08-02' }
  ];
  let updated = false;

  await withServer((request, response) => {
    if (commonRoute(request, response)) return;
    response.setHeader('Content-Type', 'application/json');
    if (request.url === `/accounts/${ACCOUNT_ID}/d1/database/${D1_ID}/query`) {
      return readJson(request, body => {
        const sql = String(body.sql).replace(/\s+/g, ' ').trim();
        if (sql === 'PRAGMA table_info(admins)') return response.end(d1Success(fullColumns.map(name => ({ name }))));
        if (sql === 'SELECT rowid AS _rowid,id,created_at,updated_at FROM admins') return response.end(d1Success(owners));
        if (sql.startsWith('UPDATE admins SET id=?,created_at=?,updated_at=? WHERE rowid=?')) return response.end(d1Success([], 1));
        if (sql.startsWith('CREATE TABLE IF NOT EXISTS') || sql.startsWith('CREATE INDEX IF NOT EXISTS')) return response.end(d1Success());
        if (sql.startsWith('PRAGMA table_info(')) return response.end(d1Success([]));
        if (sql.startsWith('ALTER TABLE ')) return response.end(d1Success([], 1));
        if (sql.startsWith('SELECT rowid AS _rowid,id,name,email,password_hash,last_login_at,created_at FROM admins')) return response.end(d1Success(owners));
        if (sql.startsWith('UPDATE admins SET id=?,name=?')) updated = true;
        return response.end(d1Success());
      });
    }
    response.statusCode = 404;
    response.end('{}');
  }, async baseUrl => {
    const result = await runBootstrap(baseUrl);
    assert.equal(result.code, 1);
    assert.equal(result.body.ok, false);
    assert.match(result.body.error, /Birden fazla aktif yönetici/);
    assert.match(result.body.error, /admin-recovery-v4/);
    assert.equal(updated, false);
  });
});
