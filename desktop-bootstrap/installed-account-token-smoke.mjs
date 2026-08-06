import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const [installedNode, installedBootstrap, evidencePath] = process.argv.slice(2);
if (!installedNode || !installedBootstrap || !evidencePath) {
  throw new Error('Usage: node installed-account-token-smoke.mjs <installed-node> <installed-bootstrap> <evidence-json>');
}
for (const required of [installedNode, installedBootstrap]) {
  if (!fs.statSync(required).isFile()) throw new Error(`Installed runtime file missing: ${required}`);
}

const ACCOUNT_ID = 'ad8e99c82c6c17d823f6877ff1efade4';
const D1_ID = '81983219-f57b-487b-8144-7c70bf9b1fe2';
const ACCOUNT_TOKEN = `cfat_${'a'.repeat(44)}`;
const requested = [];
const fullAdminColumns = ['id', 'name', 'email', 'password_hash', 'role', 'status', 'failed_login_count', 'locked_until', 'last_login_at', 'created_at', 'updated_at', 'deleted_at'];
const salt = Buffer.alloc(16, 9);
const staleHash = crypto.pbkdf2Sync('old-password', salt, 310000, 32, 'sha256');
let owner = {
  id: 'stale-owner',
  name: 'Yarım Kurulum',
  email: 'stale-owner@example.com',
  password_hash: `pbkdf2-sha256$310000$${salt.toString('base64')}$${staleHash.toString('base64')}`,
  last_login_at: null,
  created_at: '2026-08-01T00:00:00.000Z'
};
const recovery = {
  adminSessionsRevoked: false,
  desktopSessionsRevoked: false,
  devicesRevoked: false,
  loginThrottleCleared: false,
  ownerUpdated: false,
  auditWritten: false
};

function cloudflareSuccess(result) {
  return JSON.stringify({ success: true, errors: [], messages: [], result });
}

function d1Success(results = [], changes = 0) {
  return cloudflareSuccess([{ success: true, results, meta: { changes } }]);
}

function workerSuccess(data) {
  return JSON.stringify({ ok: true, data });
}

const server = http.createServer((request, response) => {
  requested.push(`${request.method} ${request.url}`);
  response.setHeader('Content-Type', 'application/json');

  if (request.url === `/accounts/${ACCOUNT_ID}/tokens/verify`) {
    response.end(cloudflareSuccess({ status: 'active', id: 'installed-account-token' }));
    return;
  }
  if (request.url === `/accounts/${ACCOUNT_ID}/d1/database/${D1_ID}`) {
    response.end(cloudflareSuccess({ uuid: D1_ID, name: 'wa-ai-prod' }));
    return;
  }
  if (request.url === '/health') {
    response.end(JSON.stringify({ ok: true, components: { worker: true, d1: true } }));
    return;
  }
  if (request.url === `/accounts/${ACCOUNT_ID}/d1/database/${D1_ID}/query`) {
    let raw = '';
    request.on('data', chunk => { raw += chunk; });
    request.on('end', () => {
      const body = JSON.parse(raw);
      const sql = String(body.sql).replace(/\s+/g, ' ').trim();
      if (sql === 'PRAGMA table_info(admins)') {
        response.end(d1Success(fullAdminColumns.map(name => ({ name }))));
        return;
      }
      if (sql.startsWith('PRAGMA table_info(')) {
        response.end(d1Success([]));
        return;
      }
      if (sql.startsWith('CREATE TABLE IF NOT EXISTS') || sql.startsWith('CREATE INDEX IF NOT EXISTS') || sql.startsWith('ALTER TABLE ')) {
        response.end(d1Success());
        return;
      }
      if (sql.startsWith('SELECT id,name,email,password_hash,last_login_at,created_at FROM admins')) {
        response.end(d1Success([owner]));
        return;
      }
      if (sql.startsWith('SELECT id,status,deleted_at FROM admins WHERE email=?')) {
        response.end(d1Success([]));
        return;
      }
      if (sql.startsWith('UPDATE admin_sessions SET revoked_at=?')) {
        recovery.adminSessionsRevoked = true;
        response.end(d1Success([], 1));
        return;
      }
      if (sql.startsWith('UPDATE desktop_sessions SET revoked_at=?')) {
        recovery.desktopSessionsRevoked = true;
        response.end(d1Success([], 1));
        return;
      }
      if (sql.startsWith("UPDATE desktop_devices SET status='revoked'")) {
        recovery.devicesRevoked = true;
        response.end(d1Success([], 1));
        return;
      }
      if (sql.startsWith('DELETE FROM login_attempts WHERE email_hash IN')) {
        recovery.loginThrottleCleared = true;
        response.end(d1Success([], 2));
        return;
      }
      if (sql.startsWith('UPDATE admins SET name=?')) {
        assert.equal(body.params[0], 'İbrahim');
        assert.equal(body.params[1], 'isarpsiyah@gmail.com');
        assert.match(body.params[2], /^pbkdf2-sha256\$310000\$/);
        owner = { ...owner, name: body.params[0], email: body.params[1], password_hash: body.params[2], last_login_at: null };
        recovery.ownerUpdated = true;
        response.end(d1Success([], 1));
        return;
      }
      if (sql.startsWith('INSERT INTO audit_logs')) {
        recovery.auditWritten = true;
        response.end(d1Success([], 1));
        return;
      }
      if (sql.startsWith("SELECT COUNT(*) AS total FROM admins WHERE role='owner'")) {
        response.end(d1Success([{ total: 1 }]));
        return;
      }
      response.end(d1Success());
    });
    return;
  }
  if (request.url === '/api/auth/desktop/login') {
    let raw = '';
    request.on('data', chunk => { raw += chunk; });
    request.on('end', () => {
      const body = JSON.parse(raw);
      assert.equal(recovery.ownerUpdated, true);
      assert.equal(body.email, 'isarpsiyah@gmail.com');
      assert.equal(body.password, '123456');
      response.end(workerSuccess({
        admin: { id: owner.id, name: owner.name, email: owner.email, role: 'owner' },
        accessToken: 'a'.repeat(64),
        refreshToken: 'r'.repeat(64)
      }));
    });
    return;
  }
  if (request.url === '/api/auth/desktop/logout') {
    response.end(workerSuccess({ loggedOut: true }));
    return;
  }

  response.statusCode = 404;
  response.end(JSON.stringify({ success: false, errors: [{ code: 404, message: `Unexpected route: ${request.url}` }] }));
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});

try {
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const payload = JSON.stringify({
    action: 'setup',
    accountId: ACCOUNT_ID,
    apiToken: ACCOUNT_TOKEN,
    adminName: 'İbrahim',
    adminEmail: 'isarpsiyah@gmail.com',
    adminPassword: '123456'
  });

  const result = await new Promise((resolve, reject) => {
    const child = spawn(installedNode, [installedBootstrap], {
      cwd: path.dirname(installedBootstrap),
      env: {
        ...process.env,
        WPAI_BOOTSTRAP_TEST_MODE: '1',
        WPAI_CLOUDFLARE_API_BASE: baseUrl,
        WPAI_WORKER_URL: baseUrl
      },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(payload);
  });

  assert.equal(result.code, 0, `Installed bootstrap failed: ${result.stderr}\n${result.stdout}`);
  assert.doesNotMatch(result.stderr, /EISDIR|lstat/);
  const line = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
  assert.ok(line, `Installed bootstrap produced no JSON: ${result.stderr}`);
  const body = JSON.parse(line);
  assert.equal(body.ok, true);
  assert.equal(body.mode, 'connect_existing');
  assert.equal(body.report.tokenType, 'account');
  assert.equal(body.admin.email, 'isarpsiyah@gmail.com');
  assert.deepEqual(recovery, {
    adminSessionsRevoked: true,
    desktopSessionsRevoked: true,
    devicesRevoked: true,
    loginThrottleCleared: true,
    ownerUpdated: true,
    auditWritten: true
  });
  assert.equal(requested.includes(`GET /accounts/${ACCOUNT_ID}/tokens/verify`), true);
  assert.equal(requested.includes('GET /user/tokens/verify'), false);

  fs.writeFileSync(evidencePath, JSON.stringify({
    checkedAt: new Date().toISOString(),
    installedNode,
    installedBootstrap,
    processExitCode: result.code,
    jsonParsed: true,
    tokenType: body.report.tokenType,
    staleOwnerRecovered: true,
    recovery,
    accountTokenEndpointUsed: true,
    userTokenEndpointNotUsed: true,
    eisdirAbsent: !/EISDIR|lstat/.test(result.stderr),
    requested
  }, null, 2));
} finally {
  await new Promise(resolve => server.close(resolve));
}
