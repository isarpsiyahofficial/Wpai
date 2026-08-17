import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ACCOUNT_ID = 'ad8e99c82c6c17d823f6877ff1efade4';
const D1_ID = '81983219-f57b-487b-8144-7c70bf9b1fe2';
const RECOVERY_VERSION = 'admin-recovery-v4';
const TEST_MODE = process.env.WPAI_BOOTSTRAP_TEST_MODE === '1';
const API_BASE = TEST_MODE && process.env.WPAI_CLOUDFLARE_API_BASE
  ? process.env.WPAI_CLOUDFLARE_API_BASE.replace(/\/$/, '')
  : 'https://api.cloudflare.com/client/v4';
const CORE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'bootstrap-core.mjs');

function queryError(body, status) {
  const item = body?.errors?.[0];
  return `${item?.code ?? status}: ${item?.message ?? `HTTP ${status}`}`;
}

async function cloudflareJson(token, route, label) {
  let response;
  try {
    response = await fetch(`${API_BASE}${route}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(30_000)
    });
  } catch (error) {
    throw new Error(`${label} Cloudflare'a ulaşılamadığı için tamamlanamadı: ${error instanceof Error ? error.message : String(error)}`);
  }
  const text = (await response.text()).slice(0, 500_000);
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!response.ok || !body?.success) throw new Error(`${label} başarısız: ${queryError(body, response.status)}`);
  return body.result;
}

async function verifyToken(token) {
  if (token.startsWith('cfk_')) {
    throw new Error('Global API Key desteklenmiyor. Cloudflare User API Token veya Account API Token kullanın.');
  }
  const routes = token.startsWith('cfat_')
    ? [{ route: `/accounts/${ACCOUNT_ID}/tokens/verify`, label: 'Account API Token doğrulaması' }]
    : token.startsWith('cfut_')
      ? [{ route: '/user/tokens/verify', label: 'User API Token doğrulaması' }]
      : [
          { route: '/user/tokens/verify', label: 'User API Token doğrulaması' },
          { route: `/accounts/${ACCOUNT_ID}/tokens/verify`, label: 'Account API Token doğrulaması' }
        ];
  const failures = [];
  for (const candidate of routes) {
    try {
      const result = await cloudflareJson(token, candidate.route, candidate.label);
      if (result?.status === 'active') return result;
      failures.push(`${candidate.label}: token durumu ${result?.status ?? 'bilinmiyor'}`);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  throw new Error(`Cloudflare API tokeni doğrulanamadı. User API Token ve Account API Token desteklenir. ${failures.join(' | ')}`);
}

async function d1Query(token, sql, params = []) {
  const response = await fetch(`${API_BASE}/accounts/${ACCOUNT_ID}/d1/database/${D1_ID}/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql, params }),
    signal: AbortSignal.timeout(30_000)
  });
  const text = (await response.text()).slice(0, 500_000);
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!response.ok || !body?.success) throw new Error(queryError(body, response.status));
  return Array.isArray(body.result) ? body.result : [];
}

function resultRows(entries) {
  return Array.isArray(entries?.[0]?.results) ? entries[0].results : [];
}

function validSetupInput(input) {
  return input?.action === 'setup'
    && typeof input.apiToken === 'string'
    && input.apiToken.length >= 30
    && input.apiToken.length <= 4096
    && !/\s/.test(input.apiToken);
}

async function tableColumns(token, table) {
  return new Set(resultRows(await d1Query(token, `PRAGMA table_info(${table})`)).map(row => String(row.name)));
}

async function ensureColumns(token, table, definitions) {
  const columns = await tableColumns(token, table);
  const added = [];
  for (const [name, definition] of definitions) {
    if (columns.has(name)) continue;
    try {
      await d1Query(token, `ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
      columns.add(name);
      added.push(name);
    } catch (error) {
      if (!String(error).toLowerCase().includes('duplicate column name')) throw error;
    }
  }
  return added;
}

async function normalizeAdminRows(token) {
  const rows = resultRows(await d1Query(token, 'SELECT rowid AS _rowid,id,created_at,updated_at FROM admins'));
  const now = new Date().toISOString();
  for (const row of rows) {
    const id = typeof row.id === 'string' && row.id.trim() ? row.id : crypto.randomUUID();
    const createdAt = typeof row.created_at === 'string' && row.created_at.trim() ? row.created_at : now;
    const updatedAt = typeof row.updated_at === 'string' && row.updated_at.trim() ? row.updated_at : createdAt;
    await d1Query(token,
      'UPDATE admins SET id=?,created_at=?,updated_at=? WHERE rowid=?',
      [id, createdAt, updatedAt, row._rowid]);
  }
}

async function ensureAuthenticationSchema(input) {
  if (!validSetupInput(input)) return { adminColumnsAdded: [] };
  const token = input.apiToken;

  await d1Query(token, `CREATE TABLE IF NOT EXISTS admins (
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
  )`);
  const adminColumnsAdded = await ensureColumns(token, 'admins', [
    ['id', 'TEXT'],
    ['name', 'TEXT'],
    ['email', 'TEXT'],
    ['password_hash', 'TEXT'],
    ['role', "TEXT NOT NULL DEFAULT 'owner'"],
    ['status', "TEXT NOT NULL DEFAULT 'active'"],
    ['failed_login_count', 'INTEGER NOT NULL DEFAULT 0'],
    ['locked_until', 'TEXT'],
    ['last_login_at', 'TEXT'],
    ['created_at', "TEXT NOT NULL DEFAULT ''"],
    ['updated_at', "TEXT NOT NULL DEFAULT ''"],
    ['deleted_at', 'TEXT']
  ]);
  await normalizeAdminRows(token);

  await d1Query(token, `CREATE TABLE IF NOT EXISTS admin_sessions (
    id TEXT PRIMARY KEY,
    admin_id TEXT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    csrf_token TEXT NOT NULL,
    user_agent_hash TEXT,
    ip_hash TEXT,
    expires_at TEXT NOT NULL,
    revoked_at TEXT,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
  )`);
  await ensureColumns(token, 'admin_sessions', [
    ['id', 'TEXT'], ['admin_id', 'TEXT'], ['token_hash', 'TEXT'], ['csrf_token', 'TEXT'],
    ['user_agent_hash', 'TEXT'], ['ip_hash', 'TEXT'], ['expires_at', 'TEXT'],
    ['revoked_at', 'TEXT'], ['created_at', "TEXT NOT NULL DEFAULT ''"],
    ['last_seen_at', "TEXT NOT NULL DEFAULT ''"]
  ]);

  await d1Query(token, `CREATE TABLE IF NOT EXISTS login_attempts (
    id TEXT PRIMARY KEY,
    email_hash TEXT NOT NULL,
    ip_hash TEXT NOT NULL,
    success INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  )`);
  await ensureColumns(token, 'login_attempts', [
    ['id', 'TEXT'], ['email_hash', 'TEXT'], ['ip_hash', 'TEXT'],
    ['success', 'INTEGER NOT NULL DEFAULT 0'], ['created_at', "TEXT NOT NULL DEFAULT ''"]
  ]);

  await d1Query(token, `CREATE TABLE IF NOT EXISTS desktop_devices (
    id TEXT PRIMARY KEY,
    admin_id TEXT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
    device_hash TEXT NOT NULL,
    display_name TEXT NOT NULL,
    platform TEXT NOT NULL DEFAULT 'windows',
    app_version TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    last_seen_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    revoked_at TEXT,
    UNIQUE(admin_id, device_hash)
  )`);
  await ensureColumns(token, 'desktop_devices', [
    ['id', 'TEXT'], ['admin_id', 'TEXT'], ['device_hash', 'TEXT'], ['display_name', 'TEXT'],
    ['platform', "TEXT NOT NULL DEFAULT 'windows'"], ['app_version', 'TEXT'],
    ['status', "TEXT NOT NULL DEFAULT 'active'"], ['last_seen_at', "TEXT NOT NULL DEFAULT ''"],
    ['created_at', "TEXT NOT NULL DEFAULT ''"], ['revoked_at', 'TEXT']
  ]);

  await d1Query(token, `CREATE TABLE IF NOT EXISTS desktop_sessions (
    id TEXT PRIMARY KEY,
    admin_id TEXT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL REFERENCES desktop_devices(id) ON DELETE CASCADE,
    admin_session_id TEXT REFERENCES admin_sessions(id) ON DELETE SET NULL,
    refresh_token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    last_rotated_at TEXT NOT NULL,
    revoked_at TEXT,
    created_at TEXT NOT NULL
  )`);
  await ensureColumns(token, 'desktop_sessions', [
    ['id', 'TEXT'], ['admin_id', 'TEXT'], ['device_id', 'TEXT'], ['admin_session_id', 'TEXT'],
    ['refresh_token_hash', 'TEXT'], ['expires_at', 'TEXT'],
    ['last_rotated_at', "TEXT NOT NULL DEFAULT ''"], ['revoked_at', 'TEXT'],
    ['created_at', "TEXT NOT NULL DEFAULT ''"]
  ]);

  await d1Query(token, `CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    actor_admin_id TEXT REFERENCES admins(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT,
    summary_json TEXT NOT NULL DEFAULT '{}',
    request_id TEXT,
    created_at TEXT NOT NULL
  )`);
  await ensureColumns(token, 'audit_logs', [
    ['id', 'TEXT'], ['actor_admin_id', 'TEXT'], ['action', 'TEXT'], ['target_type', 'TEXT'],
    ['target_id', 'TEXT'], ['summary_json', "TEXT NOT NULL DEFAULT '{}'"],
    ['request_id', 'TEXT'], ['created_at', "TEXT NOT NULL DEFAULT ''"]
  ]);

  await d1Query(token, 'CREATE INDEX IF NOT EXISTS idx_admin_sessions_admin ON admin_sessions(admin_id, expires_at)');
  await d1Query(token, 'CREATE INDEX IF NOT EXISTS idx_desktop_sessions_admin ON desktop_sessions(admin_id, expires_at) WHERE revoked_at IS NULL');
  await d1Query(token, 'CREATE INDEX IF NOT EXISTS idx_login_attempts_lookup ON login_attempts(email_hash, ip_hash, created_at)');
  return { adminColumnsAdded };
}

function encodedPasswordHash(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.pbkdf2Sync(password, salt, 310000, 32, 'sha256');
  return `pbkdf2-sha256$310000$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifiesEncodedPassword(password, encoded) {
  try {
    const [algorithm, iterationText, saltText, hashText] = String(encoded).split('$');
    const iterations = Number(iterationText);
    if (algorithm !== 'pbkdf2-sha256' || !Number.isInteger(iterations) || iterations < 100000 || iterations > 2000000) return false;
    const salt = Buffer.from(saltText, 'base64');
    const expected = Buffer.from(hashText, 'base64');
    if (!salt.length || !expected.length) return false;
    const actual = crypto.pbkdf2Sync(password, salt, iterations, expected.length, 'sha256');
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function emailHash(email) {
  return crypto.createHash('sha256').update(String(email).toLowerCase(), 'utf8').digest('base64');
}

async function recoverExistingOwner(input, schemaResult) {
  if (!validSetupInput(input)) return { recovered: false, reason: 'not-setup' };
  const token = input.apiToken;
  const name = typeof input.adminName === 'string' ? input.adminName.trim() : '';
  const email = typeof input.adminEmail === 'string' ? input.adminEmail.trim().toLowerCase() : '';
  const password = input.adminPassword;
  if (name.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || typeof password !== 'string' || password.length < 6) {
    throw new Error(`Yönetici formu geçersiz [${RECOVERY_VERSION}].`);
  }

  const owners = resultRows(await d1Query(token, `
SELECT rowid AS _rowid,id,name,email,password_hash,last_login_at,created_at
FROM admins
WHERE role='owner' AND status='active' AND deleted_at IS NULL
ORDER BY created_at ASC,rowid ASC
LIMIT 2
`));
  if (owners.length === 0) return { recovered: false, reason: 'no-owner' };
  if (owners.length > 1) throw new Error(`Birden fazla aktif yönetici bulundu [${RECOVERY_VERSION}]. Otomatik değişiklik yapılmadı.`);

  const owner = owners[0];
  if (String(owner.email ?? '').toLowerCase() === email && verifiesEncodedPassword(password, owner.password_hash)) {
    return { recovered: false, reason: 'credentials-valid' };
  }

  const repairedCriticalColumn = (schemaResult?.adminColumnsAdded ?? []).some(column =>
    ['id', 'name', 'email', 'password_hash', 'role', 'status', 'created_at'].includes(column));
  const incompleteOwner = !owner?.id || !owner?.name || !owner?.email || !owner?.password_hash;
  if (!repairedCriticalColumn && !incompleteOwner) {
    return { recovered: false, reason: 'existing-owner' };
  }

  const conflict = resultRows(await d1Query(token,
    'SELECT rowid AS _rowid FROM admins WHERE email=? AND rowid<>? AND deleted_at IS NULL LIMIT 1',
    [email, owner._rowid]));
  if (conflict.length) throw new Error(`Girilen e-posta başka bir yönetici kaydında kullanılıyor [${RECOVERY_VERSION}].`);

  const now = new Date().toISOString();
  const ownerId = typeof owner.id === 'string' && owner.id.trim() ? owner.id : crypto.randomUUID();
  await d1Query(token, 'UPDATE admin_sessions SET revoked_at=? WHERE admin_id=? AND revoked_at IS NULL', [now, ownerId]);
  await d1Query(token, 'UPDATE desktop_sessions SET revoked_at=? WHERE admin_id=? AND revoked_at IS NULL', [now, ownerId]);
  await d1Query(token,
    "UPDATE desktop_devices SET status='revoked',revoked_at=?,last_seen_at=? WHERE admin_id=? AND revoked_at IS NULL",
    [now, now, ownerId]);
  await d1Query(token, 'DELETE FROM login_attempts WHERE email_hash IN (?,?)', [emailHash(owner.email ?? ''), emailHash(email)]);

  const updated = await d1Query(token, `
UPDATE admins SET
  id=?,name=?,email=?,password_hash=?,role='owner',status='active',
  failed_login_count=0,locked_until=NULL,last_login_at=NULL,
  created_at=CASE WHEN created_at IS NULL OR created_at='' THEN ? ELSE created_at END,
  updated_at=?,deleted_at=NULL
WHERE rowid=?
`, [ownerId, name, email, encodedPasswordHash(password), now, now, owner._rowid]);
  if (Number(updated[0]?.meta?.changes ?? 0) !== 1) {
    throw new Error(`Yönetici kaydı güncellenemedi [${RECOVERY_VERSION}].`);
  }

  await d1Query(token, `
INSERT INTO audit_logs
  (id,actor_admin_id,action,target_type,target_id,summary_json,request_id,created_at)
VALUES
  (?,?, 'admin.cloudflare_owner_recovered','admin',?,?,'desktop-bootstrap-v4',?)
`, [crypto.randomUUID(), ownerId, ownerId, JSON.stringify({
    previousEmail: owner.email ?? null,
    recoveredEmail: email,
    repairedColumns: schemaResult?.adminColumnsAdded ?? []
  }), now]).catch(() => undefined);
  return { recovered: true, ownerId };
}

const raw = fs.readFileSync(0, 'utf8');
let input = null;
try { input = JSON.parse(raw || '{}'); } catch { input = null; }

try {
  if (validSetupInput(input)) await verifyToken(input.apiToken);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`);
  process.exit(1);
}

try {
  const schemaResult = await ensureAuthenticationSchema(input);
  await recoverExistingOwner(input, schemaResult);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const permissionFailure = /10000|authentication|unauthorized|forbidden|permission/i.test(message);
  const detail = message.includes(`[${RECOVERY_VERSION}]`)
    ? message
    : permissionFailure
      ? `Cloudflare tokeni doğrulandı ancak production D1 sorgusu yetkilendirilemedi. Token izinlerinde D1 Read ve D1 Write bulunmalıdır. ${message}`
      : `Cloudflare tokeni doğrulandı ancak WPAI veritabanı hazırlanamadı [${RECOVERY_VERSION}]. Bu bir API izni uyarısı değildir; production D1 şeması onarılamadı. ${message}`;
  process.stdout.write(`${JSON.stringify({ ok: false, error: detail })}\n`);
  process.exit(1);
}

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
  process.stdout.write(`${JSON.stringify({ ok: false, error: `Cloudflare bağlantı motoru başlatılamadı [${RECOVERY_VERSION}].` })}\n`);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
