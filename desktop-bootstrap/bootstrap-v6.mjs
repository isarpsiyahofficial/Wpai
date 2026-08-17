import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ACCOUNT_ID = 'ad8e99c82c6c17d823f6877ff1efade4';
const D1_ID = '81983219-f57b-487b-8144-7c70bf9b1fe2';
const WORKER_URL = (process.env.WPAI_WORKER_URL || 'https://wa-ai-panel.wa-ai-panel.workers.dev').replace(/\/$/, '');
const TEST_MODE = process.env.WPAI_BOOTSTRAP_TEST_MODE === '1';
const API_BASE = TEST_MODE && process.env.WPAI_CLOUDFLARE_API_BASE
  ? process.env.WPAI_CLOUDFLARE_API_BASE.replace(/\/$/, '')
  : 'https://api.cloudflare.com/client/v4';
const REQUEST_TIMEOUT_MS = Math.max(1_000, Number(process.env.WPAI_BOOTSTRAP_TIMEOUT_MS || 45_000));
const VERSION = 'device-bootstrap-v6';
const LEGACY_ENGINE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'bootstrap.mjs');

function emit(body, code = 0) {
  process.stdout.write(`${JSON.stringify(body)}\n`);
  process.exitCode = code;
}

function safeMessage(error) {
  if (error instanceof Error && error.message) return error.message;
  return String(error ?? 'Bilinmeyen hata');
}

function queryError(body, status) {
  const item = body?.errors?.[0];
  return `${item?.code ?? status}: ${item?.message ?? `HTTP ${status}`}`;
}

async function fetchJson(url, init, stage) {
  let response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (error) {
    const message = safeMessage(error);
    if (/timeout|aborted/i.test(message)) {
      throw new Error(`${stage} zaman aşımına uğradı [${VERSION}].`);
    }
    throw new Error(`${stage} sırasında ağ hatası oluştu [${VERSION}]. ${message}`);
  }
  const text = (await response.text()).slice(0, 500_000);
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* handled below */ }
  if (!response.ok || body?.success === false) {
    throw new Error(`${stage} başarısız [${VERSION}]. ${queryError(body, response.status)}`);
  }
  return body;
}

async function verifyToken(token) {
  if (token.startsWith('cfk_')) throw new Error('Global API Key desteklenmiyor. User API Token veya Account API Token kullanın.');
  const candidates = token.startsWith('cfat_')
    ? [`/accounts/${ACCOUNT_ID}/tokens/verify`]
    : token.startsWith('cfut_')
      ? ['/user/tokens/verify']
      : ['/user/tokens/verify', `/accounts/${ACCOUNT_ID}/tokens/verify`];
  const failures = [];
  for (const route of candidates) {
    try {
      const body = await fetchJson(`${API_BASE}${route}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
      }, 'Cloudflare token doğrulaması');
      if (body?.result?.status === 'active') return route.includes('/accounts/') ? 'account' : 'user';
      failures.push(`durum=${body?.result?.status ?? 'bilinmiyor'}`);
    } catch (error) {
      failures.push(safeMessage(error));
    }
  }
  throw new Error(`Cloudflare API tokeni doğrulanamadı [${VERSION}]. ${failures.join(' | ')}`);
}

async function verifyD1(token) {
  const body = await fetchJson(`${API_BASE}/accounts/${ACCOUNT_ID}/d1/database/${D1_ID}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
  }, 'Production D1 erişimi');
  if (!body?.result?.uuid) throw new Error(`Production D1 bulunamadı [${VERSION}].`);
}

async function verifyWorker() {
  let response;
  try {
    response = await fetch(`${WORKER_URL}/health`, { cache: 'no-store', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (error) {
    const message = safeMessage(error);
    if (/timeout|aborted/i.test(message)) throw new Error(`WPAI Worker sağlık kontrolü zaman aşımına uğradı [${VERSION}].`);
    throw new Error(`WPAI Worker'a ulaşılamadı [${VERSION}]. ${message}`);
  }
  if (!response.ok) throw new Error(`WPAI Worker sağlık kontrolü başarısız [${VERSION}]. HTTP ${response.status}`);
  const type = response.headers.get('content-type') || '';
  if (!type.includes('application/json')) throw new Error(`WPAI Worker sağlık cevabı geçersiz [${VERSION}].`);
  const body = await response.json();
  if (body?.ok !== true) throw new Error(`WPAI Worker sağlıklı değil [${VERSION}].`);
}

async function d1Query(token, sql, params = [], stage = 'D1 sorgusu') {
  const body = await fetchJson(`${API_BASE}/accounts/${ACCOUNT_ID}/d1/database/${D1_ID}/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql, params })
  }, stage);
  return Array.isArray(body?.result) ? body.result : [];
}

function rows(result) {
  return Array.isArray(result?.[0]?.results) ? result[0].results : [];
}

async function tableColumns(token, table) {
  const result = await d1Query(token, `PRAGMA table_info(${table})`, [], `${table} şema kontrolü`);
  return new Set(rows(result).map(row => String(row.name)));
}

async function ensureTable(token, table, createSql, definitions) {
  let columns = await tableColumns(token, table);
  if (columns.size === 0) {
    await d1Query(token, createSql, [], `${table} tablosunu oluşturma`);
    columns = await tableColumns(token, table);
  }
  for (const [name, definition] of definitions) {
    if (columns.has(name)) continue;
    try {
      await d1Query(token, `ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`, [], `${table}.${name} sütununu ekleme`);
      columns.add(name);
    } catch (error) {
      if (!/duplicate column name/i.test(safeMessage(error))) throw error;
    }
  }
  return columns;
}

function randomToken(bytes = 64) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('base64');
}

function randomPasswordHash() {
  const password = randomToken(48);
  const salt = crypto.randomBytes(16);
  const hash = crypto.pbkdf2Sync(password, salt, 310000, 32, 'sha256');
  return `pbkdf2-sha256$310000$${salt.toString('base64')}$${hash.toString('base64')}`;
}

async function ensureAuthSchema(token) {
  await ensureTable(token, 'admins', `CREATE TABLE IF NOT EXISTS admins (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL COLLATE NOCASE UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'owner',
    status TEXT NOT NULL DEFAULT 'active',
    failed_login_count INTEGER NOT NULL DEFAULT 0,
    locked_until TEXT,
    last_login_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  )`, [
    ['id', 'TEXT'],
    ['name', "TEXT NOT NULL DEFAULT 'WPAI'"],
    ['email', "TEXT NOT NULL DEFAULT 'owner@wpai.local'"],
    ['password_hash', "TEXT NOT NULL DEFAULT 'disabled'"],
    ['role', "TEXT NOT NULL DEFAULT 'owner'"],
    ['status', "TEXT NOT NULL DEFAULT 'active'"],
    ['failed_login_count', 'INTEGER NOT NULL DEFAULT 0'],
    ['locked_until', 'TEXT'],
    ['last_login_at', 'TEXT'],
    ['created_at', "TEXT NOT NULL DEFAULT ''"],
    ['updated_at', "TEXT NOT NULL DEFAULT ''"],
    ['deleted_at', 'TEXT']
  ]);

  await ensureTable(token, 'admin_sessions', `CREATE TABLE IF NOT EXISTS admin_sessions (
    id TEXT PRIMARY KEY,
    admin_id TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    csrf_token TEXT NOT NULL,
    user_agent_hash TEXT,
    ip_hash TEXT,
    expires_at TEXT NOT NULL,
    revoked_at TEXT,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
  )`, [
    ['id', 'TEXT'], ['admin_id', 'TEXT'], ['token_hash', 'TEXT'], ['csrf_token', 'TEXT'],
    ['user_agent_hash', 'TEXT'], ['ip_hash', 'TEXT'], ['expires_at', 'TEXT'], ['revoked_at', 'TEXT'],
    ['created_at', "TEXT NOT NULL DEFAULT ''"], ['last_seen_at', "TEXT NOT NULL DEFAULT ''"]
  ]);

  await ensureTable(token, 'desktop_devices', `CREATE TABLE IF NOT EXISTS desktop_devices (
    id TEXT PRIMARY KEY,
    admin_id TEXT NOT NULL,
    device_hash TEXT NOT NULL,
    display_name TEXT NOT NULL,
    platform TEXT NOT NULL DEFAULT 'windows',
    app_version TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    last_seen_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    revoked_at TEXT
  )`, [
    ['id', 'TEXT'], ['admin_id', 'TEXT'], ['device_hash', 'TEXT'], ['display_name', 'TEXT'],
    ['platform', "TEXT NOT NULL DEFAULT 'windows'"], ['app_version', 'TEXT'], ['status', "TEXT NOT NULL DEFAULT 'active'"],
    ['last_seen_at', "TEXT NOT NULL DEFAULT ''"], ['created_at', "TEXT NOT NULL DEFAULT ''"], ['revoked_at', 'TEXT']
  ]);

  await ensureTable(token, 'desktop_sessions', `CREATE TABLE IF NOT EXISTS desktop_sessions (
    id TEXT PRIMARY KEY,
    admin_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    admin_session_id TEXT,
    refresh_token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    last_rotated_at TEXT NOT NULL,
    revoked_at TEXT,
    created_at TEXT NOT NULL
  )`, [
    ['id', 'TEXT'], ['admin_id', 'TEXT'], ['device_id', 'TEXT'], ['admin_session_id', 'TEXT'],
    ['refresh_token_hash', 'TEXT'], ['expires_at', 'TEXT'], ['last_rotated_at', "TEXT NOT NULL DEFAULT ''"],
    ['revoked_at', 'TEXT'], ['created_at', "TEXT NOT NULL DEFAULT ''"]
  ]);

  await ensureTable(token, 'audit_logs', `CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    actor_admin_id TEXT,
    action TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT,
    summary_json TEXT NOT NULL DEFAULT '{}',
    request_id TEXT,
    created_at TEXT NOT NULL
  )`, [
    ['id', 'TEXT'], ['actor_admin_id', 'TEXT'], ['action', 'TEXT'], ['target_type', 'TEXT'],
    ['target_id', 'TEXT'], ['summary_json', "TEXT NOT NULL DEFAULT '{}'"], ['request_id', 'TEXT'],
    ['created_at', "TEXT NOT NULL DEFAULT ''"]
  ]);
}

async function ensureOwner(token) {
  const result = await d1Query(token, `SELECT rowid AS _rowid,id,name,email,password_hash,role,status,created_at
FROM admins
WHERE deleted_at IS NULL
ORDER BY CASE WHEN role='owner' AND status='active' THEN 0 ELSE 1 END, created_at ASC, rowid ASC
LIMIT 20`, [], 'Yönetici kaydını okuma');
  const all = rows(result);
  const owner = all.find(row => row.role === 'owner' && row.status === 'active') ?? all[0] ?? null;
  const now = new Date().toISOString();

  if (!owner) {
    const id = crypto.randomUUID();
    const email = `wpai-${id.slice(0, 12)}@local.invalid`;
    await d1Query(token, `INSERT INTO admins
      (id,name,email,password_hash,role,status,failed_login_count,created_at,updated_at,deleted_at)
      VALUES (?,?,?,?,'owner','active',0,?,?,NULL)`,
      [id, 'WPAI', email, randomPasswordHash(), now, now], 'Yerel yönetici kimliğini oluşturma');
    return { id, name: 'WPAI', email, role: 'owner', created: true };
  }

  const id = typeof owner.id === 'string' && owner.id.trim() ? owner.id : crypto.randomUUID();
  const name = typeof owner.name === 'string' && owner.name.trim() ? owner.name.trim() : 'WPAI';
  const email = typeof owner.email === 'string' && owner.email.includes('@')
    ? owner.email.toLowerCase()
    : `wpai-${id.slice(0, 12)}@local.invalid`;
  const passwordHash = typeof owner.password_hash === 'string' && owner.password_hash.startsWith('pbkdf2-sha256$')
    ? owner.password_hash
    : randomPasswordHash();
  await d1Query(token, `UPDATE admins SET
    id=?,name=?,email=?,password_hash=?,role='owner',status='active',failed_login_count=0,locked_until=NULL,
    created_at=CASE WHEN created_at IS NULL OR created_at='' THEN ? ELSE created_at END,
    updated_at=?,deleted_at=NULL
    WHERE rowid=?`, [id, name, email, passwordHash, now, now, owner._rowid], 'Yönetici kaydını normalleştirme');
  return { id, name, email, role: 'owner', created: false, multipleAdminsDetected: all.length > 1 };
}

async function issueDeviceSession(token, owner, input) {
  const deviceHash = sha256(input.deviceId);
  const now = new Date().toISOString();
  const refreshExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const existing = rows(await d1Query(token,
    'SELECT id FROM desktop_devices WHERE admin_id=? AND device_hash=? LIMIT 1',
    [owner.id, deviceHash], 'Cihaz kaydını okuma'))[0];
  const deviceRecordId = existing?.id || crypto.randomUUID();
  if (existing?.id) {
    await d1Query(token, `UPDATE desktop_devices SET display_name=?,platform=?,app_version=?,status='active',last_seen_at=?,revoked_at=NULL WHERE id=?`,
      [input.deviceName, input.platform, input.appVersion ?? null, now, deviceRecordId], 'Cihaz kaydını güncelleme');
  } else {
    await d1Query(token, `INSERT INTO desktop_devices
      (id,admin_id,device_hash,display_name,platform,app_version,status,last_seen_at,created_at,revoked_at)
      VALUES (?,?,?,?,?,?,'active',?,?,NULL)`,
      [deviceRecordId, owner.id, deviceHash, input.deviceName, input.platform, input.appVersion ?? null, now, now], 'Cihaz kaydını oluşturma');
  }

  await d1Query(token,
    `UPDATE admin_sessions SET revoked_at=?
      WHERE id IN (SELECT admin_session_id FROM desktop_sessions WHERE device_id=? AND admin_session_id IS NOT NULL AND revoked_at IS NULL)
        AND revoked_at IS NULL`, [now, deviceRecordId], 'Eski erişim oturumlarını kapatma');
  await d1Query(token, 'UPDATE desktop_sessions SET revoked_at=? WHERE device_id=? AND revoked_at IS NULL',
    [now, deviceRecordId], 'Eski cihaz oturumlarını kapatma');

  const refreshToken = randomToken(64);
  await d1Query(token, `INSERT INTO desktop_sessions
    (id,admin_id,device_id,admin_session_id,refresh_token_hash,expires_at,last_rotated_at,revoked_at,created_at)
    VALUES (?,?,?,?,?,?,?,NULL,?)`,
    [crypto.randomUUID(), owner.id, deviceRecordId, null, sha256(refreshToken), refreshExpiresAt, now, now], 'Yeni cihaz oturumunu oluşturma');

  return { refreshToken, refreshExpiresAt, deviceId: deviceRecordId };
}

function validSetup(input) {
  return input?.action === 'setup'
    && input.accountId === ACCOUNT_ID
    && typeof input.apiToken === 'string' && input.apiToken.length >= 30 && input.apiToken.length <= 4096 && !/\s/.test(input.apiToken)
    && typeof input.deviceId === 'string' && input.deviceId.length >= 20 && input.deviceId.length <= 500
    && typeof input.deviceName === 'string' && input.deviceName.trim().length >= 2 && input.deviceName.length <= 160
    && typeof input.platform === 'string' && input.platform.length >= 3 && input.platform.length <= 40;
}

function runLegacy(raw) {
  if (!fs.existsSync(LEGACY_ENGINE)) {
    emit({ ok: false, error: `Cloudflare yardımcı motoru bulunamadı [${VERSION}].` }, 1);
    return;
  }
  const result = spawnSync(process.execPath, [LEGACY_ENGINE], {
    input: raw, encoding: 'utf8', env: process.env, windowsHide: true,
    timeout: 30 * 60_000, maxBuffer: 10 * 1024 * 1024
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.status ?? 1;
}

const raw = fs.readFileSync(0, 'utf8');
let input = null;
try { input = JSON.parse(raw || '{}'); } catch { input = null; }

if (input?.action !== 'setup') {
  runLegacy(raw);
} else if (!validSetup(input)) {
  emit({ ok: false, error: `Cloudflare bağlantı isteği geçersiz [${VERSION}].` }, 1);
} else {
  try {
    const tokenType = await verifyToken(input.apiToken);
    await verifyD1(input.apiToken);
    await verifyWorker();
    await ensureAuthSchema(input.apiToken);
    const owner = await ensureOwner(input.apiToken);
    const session = await issueDeviceSession(input.apiToken, owner, input);
    emit({
      ok: true,
      mode: 'device_session',
      version: VERSION,
      admin: { id: owner.id, name: owner.name, email: owner.email, role: owner.role },
      session,
      report: {
        tokenType,
        accountId: ACCOUNT_ID,
        d1Id: D1_ID,
        workerHealthy: true,
        passwordPromptRequired: false,
        emailPromptRequired: false,
        multipleAdminsDetected: owner.multipleAdminsDetected === true
      }
    }, 0);
  } catch (error) {
    emit({ ok: false, error: safeMessage(error) }, 1);
  }
}
