import type { Context, MiddlewareHandler } from 'hono';
import type { AppContext } from './types';
import { first, run, nowIso } from './db';
import { sha256 } from './crypto';

export function ok<T>(c: Context<AppContext>, data: T, status: 200 | 201 = 200): Response {
  return c.json({ ok: true, data }, status);
}

export function fail(c: Context<AppContext>, code: string, message: string, status = 400): Response {
  return c.json({ ok: false, error: { code, message, requestId: c.get('requestId') } }, status as 400);
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of (header ?? '').split(';')) {
    const index = item.indexOf('=');
    if (index < 1) continue;
    out[item.slice(0, index).trim()] = decodeURIComponent(item.slice(index + 1).trim());
  }
  return out;
}

export function sessionCookie(token: string, maxAgeSeconds: number): string {
  return `wpai_session=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
}

export function clearSessionCookie(): string {
  return 'wpai_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0';
}

type SessionRow = {
  session_id: string;
  admin_id: string;
  csrf_token: string;
  role: string;
  email: string;
  name: string;
};

export const requestContext: MiddlewareHandler<AppContext> = async (c, next) => {
  c.set('requestId', crypto.randomUUID());
  await next();
  c.header('X-Request-Id', c.get('requestId'));
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  c.header('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; connect-src 'self' https://graph.facebook.com https://api.cloudflare.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
};

export const requireAuth: MiddlewareHandler<AppContext> = async (c, next) => {
  const authorization = c.req.header('Authorization') ?? '';
  const bearerMatch = authorization.match(/^Bearer\s+([^\s]+)$/i);
  const bearerToken = bearerMatch?.[1];
  const cookieToken = parseCookies(c.req.header('Cookie')).wpai_session;
  const token = bearerToken ?? cookieToken;
  if (!token) return fail(c, 'AUTH_REQUIRED', 'Oturum açmanız gerekiyor.', 401);
  if (token.length < 32 || token.length > 4096) return fail(c, 'SESSION_INVALID', 'Oturum geçersiz veya süresi dolmuş.', 401);

  const tokenHash = await sha256(token);
  const row = await first<SessionRow>(
    c.env.DB,
    `SELECT s.id AS session_id,s.admin_id,s.csrf_token,a.role,a.email,a.name
       FROM admin_sessions s JOIN admins a ON a.id=s.admin_id
      WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>?
        AND a.status='active' AND a.deleted_at IS NULL LIMIT 1`,
    tokenHash, nowIso()
  );
  if (!row) return fail(c, 'SESSION_INVALID', 'Oturum geçersiz veya süresi dolmuş.', 401);
  c.set('adminId', row.admin_id);
  c.set('sessionId', row.session_id);
  c.set('csrfToken', row.csrf_token);

  const isMutation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(c.req.method);
  if (isMutation && !bearerToken) {
    const csrf = c.req.header('X-CSRF-Token');
    if (!csrf || csrf !== row.csrf_token) return fail(c, 'CSRF_INVALID', 'Güvenlik doğrulaması başarısız.', 403);
  }
  c.executionCtx.waitUntil(run(c.env.DB, 'UPDATE admin_sessions SET last_seen_at=? WHERE id=?', nowIso(), row.session_id));
  await next();
};

export async function readJson<T>(c: Context<AppContext>, maxBytes = 256_000): Promise<T> {
  const length = Number(c.req.header('Content-Length') ?? '0');
  if (length > maxBytes) throw new Error('PAYLOAD_TOO_LARGE');
  return await c.req.json<T>();
}

export function clientIpHashInput(c: Context<AppContext>): string {
  return c.req.header('CF-Connecting-IP') ?? 'unknown';
}
