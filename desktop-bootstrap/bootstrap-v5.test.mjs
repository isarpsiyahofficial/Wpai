import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'bootstrap-v5.mjs');
const ACCOUNT_ID = 'ad8e99c82c6c17d823f6877ff1efade4';
const D1_ID = '81983219-f57b-487b-8144-7c70bf9b1fe2';
const TOKEN = 't'.repeat(48);

function cf(result) { return JSON.stringify({ success: true, errors: [], messages: [], result }); }
function d1(results = [], changes = 0) { return cf([{ success: true, results, meta: { changes } }]); }
function api(data) { return JSON.stringify({ ok: true, data }); }

function oldHash() {
  const salt = Buffer.alloc(16, 3);
  const hash = crypto.pbkdf2Sync('old-password', salt, 310000, 32, 'sha256');
  return `pbkdf2-sha256$310000$${salt.toString('base64')}$${hash.toString('base64')}`;
}

async function withServer(handler, action) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try { return await action(`http://127.0.0.1:${address.port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

function run(baseUrl) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT], {
      cwd: path.dirname(HERE),
      env: { ...process.env, WPAI_BOOTSTRAP_TEST_MODE: '1', WPAI_CLOUDFLARE_API_BASE: baseUrl, WPAI_WORKER_URL: baseUrl },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', x => { stdout += x; }); child.stderr.on('data', x => { stderr += x; });
    child.once('error', reject);
    child.once('close', code => {
      const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
      resolve({ code, body: line ? JSON.parse(line) : null, stderr });
    });
    child.stdin.end(JSON.stringify({
      action: 'setup', accountId: ACCOUNT_ID, apiToken: TOKEN,
      adminName: 'İbrahim', adminEmail: 'bestcreative1507@gmail.com', adminPassword: '123456'
    }));
  });
}

test('a complete but unusable sole owner is explicitly reclaimed after Cloudflare token validation', async () => {
  const columns = ['id','name','email','password_hash','role','status','failed_login_count','locked_until','last_login_at','created_at','updated_at','deleted_at'];
  let owner = { _rowid: 1, id: 'owner-1', name: 'Eski', email: 'ghost@example.com', password_hash: oldHash(), last_login_at: '2026-08-01T00:00:00Z', created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z' };
  let reclaimed = false;
  let loginCount = 0;

  await withServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/user/tokens/verify') return response.end(cf({ status: 'active' }));
    if (request.url === `/accounts/${ACCOUNT_ID}/d1/database/${D1_ID}`) return response.end(cf({ uuid: D1_ID, name: 'wa-ai-prod' }));
    if (request.url === '/health') return response.end(JSON.stringify({ ok: true, components: { worker: true, d1: true } }));
    if (request.url === `/accounts/${ACCOUNT_ID}/d1/database/${D1_ID}/query`) {
      let raw=''; request.on('data', c => { raw += c; });
      return request.on('end', () => {
        const body=JSON.parse(raw); const sql=String(body.sql).replace(/\s+/g,' ').trim();
        if (sql === 'PRAGMA table_info(admins)') return response.end(d1(columns.map(name => ({ name }))));
        if (sql === 'SELECT rowid AS _rowid,id,created_at,updated_at FROM admins') return response.end(d1([owner]));
        if (sql.startsWith('UPDATE admins SET id=?,created_at=?,updated_at=? WHERE rowid=?')) return response.end(d1([],1));
        if (sql.startsWith('CREATE TABLE IF NOT EXISTS') || sql.startsWith('CREATE INDEX IF NOT EXISTS')) return response.end(d1());
        if (sql.startsWith('PRAGMA table_info(')) return response.end(d1([]));
        if (sql.startsWith('ALTER TABLE ')) return response.end(d1([],1));
        if (sql.startsWith('SELECT rowid AS _rowid,id,name,email,password_hash,last_login_at,created_at FROM admins')) return response.end(d1([owner]));
        if (sql.startsWith("SELECT COUNT(*) AS total FROM admins WHERE role='owner'")) return response.end(d1([{ total: 1 }]));
        if (sql.startsWith('SELECT rowid AS _rowid,id,name,email FROM admins')) return response.end(d1([owner]));
        if (sql.startsWith('SELECT rowid AS _rowid FROM admins WHERE lower(email)=lower(?)')) return response.end(d1([]));
        if (sql.startsWith('UPDATE admin_sessions SET revoked_at=?') || sql.startsWith('UPDATE desktop_sessions SET revoked_at=?') || sql.startsWith("UPDATE desktop_devices SET status='revoked'") || sql.startsWith('DELETE FROM login_attempts')) return response.end(d1([],1));
        if (sql.startsWith('UPDATE admins SET id=?,name=?,email=?,password_hash=?')) {
          owner = { ...owner, id: body.params[0], name: body.params[1], email: body.params[2], password_hash: body.params[3], last_login_at: null };
          reclaimed = true; return response.end(d1([],1));
        }
        if (sql.startsWith('INSERT INTO audit_logs')) return response.end(d1([],1));
        return response.end(d1());
      });
    }
    if (request.url === '/api/auth/desktop/login') {
      loginCount += 1;
      let raw=''; request.on('data', c => { raw += c; });
      return request.on('end', () => {
        const body=JSON.parse(raw);
        if (!reclaimed) { response.statusCode=401; return response.end(JSON.stringify({ ok:false, error:{ code:'LOGIN_FAILED', message:'E-posta veya parola hatalı.' } })); }
        assert.equal(body.email, 'bestcreative1507@gmail.com');
        assert.equal(body.password, '123456');
        response.end(api({ admin:{ id:owner.id,name:owner.name,email:owner.email,role:'owner' }, accessToken:'a'.repeat(64), refreshToken:'r'.repeat(64) }));
      });
    }
    if (request.url === '/api/auth/desktop/logout') return response.end(api({ loggedOut:true }));
    response.statusCode=404; response.end('{}');
  }, async baseUrl => {
    const result = await run(baseUrl);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.body.ok, true);
    assert.equal(result.body.admin.email, 'bestcreative1507@gmail.com');
    assert.equal(result.body.recovery.version, 'owner-reclaim-v5');
    assert.equal(result.body.recovery.ownerReclaimed, true);
    assert.equal(reclaimed, true);
    assert.ok(loginCount >= 2);
  });
});
