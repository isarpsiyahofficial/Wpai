import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
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

function cloudflareSuccess(result) {
  return JSON.stringify({ success: true, errors: [], messages: [], result });
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
      const results = body.sql.includes('COUNT(*)') ? [{ total: 0 }] : [];
      response.end(cloudflareSuccess([{ success: true, results, meta: { changes: body.sql.includes('INSERT INTO admins') ? 1 : 0 } }]));
    });
    return;
  }
  if (request.url === '/api/auth/desktop/login') {
    response.end(workerSuccess({
      admin: { id: 'admin-1', name: 'İbrahim', email: 'isarpsiyah@gmail.com', role: 'owner' },
      accessToken: 'a'.repeat(64),
      refreshToken: 'r'.repeat(64)
    }));
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
  assert.equal(requested.includes(`GET /accounts/${ACCOUNT_ID}/tokens/verify`), true);
  assert.equal(requested.includes('GET /user/tokens/verify'), false);

  fs.writeFileSync(evidencePath, JSON.stringify({
    checkedAt: new Date().toISOString(),
    installedNode,
    installedBootstrap,
    processExitCode: result.code,
    jsonParsed: true,
    tokenType: body.report.tokenType,
    accountTokenEndpointUsed: true,
    userTokenEndpointNotUsed: true,
    eisdirAbsent: !/EISDIR|lstat/.test(result.stderr),
    requested
  }, null, 2));
} finally {
  await new Promise(resolve => server.close(resolve));
}
