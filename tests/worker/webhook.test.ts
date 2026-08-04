import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  vi.unstubAllGlobals();
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
  it('downloads inbound WhatsApp media into private R2 and links it to the scoped message', async () => {
    const png = Uint8Array.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0,0,0,0,0,0,0,0]);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/v23.0/media-test-1')) {
        return new Response(JSON.stringify({
          url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=media-test-1',
          mime_type: 'image/png', file_size: png.length
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.startsWith('https://lookaside.fbsbx.com/')) {
        return new Response(png, { status: 200, headers: { 'Content-Type': 'image/png', 'Content-Length': String(png.length) } });
      }
      throw new Error(`Unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const body = JSON.stringify({
      entry: [{ changes: [{ value: {
        contacts: [{ wa_id: '905321234568', profile: { name: 'Medya Test' } }],
        messages: [{
          id: 'wamid.media.1', from: '905321234568', timestamp: String(Math.floor(Date.now()/1000)),
          type: 'image', image: { id: 'media-test-1', mime_type: 'image/png', caption: 'Logo örneği' }
        }]
      } }] }]
    });
    const response = await request('/webhooks/whatsapp', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': await signature(body) }, body
    });
    expect(response.status).toBe(200);
    const message = await env.DB.prepare(
      "SELECT conversation_id,contact_id,attachment_id,text_content FROM messages WHERE meta_message_id='wamid.media.1'"
    ).first<{ conversation_id: string; contact_id: string; attachment_id: string; text_content: string }>();
    expect(message?.text_content).toBe('Logo örneği');
    expect(message?.attachment_id).toBeTruthy();
    const attachment = await env.DB.prepare(
      'SELECT conversation_id,contact_id,r2_key,mime_type,size_bytes,source,scan_status FROM attachments WHERE id=?'
    ).bind(message!.attachment_id).first<{ conversation_id: string; contact_id: string; r2_key: string; mime_type: string; size_bytes: number; source: string; scan_status: string }>();
    expect(attachment).toMatchObject({
      conversation_id: message!.conversation_id, contact_id: message!.contact_id, mime_type: 'image/png',
      size_bytes: png.length, source: 'customer', scan_status: 'clean'
    });
    expect(attachment?.r2_key.startsWith(`attachments/${message!.conversation_id}/`)).toBe(true);
    expect(await env.FILES.get(attachment!.r2_key)).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

});
