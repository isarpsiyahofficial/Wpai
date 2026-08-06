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

async function recoverExistingOwner(input) {
  if (input?.action !== 'setup') return false;
  const token = input?.apiToken;
  const name = typeof input?.adminName === 'string' ? input.adminName.trim() : '';
  const email = typeof input?.adminEmail === 'string' ? input.adminEmail.trim().toLowerCase() : '';
  const password = input?.adminPassword;
  if (
    typeof token !== 'string' || token.length < 30 || token.length > 4096 || /\s/.test(token)
    || name.length < 2 || name.length > 120
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    || typeof password !== 'string' || password.length < 6 || password.length > 256
  ) return false;

  let owners;
  try {
    owners = resultRows(await d1Query(token,
      `SELECT id,name,email,password_hash,last_login_at,created_at
         FROM admins
        WHERE role='owner' AND status='active' AND deleted_at IS NULL
        ORDER BY created_at ASC LIMIT 2`));
  } catch {
    return false;
  }
  if (owners.length !== 1) return false;
  const owner = owners[0];
  if (!owner?.id || !owner?.email || !owner?.password_hash) return false;
  if (String(owner.email).toLowerCase() === email && verifiesEncodedPassword(password, owner.password_hash)) return false;

  try {
    const conflicting = resultRows(await d1Query(token,
      'SELECT id,status,deleted_at FROM admins WHERE email=? AND id<>? LIMIT 1',
      [email, owner.id]));
    if (conflicting.length !== 0) return false;

    const now = new Date().toISOString();
    await d1Query(token,
      'UPDATE admin_sessions SET revoked_at=? WHERE admin_id=? AND revoked_at IS NULL',
      [now, owner.id]);
    await d1Query(token,
      'UPDATE desktop_sessions SET revoked_at=? WHERE admin_id=? AND revoked_at IS NULL',
      [now, owner.id]);
    await d1Query(token,
      "UPDATE desktop_devices SET status='revoked',revoked_at=?,last_seen_at=? WHERE admin_id=? AND revoked_at IS NULL",
      [now, now, owner.id]);
    await d1Query(token,
      'DELETE FROM login_attempts WHERE email_hash IN (?,?)',
      [emailHash(owner.email), emailHash(email)]);

    const updated = await d1Query(token, `
UPDATE admins SET
  name=?, email=?, password_hash=?, role='owner', status='active',
  failed_login_count=0, locked_until=NULL, last_login_at=NULL,
  updated_at=?, deleted_at=NULL
WHERE id=? AND role='owner' AND status='active' AND deleted_at IS NULL
`, [name, email, encodedPasswordHash(password), now, owner.id]);
    const changes = Number(updated?.[0]?.meta?.changes ?? 0);
    if (changes !== 1) return false;

    await d1Query(token, `
INSERT INTO audit_logs
  (id,actor_admin_id,action,target_type,target_id,summary_json,request_id,created_at)
VALUES
  (?,?, 'admin.cloudflare_owner_recovered','admin',?,?,'desktop-bootstrap',?)
`, [crypto.randomUUID(), owner.id, owner.id, JSON.stringify({ previousEmail: owner.email, recoveredEmail: email, sessionsRevoked: true, loginThrottleCleared: true }), now]).catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

const raw = fs.readFileSync(0, 'utf8');
let input = null;
try { input = JSON.parse(raw || '{}'); } catch { input = null; }
await repairLegacyAdminSchema(input).catch(() => undefined);
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
