import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { AppContext } from './types';
import { audit, first, nowIso, run } from './db';
import { randomToken, sha256 } from './crypto';
import { fail, ok } from './http';

const ActivationSchema = z.object({
  activationToken: z.string().min(40).max(500),
  deviceId: z.string().min(20).max(500),
  deviceName: z.string().trim().min(2).max(160),
  appVersion: z.string().trim().max(40).optional()
});
const RefreshSchema = z.object({
  refreshToken: z.string().min(32).max(1000),
  deviceId: z.string().min(20).max(500)
});

const ACCESS_SECONDS = 60 * 60;
const REFRESH_SECONDS = 60 * 60 * 24 * 30;

export const desktopAuthRoutes = new Hono<AppContext>();

desktopAuthRoutes.post('/desktop/activate', zValidator('json', ActivationSchema), async c => {
  const input = c.req.valid('json');
  const now = nowIso();
  const [tokenHash, deviceHash] = await Promise.all([
    sha256(input.activationToken),
    sha256(input.deviceId)
  ]);

  let ticket = await first<{
    id: string;
    bound_device_hash: string | null;
    status: string;
    expires_at: string;
  }>(c.env.DB,
    `SELECT id,bound_device_hash,status,expires_at
       FROM desktop_activation_tokens
      WHERE token_hash=? LIMIT 1`, tokenHash);

  if (!ticket || ticket.status !== 'active' || ticket.expires_at <= now) {
    return fail(c, 'DESKTOP_ACTIVATION_INVALID', 'Bu kurulumun güvenli cihaz etkinleştirmesi geçersiz veya süresi dolmuş.', 401);
  }
  if (ticket.bound_device_hash && ticket.bound_device_hash !== deviceHash) {
    return fail(c, 'DESKTOP_ACTIVATION_BOUND', 'Bu kurulum başka bir cihaza etkinleştirilmiş.', 403);
  }

  if (!ticket.bound_device_hash) {
    const bound = await c.env.DB.prepare(
      `UPDATE desktop_activation_tokens
          SET bound_device_hash=?,first_used_at=COALESCE(first_used_at,?),last_used_at=?,use_count=use_count+1
        WHERE id=? AND bound_device_hash IS NULL AND status='active' AND expires_at>?`
    ).bind(deviceHash, now, now, ticket.id, now).run();
    if ((bound.meta?.changes ?? 0) !== 1) {
      ticket = await first<{
        id: string;
        bound_device_hash: string | null;
        status: string;
        expires_at: string;
      }>(c.env.DB,
        `SELECT id,bound_device_hash,status,expires_at
           FROM desktop_activation_tokens
          WHERE token_hash=? LIMIT 1`, tokenHash);
      if (!ticket || ticket.status !== 'active' || ticket.expires_at <= now || ticket.bound_device_hash !== deviceHash) {
        return fail(c, 'DESKTOP_ACTIVATION_RACE_REJECTED', 'Cihaz etkinleştirmesi güvenli biçimde tamamlanamadı.', 409);
      }
    }
  } else {
    await run(c.env.DB,
      'UPDATE desktop_activation_tokens SET last_used_at=?,use_count=use_count+1 WHERE id=?',
      now, ticket.id);
  }

  const admin = await first<{
    id: string;
    name: string;
    email: string;
    role: string;
  }>(c.env.DB,
    `SELECT id,name,email,role
       FROM admins
      WHERE role='owner' AND status='active' AND deleted_at IS NULL
      ORDER BY created_at ASC LIMIT 1`);
  if (!admin) {
    return fail(c, 'DESKTOP_OWNER_MISSING', 'WPAI işletme sahibi kaydı bulunamadı.', 503);
  }

  let device = await first<{ id: string; status: string }>(c.env.DB,
    'SELECT id,status FROM desktop_devices WHERE admin_id=? AND device_hash=? LIMIT 1', admin.id, deviceHash);
  if (device?.status === 'revoked') {
    return fail(c, 'DESKTOP_DEVICE_REVOKED', 'Bu masaüstü cihazının erişimi iptal edilmiş.', 403);
  }
  if (!device) {
    device = { id: crypto.randomUUID(), status: 'active' };
    await run(c.env.DB,
      `INSERT INTO desktop_devices
        (id,admin_id,device_hash,display_name,platform,app_version,status,last_seen_at,created_at)
       VALUES (?,?,?,?,'windows',?,'active',?,?)`,
      device.id, admin.id, deviceHash, input.deviceName, input.appVersion ?? null, now, now);
  } else {
    await run(c.env.DB,
      `UPDATE desktop_devices
          SET display_name=?,platform='windows',app_version=?,status='active',last_seen_at=?,revoked_at=NULL
        WHERE id=?`,
      input.deviceName, input.appVersion ?? null, now, device.id);
  }

  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE admin_sessions SET revoked_at=?
        WHERE id IN (
          SELECT admin_session_id FROM desktop_sessions
           WHERE device_id=? AND admin_session_id IS NOT NULL AND revoked_at IS NULL
        ) AND revoked_at IS NULL`
    ).bind(now, device.id),
    c.env.DB.prepare(
      'UPDATE desktop_sessions SET revoked_at=? WHERE device_id=? AND revoked_at IS NULL'
    ).bind(now, device.id)
  ]);

  const credentials = await createDesktopCredentials(
    c.env.DB,
    admin.id,
    device.id,
    c.req.header('User-Agent') ?? '',
    c.req.header('CF-Connecting-IP') ?? 'unknown'
  );
  await run(c.env.DB, 'UPDATE admins SET last_login_at=?,updated_at=? WHERE id=?', now, now, admin.id);
  await audit(c.env.DB, admin.id, 'desktop.device_activated', 'desktop_device', device.id,
    { appVersion: input.appVersion ?? null, activationTicketId: ticket.id }, c.get('requestId'));

  return ok(c, {
    admin: { id: admin.id, name: admin.name, email: admin.email, role: admin.role },
    deviceId: device.id,
    accessToken: credentials.accessToken,
    refreshToken: credentials.refreshToken,
    accessExpiresAt: credentials.accessExpiresAt,
    refreshExpiresAt: credentials.refreshExpiresAt
  });
});

desktopAuthRoutes.post('/desktop/refresh', zValidator('json', RefreshSchema), async c => {
  const input = c.req.valid('json');
  const [refreshHash, deviceHash] = await Promise.all([sha256(input.refreshToken), sha256(input.deviceId)]);
  const session = await first<{
    id: string; admin_id: string; device_id: string; admin_session_id: string | null;
    name: string; email: string; role: string;
  }>(c.env.DB,
    `SELECT ds.id,ds.admin_id,ds.device_id,ds.admin_session_id,a.name,a.email,a.role
       FROM desktop_sessions ds
       JOIN desktop_devices d ON d.id=ds.device_id AND d.admin_id=ds.admin_id
       JOIN admins a ON a.id=ds.admin_id
      WHERE ds.refresh_token_hash=? AND ds.revoked_at IS NULL AND ds.expires_at>?
        AND d.device_hash=? AND d.status='active' AND d.revoked_at IS NULL
        AND a.status='active' AND a.deleted_at IS NULL LIMIT 1`,
    refreshHash, nowIso(), deviceHash);
  if (!session) return fail(c, 'DESKTOP_REFRESH_INVALID', 'Masaüstü oturumu geçersiz veya süresi dolmuş.', 401);

  const now = nowIso();
  if (session.admin_session_id) {
    await run(c.env.DB, 'UPDATE admin_sessions SET revoked_at=? WHERE id=? AND revoked_at IS NULL', now, session.admin_session_id);
  }
  const accessToken = randomToken(48);
  const refreshToken = randomToken(64);
  const accessExpiresAt = new Date(Date.now() + ACCESS_SECONDS * 1000).toISOString();
  const refreshExpiresAt = new Date(Date.now() + REFRESH_SECONDS * 1000).toISOString();
  const adminSessionId = crypto.randomUUID();
  const csrfToken = randomToken(32);
  const [accessHash, nextRefreshHash, userAgentHash, ipHash] = await Promise.all([
    sha256(accessToken), sha256(refreshToken), sha256(c.req.header('User-Agent') ?? ''), sha256(c.req.header('CF-Connecting-IP') ?? 'unknown')
  ]);
  const results = await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO admin_sessions
        (id,admin_id,token_hash,csrf_token,user_agent_hash,ip_hash,expires_at,created_at,last_seen_at)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).bind(adminSessionId, session.admin_id, accessHash, csrfToken, userAgentHash, ipHash, accessExpiresAt, now, now),
    c.env.DB.prepare(
      `UPDATE desktop_sessions SET admin_session_id=?,refresh_token_hash=?,expires_at=?,last_rotated_at=? WHERE id=?`
    ).bind(adminSessionId, nextRefreshHash, refreshExpiresAt, now, session.id),
    c.env.DB.prepare('UPDATE desktop_devices SET last_seen_at=? WHERE id=?').bind(now, session.device_id)
  ]);
  if (results.some(result => !result.success)) throw new Error('DESKTOP_REFRESH_ROTATION_FAILED');
  await audit(c.env.DB, session.admin_id, 'desktop.session_rotated', 'desktop_session', session.id, {}, c.get('requestId'));
  return ok(c, {
    admin: { id: session.admin_id, name: session.name, email: session.email, role: session.role },
    deviceId: session.device_id,
    accessToken,
    refreshToken,
    accessExpiresAt,
    refreshExpiresAt
  });
});

desktopAuthRoutes.post('/desktop/logout', zValidator('json', RefreshSchema), async c => {
  const input = c.req.valid('json');
  const [refreshHash, deviceHash] = await Promise.all([sha256(input.refreshToken), sha256(input.deviceId)]);
  const session = await first<{ id: string; admin_id: string; admin_session_id: string | null }>(c.env.DB,
    `SELECT ds.id,ds.admin_id,ds.admin_session_id FROM desktop_sessions ds
      JOIN desktop_devices d ON d.id=ds.device_id
     WHERE ds.refresh_token_hash=? AND d.device_hash=? AND ds.revoked_at IS NULL LIMIT 1`,
    refreshHash, deviceHash);
  if (session) {
    const now = nowIso();
    const statements = [
      c.env.DB.prepare('UPDATE desktop_sessions SET revoked_at=? WHERE id=?').bind(now, session.id)
    ];
    if (session.admin_session_id) statements.push(
      c.env.DB.prepare('UPDATE admin_sessions SET revoked_at=? WHERE id=? AND revoked_at IS NULL').bind(now, session.admin_session_id)
    );
    await c.env.DB.batch(statements);
    await audit(c.env.DB, session.admin_id, 'desktop.logout', 'desktop_session', session.id, {}, c.get('requestId'));
  }
  return ok(c, { loggedOut: true });
});

async function createDesktopCredentials(
  db: D1Database,
  adminId: string,
  deviceId: string,
  userAgent: string,
  ip: string
): Promise<{ accessToken: string; refreshToken: string; accessExpiresAt: string; refreshExpiresAt: string }> {
  const accessToken = randomToken(48);
  const refreshToken = randomToken(64);
  const now = nowIso();
  const accessExpiresAt = new Date(Date.now() + ACCESS_SECONDS * 1000).toISOString();
  const refreshExpiresAt = new Date(Date.now() + REFRESH_SECONDS * 1000).toISOString();
  const sessionId = crypto.randomUUID();
  const desktopSessionId = crypto.randomUUID();
  const [accessHash, refreshHash, userAgentHash, ipHash] = await Promise.all([
    sha256(accessToken), sha256(refreshToken), sha256(userAgent), sha256(ip)
  ]);
  const results = await db.batch([
    db.prepare(
      `INSERT INTO admin_sessions
        (id,admin_id,token_hash,csrf_token,user_agent_hash,ip_hash,expires_at,created_at,last_seen_at)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).bind(sessionId, adminId, accessHash, randomToken(32), userAgentHash, ipHash, accessExpiresAt, now, now),
    db.prepare(
      `INSERT INTO desktop_sessions
        (id,admin_id,device_id,admin_session_id,refresh_token_hash,expires_at,last_rotated_at,created_at)
       VALUES (?,?,?,?,?,?,?,?)`
    ).bind(desktopSessionId, adminId, deviceId, sessionId, refreshHash, refreshExpiresAt, now, now)
  ]);
  if (results.some(result => !result.success)) throw new Error('DESKTOP_SESSION_CREATE_FAILED');
  return { accessToken, refreshToken, accessExpiresAt, refreshExpiresAt };
}
