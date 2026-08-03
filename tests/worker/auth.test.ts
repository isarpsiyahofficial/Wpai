import { beforeAll, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { authHeaders, json, request, resetBusinessData, setupAdmin, TEST_EMAIL, TEST_PASSWORD } from './helpers';

let auth: Awaited<ReturnType<typeof setupAdmin>>;

beforeAll(async () => { await resetBusinessData(); auth = await setupAdmin(); });

describe('administrator authentication', () => {
  it('closes bootstrap after the first owner', async () => {
    const status = await request('/api/auth/setup-status');
    expect(await json(status)).toEqual({ ok: true, data: { required: false } });
    const second = await request('/api/auth/setup', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Other', email: 'other@example.com', password: 'OtherStrong123', bootstrapToken: 'test-bootstrap-token-1234567890' })
    });
    expect(second.status).toBe(409);
  });

  it('rejects unauthenticated and CSRF-less state changes', async () => {
    expect((await request('/api/dashboard')).status).toBe(401);
    const noCsrf = await request('/api/auth/change-password', {
      method: 'POST', headers: { Cookie: auth.cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: TEST_PASSWORD, newPassword: 'YeniGüvenliParola456', revokeOtherSessions: true })
    });
    expect(noCsrf.status).toBe(403);
  });

  it('does not reveal whether an email exists on bad login', async () => {
    const wrongExisting = await request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: TEST_EMAIL, password: 'YanlışParola123' }) });
    const wrongUnknown = await request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'unknown@example.com', password: 'YanlışParola123' }) });
    expect(wrongExisting.status).toBe(401);
    expect(wrongUnknown.status).toBe(401);
    expect((await json<any>(wrongExisting)).error.message).toBe((await json<any>(wrongUnknown)).error.message);
  });

  it('returns the authenticated owner and a CSRF token', async () => {
    const response = await request('/api/auth/me', { headers: { Cookie: auth.cookie } });
    expect(response.status).toBe(200);
    const body = await json<any>(response);
    expect(body.data.admin.email).toBe(TEST_EMAIL);
    expect(body.data.csrfToken).toBe(auth.csrf);
  });

  it('changes the password, revokes other sessions and rejects the old password', async () => {
    const secondLogin = await request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }) });
    const secondCookie = (secondLogin.headers.get('Set-Cookie') ?? '').split(';')[0] ?? '';
    expect(secondLogin.status).toBe(200);

    const changed = await request('/api/auth/change-password', {
      method: 'POST', headers: authHeaders(auth),
      body: JSON.stringify({ currentPassword: TEST_PASSWORD, newPassword: 'YeniGüvenliParola456', revokeOtherSessions: true })
    });
    expect(changed.status).toBe(200);
    expect((await request('/api/auth/me', { headers: { Cookie: secondCookie } })).status).toBe(401);

    const oldLogin = await request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }) });
    const newLogin = await request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: TEST_EMAIL, password: 'YeniGüvenliParola456' }) });
    expect(oldLogin.status).toBe(401);
    expect(newLogin.status).toBe(200);

    const audit = await env.DB.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action='admin.password_changed'").first<{ count: number }>();
    expect(audit?.count).toBe(1);
  });
});
