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

function cfSuccess(result) {
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

test('legacy admins table without deleted_at is repaired before owner lookup', async () => {
  let repaired = false;
  let alterCount = 0;
  let wrapperProbeCount = 0;

  await withServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/user/tokens/verify') return response.end(cfSuccess({ status: 'active', id: 'token-id' }));
    if (request.url === `/accounts/${ACCOUNT_ID}/d1/database/${D1_ID}`) return response.end(cfSuccess({ uuid: D1_ID, name: 'wa-ai-prod' }));
    if (request.url === '/health') return response.end(JSON.stringify({ ok: true, components: { worker: true, d1: true } }));
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
