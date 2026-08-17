import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'bootstrap-v6.mjs');
const ACCOUNT_ID = 'ad8e99c82c6c17d823f6877ff1efade4';
const D1_ID = '81983219-f57b-487b-8144-7c70bf9b1fe2';
const TOKEN = `cfat_${'a'.repeat(44)}`;

const full = {
  admins: ['id','name','email','password_hash','role','status','failed_login_count','locked_until','last_login_at','created_at','updated_at','deleted_at'],
  admin_sessions: ['id','admin_id','token_hash','csrf_token','user_agent_hash','ip_hash','expires_at','revoked_at','created_at','last_seen_at'],
  desktop_devices: ['id','admin_id','device_hash','display_name','platform','app_version','status','last_seen_at','created_at','revoked_at'],
  desktop_sessions: ['id','admin_id','device_id','admin_session_id','refresh_token_hash','expires_at','last_rotated_at','revoked_at','created_at']
};

function cf(result) { return JSON.stringify({ success: true, errors: [], messages: [], result }); }
function d1(results = [], changes = 0) { return cf([{ success: true, results, meta: { changes } }]); }
function oldHash() {
  const salt = Buffer.alloc(16, 2);
  const hash = crypto.pbkdf2Sync('old', salt, 310000, 32, 'sha256');
  return `pbkdf2-sha256$310000$${salt.toString('base64')}$${hash.toString('base64')}`;
}

async function withServer(handler, action) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  try { return await action(`http://127.0.0.1:${address.port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

function run(base, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT], {
      env: { ...process.env, WPAI_BOOTSTRAP_TEST_MODE: '1', WPAI_CLOUDFLARE_API_BASE: base, WPAI_WORKER_URL: base, ...env },
      stdio: ['pipe','pipe','pipe']
    });
    let stdout=''; let stderr='';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', c => { stdout += c; }); child.stderr.on('data', c => { stderr += c; });
    child.once('error', reject);
    child.once('close', code => {
      const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
      resolve({ code, body: line ? JSON.parse(line) : null, stderr });
    });
    child.stdin.end(JSON.stringify({
      action:'setup', accountId:ACCOUNT_ID, apiToken:TOKEN,
      deviceId:`device-${'x'.repeat(48)}`, deviceName:'WPAI Linux Test', platform:'windows', appVersion:'1.3.6'
    }));
  });
}

function stateServer({ adminsColumns = full.admins, owner = null, delayAdminPragma = 0 } = {}) {
  const columns = {
    admins: new Set(adminsColumns),
    admin_sessions: new Set(full.admin_sessions),
    desktop_devices: new Set(full.desktop_devices),
    desktop_sessions: new Set(full.desktop_sessions)
  };
  const state = {
    owner: owner ?? { _rowid:1,id:'owner-1',name:'Eski Yönetici',email:'ghost@example.com',password_hash:oldHash(),role:'owner',status:'active',created_at:'2026-08-01T00:00:00Z' },
    device: null,
    desktopSession: null,
    added: []
  };

  const handler = (request, response) => {
    response.setHeader('Content-Type','application/json');
    if (request.url === `/accounts/${ACCOUNT_ID}/tokens/verify`) return response.end(cf({ status:'active' }));
    if (request.url === `/accounts/${ACCOUNT_ID}/d1/database/${D1_ID}`) return response.end(cf({ uuid:D1_ID, name:'wa-ai-prod' }));
    if (request.url === '/health') return response.end(JSON.stringify({ ok:true, components:{ worker:true,d1:true } }));
    if (request.url !== `/accounts/${ACCOUNT_ID}/d1/database/${D1_ID}/query`) { response.statusCode=404; return response.end('{}'); }
    let raw=''; request.on('data', c => { raw += c; });
    request.on('end', () => {
      const body=JSON.parse(raw||'{}');
      const sql=String(body.sql).replace(/\s+/g,' ').trim();
      const pragma = sql.match(/^PRAGMA table_info\((\w+)\)$/);
      if (pragma) {
        const send = () => response.end(d1([...(columns[pragma[1]] ?? new Set())].map(name => ({ name }))));
        if (pragma[1] === 'admins' && delayAdminPragma) return setTimeout(send, delayAdminPragma);
        return send();
      }
      const alter=sql.match(/^ALTER TABLE (\w+) ADD COLUMN (\w+) /);
      if (alter) {
        columns[alter[1]] ??= new Set(); columns[alter[1]].add(alter[2]); state.added.push(`${alter[1]}.${alter[2]}`);
        return response.end(d1([],1));
      }
      if (sql.startsWith('CREATE TABLE IF NOT EXISTS')) return response.end(d1());
      if (sql.startsWith('SELECT rowid AS _rowid,id,name,email,password_hash,role,status,created_at FROM admins')) {
        const visible = {};
        for (const key of ['_rowid','id','name','email','password_hash','role','status','created_at']) {
          if (key === '_rowid' || columns.admins.has(key)) visible[key] = state.owner?.[key] ?? null;
        }
        return response.end(d1(state.owner ? [visible] : []));
      }
      if (sql.startsWith('INSERT INTO admins')) {
        state.owner={ _rowid:1,id:body.params[0],name:body.params[1],email:body.params[2],password_hash:body.params[3],role:'owner',status:'active',created_at:body.params[4] };
        return response.end(d1([],1));
      }
      if (sql.startsWith('UPDATE admins SET id=?,name=?,email=?,password_hash=?')) {
        state.owner={ ...state.owner,id:body.params[0],name:body.params[1],email:body.params[2],password_hash:body.params[3],role:'owner',status:'active' };
        return response.end(d1([],1));
      }
      if (sql.startsWith('SELECT id FROM desktop_devices')) return response.end(d1(state.device ? [{id:state.device.id}] : []));
      if (sql.startsWith('INSERT INTO desktop_devices')) {
        state.device={ id:body.params[0],admin_id:body.params[1],device_hash:body.params[2] };
        return response.end(d1([],1));
      }
      if (sql.startsWith('UPDATE desktop_devices')) return response.end(d1([],1));
      if (sql.startsWith('UPDATE admin_sessions SET revoked_at=?')) return response.end(d1([],0));
      if (sql.startsWith('UPDATE desktop_sessions SET revoked_at=?')) return response.end(d1([],0));
      if (sql.startsWith('INSERT INTO desktop_sessions')) {
        state.desktopSession={ id:body.params[0], admin_id:body.params[1], device_id:body.params[2], refresh_token_hash:body.params[4] };
        return response.end(d1([],1));
      }
      response.statusCode=400;
      return response.end(JSON.stringify({ success:false, errors:[{code:7500,message:`unexpected sql: ${sql}`}] }));
    });
  };
  return { handler, state };
}

test('Linux scenario: setup never asks for email or password and issues a device refresh session', async () => {
  const fake=stateServer();
  await withServer(fake.handler, async base => {
    const result=await run(base);
    assert.equal(result.code,0,result.stderr);
    assert.equal(result.body.ok,true);
    assert.equal(result.body.version,'device-bootstrap-v6');
    assert.equal(result.body.report.emailPromptRequired,false);
    assert.equal(result.body.report.passwordPromptRequired,false);
    assert.ok(result.body.session.refreshToken.length > 60);
    assert.ok(fake.state.desktopSession?.refresh_token_hash);
    assert.equal(result.body.admin.id,'owner-1');
  });
});

test('Linux scenario: legacy admins table missing name/deleted_at is minimally repaired and connects', async () => {
  const fake=stateServer({ adminsColumns:['id','email','password_hash','created_at'] });
  await withServer(fake.handler, async base => {
    const result=await run(base);
    assert.equal(result.code,0,result.stderr);
    assert.equal(result.body.ok,true);
    assert.ok(fake.state.added.includes('admins.name'));
    assert.ok(fake.state.added.includes('admins.deleted_at'));
    assert.ok(fake.state.added.includes('admins.role'));
    assert.ok(fake.state.desktopSession);
  });
});

test('Linux scenario: a D1 timeout is reported as the exact schema stage, never as a fake permission error', async () => {
  const fake=stateServer({ delayAdminPragma:1500 });
  await withServer(fake.handler, async base => {
    const result=await run(base,{WPAI_BOOTSTRAP_TIMEOUT_MS:'1000'});
    assert.notEqual(result.code,0);
    assert.equal(result.body.ok,false);
    assert.match(result.body.error,/admins şema kontrolü zaman aşımına uğradı/);
    assert.doesNotMatch(result.body.error,/D1 Read|D1 Write|izin/i);
  });
});
