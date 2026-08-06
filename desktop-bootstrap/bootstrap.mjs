import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
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
  for (const [name, definition] of definitions) {
    if (columns.has(name)) continue;
    try {
      await d1Query(token, `ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
      columns.add(name);
    } catch (error) {
      if (!String(error).toLowerCase().includes('duplicate column name')) throw error;
    }
  }
}

async function ensureAuthenticationSchema(input) {
  if (!validSetupInput(input)) return;
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
  await ensureColumns(token, 'admins', [
    ['role', "TEXT NOT NULL DEFAULT 'owner'"],
    ['status', "TEXT NOT NULL DEFAULT 'active'"],
    ['failed_login_count', 'INTEGER NOT NULL DEFAULT 0'],
    ['locked_until', 'TEXT'],
    ['last_login_at', 'TEXT'],
    ['updated_at', "TEXT NOT NULL DEFAULT ''"],
    ['deleted_at', 'TEXT']
  ]);

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
  await ensureColumns(token, 'admin_sessions', [['revoked_at', 'TEXT']]);

  await d1Query(token, `CREATE TABLE IF NOT EXISTS login_attempts (
    id TEXT PRIMARY KEY,
    email_hash TEXT NOT NULL,
    ip_hash TEXT NOT NULL,
    success INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  )`);

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
    ['app_version', 'TEXT'],
    ['status', "TEXT NOT NULL DEFAULT 'active'"],
    ['revoked_at', 'TEXT']
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
    ['admin_session_id', 'TEXT'],
    ['last_rotated_at', "TEXT NOT NULL DEFAULT ''"],
    ['revoked_at', 'TEXT']
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
  await d1Query(token, 'CREATE INDEX IF NOT EXISTS idx_admin_sessions_admin ON admin_sessions(admin_id, expires_at)');
  await d1Query(token, 'CREATE INDEX IF NOT EXISTS idx_desktop_sessions_admin ON desktop_sessions(admin_id, expires_at) WHERE revoked_at IS NULL');
  await d1Query(token, 'CREATE INDEX IF NOT EXISTS idx_login_attempts_lookup ON login_attempts(email_hash, ip_hash, created_at)');
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

async function recoverExistingOwner(input) {
  if (!validSetupInput(input)) return false;
  const token = input.apiToken;
  const name = typeof input.adminName === 'string' ? input.adminName.trim() : '';
  const email = typeof input.adminEmail === 'string' ? input.adminEmail.trim().toLowerCase() : '';
  const password = input.adminPassword;
  if (
    name.length < 2 || name.length > 120
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    || typeof password !== 'string' || password.length < 6 || password.length > 256
  ) return false;

  const owners = resultRows(await d1Query(token,
    `SELECT id,name,email,password_hash,last_login_at,created_at
       FROM admins
      WHERE role='owner' AND status='active' AND deleted_at IS NULL
      ORDER BY created_at ASC LIMIT 2`));
  if (owners.length !== 1) return false;
  const owner = owners[0];
  if (!owner?.id || !owner?.email || !owner?.password_hash) return false;
  if (String(owner.email).toLowerCase() === email && verifiesEncodedPassword(password, owner.password_hash)) return false;

  const conflicting = resultRows(await d1Query(token,
    'SELECT id,status,deleted_at FROM admins WHERE email=? AND id<>? LIMIT 1',
    [email, owner.id]));
  if (conflicting.length !== 0) return false;

  const now = new Date().toISOString();
  await d1Query(token, 'UPDATE admin_sessions SET revoked_at=? WHERE admin_id=? AND revoked_at IS NULL', [now, owner.id]);
  await d1Query(token, 'UPDATE desktop_sessions SET revoked_at=? WHERE admin_id=? AND revoked_at IS NULL', [now, owner.id]);
  await d1Query(token,
    "UPDATE desktop_devices SET status='revoked',revoked_at=?,last_seen_at=? WHERE admin_id=? AND revoked_at IS NULL",
    [now, now, owner.id]);
  await d1Query(token, 'DELETE FROM login_attempts WHERE email_hash IN (?,?)', [emailHash(owner.email), emailHash(email)]);

  const updated = await d1Query(token, `UPDATE admins SET
    name=?, email=?, password_hash=?, role='owner', status='active',
    failed_login_count=0, locked_until=NULL, last_login_at=NULL,
    updated_at=?, deleted_at=NULL
  WHERE id=? AND role='owner' AND status='active' AND deleted_at IS NULL`,
  [name, email, encodedPasswordHash(password), now, owner.id]);
  if (Number(updated?.[0]?.meta?.changes ?? 0) !== 1) return false;

  await d1Query(token, `INSERT INTO audit_logs
    (id,actor_admin_id,action,target_type,target_id,summary_json,request_id,created_at)
  VALUES
    (?,?, 'admin.cloudflare_owner_recovered','admin',?,?,'desktop-bootstrap',?)`,
  [crypto.randomUUID(), owner.id, owner.id, JSON.stringify({
    previousEmail: owner.email,
    recoveredEmail: email,
    sessionsRevoked: true,
    loginThrottleCleared: true
  }), now]).catch(() => undefined);
  return true;
}

const raw = fs.readFileSync(0, 'utf8');
let input = null;
try { input = JSON.parse(raw || '{}'); } catch { input = null; }
await ensureAuthenticationSchema(input).catch(() => undefined);
await recoverExistingOwner(input).catch(() => false);

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
