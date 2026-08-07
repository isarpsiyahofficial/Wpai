import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ACCOUNT_ID = 'ad8e99c82c6c17d823f6877ff1efade4';
const D1_ID = '81983219-f57b-487b-8144-7c70bf9b1fe2';
const RECOVERY_VERSION = 'owner-reclaim-v5';
const TEST_MODE = process.env.WPAI_BOOTSTRAP_TEST_MODE === '1';
const API_BASE = TEST_MODE && process.env.WPAI_CLOUDFLARE_API_BASE
  ? process.env.WPAI_CLOUDFLARE_API_BASE.replace(/\/$/, '')
  : 'https://api.cloudflare.com/client/v4';
const DELEGATE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'bootstrap.mjs');

function parseEngineOutput(stdout) {
  const line = String(stdout ?? '').trim().split(/\r?\n/).filter(Boolean).at(-1);
  if (!line) return null;
  try { return JSON.parse(line); } catch { return null; }
}

function runDelegate(raw) {
  const result = spawnSync(process.execPath, [DELEGATE], {
    input: raw,
    encoding: 'utf8',
    env: process.env,
    windowsHide: true,
    timeout: 30 * 60_000,
    maxBuffer: 10 * 1024 * 1024
  });
  return { ...result, body: parseEngineOutput(result.stdout) };
}

function emitDelegate(result) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.status ?? 1;
}

function validSetupInput(input) {
  return input?.action === 'setup'
    && typeof input.apiToken === 'string'
    && input.apiToken.length >= 30
    && input.apiToken.length <= 4096
    && !/\s/.test(input.apiToken)
    && typeof input.adminName === 'string'
    && input.adminName.trim().length >= 2
    && typeof input.adminEmail === 'string'
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.adminEmail.trim())
    && typeof input.adminPassword === 'string'
    && input.adminPassword.length >= 6
    && input.adminPassword.length <= 256;
}

function isExistingOwnerBlock(result) {
  const message = result?.body?.error;
  return typeof message === 'string'
    && /daha önce oluşturulmuş bir yönetici hesabı var/i.test(message)
    && /mevcut yönetici/i.test(message);
}

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

function rows(entries) {
  return Array.isArray(entries?.[0]?.results) ? entries[0].results : [];
}

function encodedPasswordHash(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.pbkdf2Sync(password, salt, 310000, 32, 'sha256');
  return `pbkdf2-sha256$310000$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function emailHash(email) {
  return crypto.createHash('sha256').update(String(email).toLowerCase(), 'utf8').digest('base64');
}

async function reclaimSingleOwner(input) {
  const token = input.apiToken;
  const name = input.adminName.trim();
  const email = input.adminEmail.trim().toLowerCase();
  const owners = rows(await d1Query(token, `
SELECT rowid AS _rowid,id,name,email
FROM admins
WHERE role='owner' AND status='active' AND deleted_at IS NULL
ORDER BY created_at ASC,rowid ASC
LIMIT 2
`));

  if (owners.length !== 1) {
    throw new Error(
      owners.length === 0
        ? `Yönetici kurtarma için aktif owner kaydı bulunamadı [${RECOVERY_VERSION}].`
        : `Birden fazla aktif owner kaydı bulundu [${RECOVERY_VERSION}]. Otomatik hesap değişikliği yapılmadı.`
    );
  }

  const owner = owners[0];
  const conflict = rows(await d1Query(token,
    'SELECT rowid AS _rowid FROM admins WHERE lower(email)=lower(?) AND rowid<>? AND deleted_at IS NULL LIMIT 1',
    [email, owner._rowid]));
  if (conflict.length) {
    throw new Error(`Girilen yönetici e-postası başka bir kayıtta kullanılıyor [${RECOVERY_VERSION}].`);
  }

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
`, [ownerId, name, email, encodedPasswordHash(input.adminPassword), now, now, owner._rowid]);

  if (Number(updated?.[0]?.meta?.changes ?? 0) !== 1) {
    throw new Error(`Tek yönetici kaydı geri alınamadı [${RECOVERY_VERSION}].`);
  }

  await d1Query(token, `
INSERT INTO audit_logs
  (id,actor_admin_id,action,target_type,target_id,summary_json,request_id,created_at)
VALUES
  (?,?, 'admin.cloudflare_owner_reclaimed','admin',?,?,'desktop-bootstrap-v5',?)
`, [crypto.randomUUID(), ownerId, ownerId, JSON.stringify({
    previousEmail: owner.email ?? null,
    recoveredEmail: email,
    oldSessionsRevoked: true
  }), now]).catch(() => undefined);

  return { ownerId, previousEmail: owner.email ?? null, recoveredEmail: email };
}

const raw = fs.readFileSync(0, 'utf8');
let input = null;
try { input = JSON.parse(raw || '{}'); } catch { input = null; }

const first = runDelegate(raw);
if (first.status === 0 && first.body?.ok === true) {
  emitDelegate(first);
} else if (!validSetupInput(input) || !isExistingOwnerBlock(first)) {
  emitDelegate(first);
} else {
  try {
    const recovery = await reclaimSingleOwner(input);
    const second = runDelegate(raw);
    if (second.status === 0 && second.body?.ok === true) {
      const body = {
        ...second.body,
        recovery: {
          version: RECOVERY_VERSION,
          ownerReclaimed: true,
          previousEmail: recovery.previousEmail,
          recoveredEmail: recovery.recoveredEmail
        }
      };
      process.stdout.write(`${JSON.stringify(body)}\n`);
      if (second.stderr) process.stderr.write(second.stderr);
      process.exitCode = 0;
    } else {
      emitDelegate(second);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(`${JSON.stringify({
      ok: false,
      error: `Cloudflare tokeni doğrulandı fakat tek yönetici kaydı geri alınamadı [${RECOVERY_VERSION}]. ${message}`
    })}\n`);
    process.exitCode = 1;
  }
}
