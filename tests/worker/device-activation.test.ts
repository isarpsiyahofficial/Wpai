import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { sha256 } from '../../src/worker/crypto';
import { json, request, resetBusinessData, setupAdmin } from './helpers';

const ACTIVATION_TOKEN = `wpai-activation-${'a'.repeat(64)}`;
const DEVICE_A = `device-${'1'.repeat(40)}`;
const DEVICE_B = `device-${'2'.repeat(40)}`;

async function seedActivation(token: string, expiresAt: string) {
  await env.DB.prepare(
    `INSERT INTO desktop_activation_tokens
      (id,token_hash,bound_device_hash,status,expires_at,first_used_at,last_used_at,use_count,created_at)
     VALUES (?,?,NULL,'active',?,NULL,NULL,0,?)`
  ).bind(crypto.randomUUID(), await sha256(token), expiresAt, new Date().toISOString()).run();
}

beforeEach(async () => {
  await resetBusinessData();
  await setupAdmin();
});

describe('passwordless desktop activation', () => {
  it('binds an installer ticket to one device and issues a rotating desktop session', async () => {
    await seedActivation(ACTIVATION_TOKEN, new Date(Date.now() + 60_000).toISOString());
    const activated = await request('/api/auth/desktop/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'WPAI-Windows-Test' },
      body: JSON.stringify({
        activationToken: ACTIVATION_TOKEN,
        deviceId: DEVICE_A,
        deviceName: 'WPAI Windows',
        appVersion: '1.3.6'
      })
    });
    expect(activated.status).toBe(200);
    const body = await json<any>(activated);
    expect(body.data.refreshToken).toBeTypeOf('string');
    expect(body.data.refreshToken.length).toBeGreaterThan(32);
    expect(body.data.accessToken.length).toBeGreaterThan(32);

    const ticket = await env.DB.prepare(
      'SELECT bound_device_hash,use_count FROM desktop_activation_tokens LIMIT 1'
    ).first<{ bound_device_hash: string; use_count: number }>();
    expect(ticket?.bound_device_hash).toBe(await sha256(DEVICE_A));
    expect(ticket?.use_count).toBe(1);

    const refreshed = await request('/api/auth/desktop/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: body.data.refreshToken, deviceId: DEVICE_A })
    });
    expect(refreshed.status).toBe(200);
    const refreshBody = await json<any>(refreshed);
    expect(refreshBody.data.refreshToken).not.toBe(body.data.refreshToken);
  });

  it('allows the same installer ticket to recover only the device it was first bound to', async () => {
    await seedActivation(ACTIVATION_TOKEN, new Date(Date.now() + 60_000).toISOString());
    const first = await request('/api/auth/desktop/activate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ activationToken: ACTIVATION_TOKEN, deviceId: DEVICE_A, deviceName: 'WPAI Windows', appVersion: '1.3.6' })
    });
    expect(first.status).toBe(200);

    const sameDevice = await request('/api/auth/desktop/activate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ activationToken: ACTIVATION_TOKEN, deviceId: DEVICE_A, deviceName: 'WPAI Windows', appVersion: '1.3.6' })
    });
    expect(sameDevice.status).toBe(200);

    const otherDevice = await request('/api/auth/desktop/activate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ activationToken: ACTIVATION_TOKEN, deviceId: DEVICE_B, deviceName: 'WPAI Windows', appVersion: '1.3.6' })
    });
    expect(otherDevice.status).toBe(403);
    expect((await json<any>(otherDevice)).error.code).toBe('DESKTOP_ACTIVATION_BOUND');
  });

  it('rejects an expired installer ticket without creating a device session', async () => {
    await seedActivation(ACTIVATION_TOKEN, new Date(Date.now() - 60_000).toISOString());
    const response = await request('/api/auth/desktop/activate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ activationToken: ACTIVATION_TOKEN, deviceId: DEVICE_A, deviceName: 'WPAI Windows', appVersion: '1.3.6' })
    });
    expect(response.status).toBe(401);
    expect((await json<any>(response)).error.code).toBe('DESKTOP_ACTIVATION_INVALID');
    const sessions = await env.DB.prepare('SELECT COUNT(*) AS count FROM desktop_sessions').first<{ count: number }>();
    expect(sessions?.count).toBe(0);
  });
});
