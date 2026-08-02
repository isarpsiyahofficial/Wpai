import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { ChangePasswordSchema, LoginSchema, SetupAdminSchema } from '../shared/contracts';
import type { AppContext } from './types';
import { audit, first, run, nowIso } from './db';
import { hashPassword, passwordPolicy, randomToken, sha256, verifyPassword } from './crypto';
import { clearSessionCookie, clientIpHashInput, fail, ok, requireAuth, sessionCookie } from './http';

const SESSION_SECONDS = 60 * 60 * 12;

async function createSession(db: D1Database, adminId: string, userAgent: string, ip: string) {
  const token = randomToken(48);
  const tokenHash = await sha256(token);
  const csrfToken = randomToken(32);
  const id = crypto.randomUUID();
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + SESSION_SECONDS * 1000).toISOString();
  await run(db,
    `INSERT INTO admin_sessions (id, admin_id, token_hash, csrf_token, user_agent_hash, ip_hash, expires_at, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, adminId, tokenHash, csrfToken, await sha256(userAgent), await sha256(ip), expiresAt, createdAt, createdAt
  );
  return { token, csrfToken, expiresAt };
}

export const authRoutes = new Hono<AppContext>();

authRoutes.get('/setup-status', async c => {
  const row = await first<{ count: number }>(c.env.DB, "SELECT COUNT(*) AS count FROM admins WHERE deleted_at IS NULL");
  return ok(c, { required: (row?.count ?? 0) === 0 });
});

authRoutes.post('/setup', zValidator('json', SetupAdminSchema), async c => {
  const existing = await first<{ count: number }>(c.env.DB, "SELECT COUNT(*) AS count FROM admins WHERE deleted_at IS NULL");
  if ((existing?.count ?? 0) > 0) return fail(c, 'SETUP_CLOSED', 'İlk yönetici kurulumu daha önce tamamlanmış.', 409);
  const input = c.req.valid('json');
  if (!c.env.ADMIN_BOOTSTRAP_TOKEN) return fail(c, 'BOOTSTRAP_NOT_CONFIGURED', 'Kurulum anahtarı yapılandırılmamış.', 503);
  const [given, expected] = await Promise.all([sha256(input.bootstrapToken), sha256(c.env.ADMIN_BOOTSTRAP_TOKEN)]);
  if (given !== expected) return fail(c, 'BOOTSTRAP_INVALID', 'Kurulum anahtarı geçersiz.', 403);
  const policy = passwordPolicy(input.password);
  if (policy.length) return fail(c, 'PASSWORD_POLICY', policy.join(' '), 422);
  const id = crypto.randomUUID();
  const now = nowIso();
  await run(c.env.DB,
    `INSERT INTO admins (id, name, email, password_hash, role, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'owner', 'active', ?, ?)`,
    id, input.name, input.email.toLowerCase(), await hashPassword(input.password), now, now
  );
  await audit(c.env.DB, id, 'admin.bootstrap_created', 'admin', id, {}, c.get('requestId'));
  const session = await createSession(c.env.DB, id, c.req.header('User-Agent') ?? '', clientIpHashInput(c));
  c.header('Set-Cookie', sessionCookie(session.token, SESSION_SECONDS));
  return ok(c, { admin: { id, name: input.name, email: input.email.toLowerCase(), role: 'owner' }, csrfToken: session.csrfToken }, 201);
});

authRoutes.post('/login', zValidator('json', LoginSchema), async c => {
  const input = c.req.valid('json');
  const email = input.email.toLowerCase();
  const [emailHash, ipHash] = await Promise.all([sha256(email), sha256(clientIpHashInput(c))]);
  const since = new Date(Date.now() - 15 * 60_000).toISOString();
  const attempts = await first<{ count: number }>(c.env.DB,
    `SELECT COUNT(*) AS count FROM login_attempts WHERE email_hash = ? AND ip_hash = ? AND success = 0 AND created_at > ?`,
    emailHash, ipHash, since
  );
  if ((attempts?.count ?? 0) >= 8) return fail(c, 'LOGIN_RATE_LIMITED', 'Çok fazla başarısız deneme. Bir süre sonra tekrar deneyin.', 429);

  const admin = await first<{ id: string; name: string; email: string; password_hash: string; role: string; status: string; locked_until: string | null }>(
    c.env.DB,
    'SELECT id, name, email, password_hash, role, status, locked_until FROM admins WHERE email = ? AND deleted_at IS NULL LIMIT 1',
    email
  );
  const valid = admin ? await verifyPassword(input.password, admin.password_hash) : false;
  await run(c.env.DB,
    'INSERT INTO login_attempts (id, email_hash, ip_hash, success, created_at) VALUES (?, ?, ?, ?, ?)',
    crypto.randomUUID(), emailHash, ipHash, valid ? 1 : 0, nowIso()
  );
  if (!admin || !valid || admin.status !== 'active' || (admin.locked_until && admin.locked_until > nowIso())) {
    if (admin && !valid) {
      const failures = (await first<{ failed_login_count: number }>(c.env.DB, 'SELECT failed_login_count FROM admins WHERE id = ?', admin.id))?.failed_login_count ?? 0;
      const next = failures + 1;
      const lock = next >= 8 ? new Date(Date.now() + 15 * 60_000).toISOString() : null;
      await run(c.env.DB, 'UPDATE admins SET failed_login_count = ?, locked_until = ?, updated_at = ? WHERE id = ?', next, lock, nowIso(), admin.id);
    }
    return fail(c, 'LOGIN_FAILED', 'E-posta veya parola hatalı.', 401);
  }

  await run(c.env.DB, 'UPDATE admins SET failed_login_count = 0, locked_until = NULL, last_login_at = ?, updated_at = ? WHERE id = ?', nowIso(), nowIso(), admin.id);
  const session = await createSession(c.env.DB, admin.id, c.req.header('User-Agent') ?? '', clientIpHashInput(c));
  c.header('Set-Cookie', sessionCookie(session.token, SESSION_SECONDS));
  await audit(c.env.DB, admin.id, 'admin.login', 'admin', admin.id, {}, c.get('requestId'));
  return ok(c, { admin: { id: admin.id, name: admin.name, email: admin.email, role: admin.role }, csrfToken: session.csrfToken });
});

authRoutes.use('/me/*', requireAuth);
authRoutes.get('/me', requireAuth, async c => {
  const admin = await first<{ id: string; name: string; email: string; role: string }>(c.env.DB, 'SELECT id, name, email, role FROM admins WHERE id = ?', c.get('adminId')!);
  return ok(c, { admin, csrfToken: c.get('csrfToken') });
});

authRoutes.post('/logout', requireAuth, async c => {
  await run(c.env.DB, 'UPDATE admin_sessions SET revoked_at = ? WHERE id = ?', nowIso(), c.get('sessionId')!);
  c.header('Set-Cookie', clearSessionCookie());
  await audit(c.env.DB, c.get('adminId')!, 'admin.logout', 'session', c.get('sessionId')!, {}, c.get('requestId'));
  return ok(c, { loggedOut: true });
});

authRoutes.post('/change-password', requireAuth, zValidator('json', ChangePasswordSchema), async c => {
  const input = c.req.valid('json');
  const policy = passwordPolicy(input.newPassword);
  if (policy.length) return fail(c, 'PASSWORD_POLICY', policy.join(' '), 422);
  const admin = await first<{ password_hash: string }>(c.env.DB, 'SELECT password_hash FROM admins WHERE id = ?', c.get('adminId')!);
  if (!admin || !(await verifyPassword(input.currentPassword, admin.password_hash))) {
    return fail(c, 'CURRENT_PASSWORD_INVALID', 'Mevcut parola doğrulanamadı.', 403);
  }
  const newHash = await hashPassword(input.newPassword);
  const now = nowIso();
  const statements = [
    c.env.DB.prepare('UPDATE admins SET password_hash = ?, failed_login_count = 0, locked_until = NULL, updated_at = ? WHERE id = ?').bind(newHash, now, c.get('adminId')!)
  ];
  if (input.revokeOtherSessions) {
    statements.push(c.env.DB.prepare('UPDATE admin_sessions SET revoked_at = ? WHERE admin_id = ? AND id <> ? AND revoked_at IS NULL').bind(now, c.get('adminId')!, c.get('sessionId')!));
  }
  const results = await c.env.DB.batch(statements);
  if (results.some(result => !result.success)) throw new Error('PASSWORD_UPDATE_FAILED');
  await audit(c.env.DB, c.get('adminId')!, 'admin.password_changed', 'admin', c.get('adminId')!, { otherSessionsRevoked: input.revokeOtherSessions }, c.get('requestId'));
  return ok(c, { changed: true });
});
