import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { request, resetBusinessData, setupAdmin } from './helpers';

beforeEach(async () => { await resetBusinessData(); });

describe('conversation-scoped R2 access', () => {
  it('serves a file only through its own verified conversation relation', async () => {
    const auth = await setupAdmin();
    const now = new Date().toISOString();
    const contactA = crypto.randomUUID(); const conversationA = crypto.randomUUID();
    const contactB = crypto.randomUUID(); const conversationB = crypto.randomUUID();
    const attachment = crypto.randomUUID(); const key = `attachments/${conversationA}/${attachment}.pdf`;
    await env.DB.batch([
      env.DB.prepare("INSERT INTO contacts (id,phone_e164,display_name,country_code,source,status,created_at,updated_at) VALUES (?,?,?,'TR','test','lead',?,?)").bind(contactA,'+905321000001','A',now,now),
      env.DB.prepare("INSERT INTO contacts (id,phone_e164,display_name,country_code,source,status,created_at,updated_at) VALUES (?,?,?,'TR','test','lead',?,?)").bind(contactB,'+905321000002','B',now,now),
      env.DB.prepare("INSERT INTO conversations (id,contact_id,status,ai_mode,created_at,updated_at) VALUES (?,?,'open','off',?,?)").bind(conversationA,contactA,now,now),
      env.DB.prepare("INSERT INTO conversations (id,contact_id,status,ai_mode,created_at,updated_at) VALUES (?,?,'open','off',?,?)").bind(conversationB,contactB,now,now),
      env.DB.prepare("INSERT INTO attachments (id,conversation_id,contact_id,r2_key,original_name,safe_name,mime_type,size_bytes,sha256,source,scan_status,created_at) VALUES (?,?,?,?,?,?,?,?,?,'customer','clean',?)").bind(attachment,conversationA,contactA,key,'teklif.pdf',`${attachment}.pdf`,'application/pdf',5,'abc',now)
    ]);
    await env.FILES.put(key, new Uint8Array([0x25,0x50,0x44,0x46,0x2d]));

    const unauthorized = await request(`/api/conversations/${conversationA}/attachments/${attachment}`);
    expect(unauthorized.status).toBe(401);

    const matching = await request(`/api/conversations/${conversationA}/attachments/${attachment}`, { headers: { Cookie: auth.cookie } });
    expect(matching.status).toBe(200);
    expect(matching.headers.get('Cache-Control')).toBe('private, no-store');
    expect(new Uint8Array(await matching.arrayBuffer())).toEqual(new Uint8Array([0x25,0x50,0x44,0x46,0x2d]));

    const crossConversation = await request(`/api/conversations/${conversationB}/attachments/${attachment}`, { headers: { Cookie: auth.cookie } });
    expect(crossConversation.status).toBe(404);

    const legacyUnscoped = await request(`/api/attachments/${attachment}`, { headers: { Cookie: auth.cookie } });
    expect(legacyUnscoped.status).toBe(410);
  });
});
