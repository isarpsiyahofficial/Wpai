import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const [installedNode, installedBootstrap, evidencePath] = process.argv.slice(2);
if (!installedNode || !installedBootstrap || !evidencePath) {
  throw new Error('Usage: node installed-account-token-smoke.mjs <installed-node> <installed-bootstrap-v6> <evidence-json>');
}
for (const required of [installedNode, installedBootstrap]) {
  if (!fs.statSync(required).isFile()) throw new Error(`Installed runtime file missing: ${required}`);
}
assert.equal(path.basename(installedBootstrap).toLowerCase(), 'bootstrap-v6.mjs');

const ACCOUNT_ID = 'ad8e99c82c6c17d823f6877ff1efade4';
const D1_ID = '81983219-f57b-487b-8144-7c70bf9b1fe2';
const ACCOUNT_TOKEN = `cfat_${'a'.repeat(44)}`;
const RAW_DEVICE_ID = `device-${'x'.repeat(48)}`;
const requested = [];
const tables = {
  admins: ['id','name','email','password_hash','role','status','failed_login_count','locked_until','last_login_at','created_at','updated_at','deleted_at'],
  admin_sessions: ['id','admin_id','token_hash','csrf_token','user_agent_hash','ip_hash','expires_at','revoked_at','created_at','last_seen_at'],
  desktop_devices: ['id','admin_id','device_hash','display_name','platform','app_version','status','last_seen_at','created_at','revoked_at'],
  desktop_sessions: ['id','admin_id','device_id','admin_session_id','refresh_token_hash','expires_at','last_rotated_at','revoked_at','created_at']
};
const salt = Buffer.alloc(16, 9);
const staleHash = crypto.pbkdf2Sync('old-password', salt, 310000, 32, 'sha256');
let owner = {
  _rowid: 1,
  id: 'stale-owner',
  name: 'Eski Yönetici',
  email: 'stale-owner@example.com',
  password_hash: `pbkdf2-sha256$310000$${salt.toString('base64')}$${staleHash.toString('base64')}`,
  role: 'owner',
  status: 'active',
  created_at: '2026-08-01T00:00:00.000Z'
};
let device = null;
let storedRefreshHash = null;

function cloudflareSuccess(result) {
  return JSON.stringify({ success: true, errors: [], messages: [], result });
}
function d1Success(results = [], changes = 0) {
  return cloudflareSuccess([{ success: true, results, meta: { changes } }]);
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
      const body = JSON.parse(raw || '{}');
      const sql = String(body.sql).replace(/\s+/g, ' ').trim();
      const pragma = sql.match(/^PRAGMA table_info\((\w+)\)$/);
      if (pragma) return response.end(d1Success((tables[pragma[1]] ?? []).map(name => ({ name }))));
      if (sql.startsWith('CREATE TABLE IF NOT EXISTS') || sql.startsWith('ALTER TABLE ')) return response.end(d1Success());
      if (sql.startsWith('SELECT rowid AS _rowid,id,name,email,password_hash,role,status,created_at FROM admins')) {
        return response.end(d1Success([owner]));
      }
      if (sql.startsWith('UPDATE admins SET id=?,name=?,email=?,password_hash=?')) {
        owner = { ...owner, id: body.params[0], name: body.params[1], email: body.params[2], password_hash: body.params[3], role: 'owner', status: 'active' };
        return response.end(d1Success([], 1));
      }
      if (sql.startsWith('SELECT id FROM desktop_devices')) {
        return response.end(d1Success(device ? [{ id: device.id }] : []));
      }
      if (sql.startsWith('INSERT INTO desktop_devices')) {
        device = { id: body.params[0], admin_id: body.params[1], device_hash: body.params[2] };
        return response.end(d1Success([], 1));
      }
      if (sql.startsWith('UPDATE desktop_devices')) return response.end(d1Success([], 1));
      if (sql.startsWith('UPDATE admin_sessions SET revoked_at=?')) return response.end(d1Success([], 0));
      if (sql.startsWith('UPDATE desktop_sessions SET revoked_at=?')) return response.end(d1Success([], 0));
      if (sql.startsWith('INSERT INTO desktop_sessions')) {
        storedRefreshHash = body.params[4];
        return response.end(d1Success([], 1));
      }
      response.statusCode = 400;
      response.end(JSON.stringify({ success: false, errors: [{ code: 7500, message: `Unexpected SQL: ${sql}` }] }));
    });
    return;
  }

  response.statusCode = 404;
  response.end('{}');
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
    deviceId: RAW_DEVICE_ID,
    deviceName: 'WPAI Windows',
    platform: 'windows',
    appVersion: '1.3.6'
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

  assert.equal(result.code, 0, `Installed Device Bootstrap V6 failed: ${result.stderr}\n${result.stdout}`);
  assert.doesNotMatch(result.stderr, /EISDIR|lstat/);
  const line = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
  assert.ok(line, `Installed Device Bootstrap V6 produced no JSON: ${result.stderr}`);
  const body = JSON.parse(line);
  assert.equal(body.ok, true);
  assert.equal(body.mode, 'device_session');
  assert.equal(body.version, 'device-bootstrap-v6');
  assert.equal(body.report.tokenType, 'account');
  assert.equal(body.report.emailPromptRequired, false);
  assert.equal(body.report.passwordPromptRequired, false);
  assert.ok(body.session?.refreshToken);
  assert.equal(
    storedRefreshHash,
    crypto.createHash('sha256').update(body.session.refreshToken, 'utf8').digest('base64'),
    'refresh token hash must match Worker sha256 format'
  );
  assert.equal(requested.includes(`GET /accounts/${ACCOUNT_ID}/tokens/verify`), true);
  assert.equal(requested.includes('GET /user/tokens/verify'), false);
  assert.equal(requested.some(value => value.includes('/api/auth/desktop/login')), false);

  fs.writeFileSync(evidencePath, JSON.stringify({
    checkedAt: new Date().toISOString(),
    installedNode,
    installedBootstrap,
    processExitCode: result.code,
    jsonParsed: true,
    bootstrapVersion: body.version,
    tokenType: body.report.tokenType,
    passwordPromptRequired: body.report.passwordPromptRequired,
    emailPromptRequired: body.report.emailPromptRequired,
    deviceSessionCreated: Boolean(body.session?.refreshToken),
    refreshHashCompatibleWithWorker: true,
    accountTokenEndpointUsed: true,
    userTokenEndpointNotUsed: true,
    desktopLoginEndpointNotUsed: true,
    eisdirAbsent: !/EISDIR|lstat/.test(result.stderr),
    requested
  }, null, 2));
} finally {
  await new Promise(resolve => server.close(resolve));
}
