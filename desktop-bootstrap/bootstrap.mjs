import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ACCOUNT_ID = 'ad8e99c82c6c17d823f6877ff1efade4';
const D1_ID = '81983219-f57b-487b-8144-7c70bf9b1fe2';
const TEST_MODE = process.env.WPAI_BOOTSTRAP_TEST_MODE === '1';
const API_BASE = TEST_MODE && process.env.WPAI_CLOUDFLARE_API_BASE
  ? process.env.WPAI_CLOUDFLARE_API_BASE.replace(/\/$/, '')
  : 'https://api.cloudflare.com/client/v4';
const CORE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'bootstrap-core.mjs');

function queryError(body, status) {
  const item = body?.errors?.[0];
  return `${item?.code ?? status}: ${item?.message ?? `HTTP ${status}`}`;
}

async function d1Query(token, sql) {
  const response = await fetch(`${API_BASE}/accounts/${ACCOUNT_ID}/d1/database/${D1_ID}/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql, params: [] }),
    signal: AbortSignal.timeout(30_000)
  });
  const text = (await response.text()).slice(0, 500_000);
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!response.ok || !body?.success) throw new Error(queryError(body, response.status));
  return body.result;
}

async function repairLegacyAdminSchema(input) {
  if (input?.action !== 'setup') return;
  const token = input?.apiToken;
  if (typeof token !== 'string' || token.length < 30 || token.length > 4096 || /\s/.test(token)) return;
  try {
    await d1Query(token, 'SELECT deleted_at FROM admins LIMIT 0');
    return;
  } catch (error) {
    if (!String(error).toLowerCase().includes('no such column: deleted_at')) return;
  }
  try {
    await d1Query(token, 'ALTER TABLE admins ADD COLUMN deleted_at TEXT');
  } catch (error) {
    if (!String(error).toLowerCase().includes('duplicate column name: deleted_at')) return;
  }
  await d1Query(token, 'SELECT deleted_at FROM admins LIMIT 0').catch(() => undefined);
}

const raw = fs.readFileSync(0, 'utf8');
let input = null;
try { input = JSON.parse(raw || '{}'); } catch { input = null; }
await repairLegacyAdminSchema(input).catch(() => undefined);

const result = spawnSync(process.execPath, [CORE], {
  input: raw,
  encoding: 'utf8',
  env: process.env,
  windowsHide: true,
  timeout: 30 * 60_000,
  maxBuffer: 10 * 1024 * 1024
});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: 'Cloudflare bağlantı motoru başlatılamadı.' })}\n`);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
