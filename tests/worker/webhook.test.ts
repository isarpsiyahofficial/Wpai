import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { saveMetaCredentials } from '../../src/worker/meta';
import { json, request, resetBusinessData, setupAdmin } from './helpers';

const secret = 'meta-app-secret-for-tests-123456789';

async function signature(body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
  return `sha256=${[...digest].map(byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

beforeEach(async () => {
  await resetBusinessData();
  const admin = await setupAdmin();
  await saveMetaCredentials(env, {
    accessToken: 'test-access-token-not-a-real-meta-token', appSecret: secret,
    phoneNumberId: '123456789', businessAccountId: '987654321',
    verifyToken: 'verify-token-for-tests-123456', adminWhatsAppPhone: '+905321234567'
  }, admin.adminId);
});

describe('WhatsApp webhook', () => {
  it('rejects invalid signatures without persisting customer data', async () => {
    const body = JSON.stringify({ entry: [] });
    const response = await request('/webhooks/whatsapp', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': 'sha256=bad' }, body });
    expect(response.status).toBe(401);
    const contacts = await env.DB.prepare('SELECT COUNT(*) AS count FROM contacts').first<{ count:number }>();
    expect(contacts?.count).toBe(0);
  });

  it('stores the inbound message once and records marketing opt-out', async () => {
    const body = JSON.stringify({
      entry: [{ changes: [{ value: {
        contacts: [{ wa_id: '905321234567', profile: { name: 'Ahmet Test' } }],
        messages: [{ id: 'wamid.test.1', from: '905321234567', timestamp: String(Math.floor(Date.now()/1000)), type: 'text', text: { body: 'dur' } }]
      } }] }]
    });
    const headers = { 'Content-Type': 'application/json', 'X-Hub-Signature-256': await signature(body) };
    const firstResponse = await request('/webhooks/whatsapp', { method: 'POST', headers, body });
    const duplicateResponse = await request('/webhooks/whatsapp', { method: 'POST', headers, body });
    expect(firstResponse.status).toBe(200);
    expect((await json<any>(duplicateResponse)).duplicate).toBe(true);

    const message = await env.DB.prepare("SELECT COUNT(*) AS count FROM messages WHERE meta_message_id='wamid.test.1'").first<{ count:number }>();
    const optout = await env.DB.prepare("SELECT COUNT(*) AS count FROM opt_outs WHERE scope='marketing' AND revoked_at IS NULL").first<{ count:number }>();
    const jobs = await env.DB.prepare('SELECT COUNT(*) AS count FROM ai_jobs').first<{ count:number }>();
    expect(message?.count).toBe(1);
    expect(optout?.count).toBe(1);
    expect(jobs?.count).toBe(1);
  });

  it('supports the Meta verification challenge only with the saved token', async () => {
    const good = await request('/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-token-for-tests-123456&hub.challenge=321');
    const bad = await request('/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=321');
    expect(good.status).toBe(200);
    expect(await good.text()).toBe('321');
    expect(bad.status).toBe(403);
  });
});
