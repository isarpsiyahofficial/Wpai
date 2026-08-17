import { beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { buildAiContext, finalSendGate } from '../../src/worker/ai';
import type { AiDecision } from '../../src/shared/contracts';
import type { InboundAiJob } from '../../src/worker/types';
import { authHeaders, json, request, resetBusinessData, setupAdmin } from './helpers';

const now = () => new Date().toISOString();
const decision: AiDecision = { action: 'reply', intent: 'general', confidence: .95, needs_human: false, needs_research: false, should_notify_admin: false, note_updates: [], requirement_updates: {}, reply: 'Yanıt' };

async function seedPair() {
  const a = { contact: crypto.randomUUID(), conversation: crypto.randomUUID(), message: crypto.randomUUID() };
  const b = { contact: crypto.randomUUID(), conversation: crypto.randomUUID(), message: crypto.randomUUID() };
  const timestamp = now();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO contacts (id,phone_e164,display_name,country_code,source,status,created_at,updated_at) VALUES (?,?,?,'TR','test','lead',?,?)").bind(a.contact,'+905321111111','Ahmet',timestamp,timestamp),
    env.DB.prepare("INSERT INTO contacts (id,phone_e164,display_name,country_code,source,status,created_at,updated_at) VALUES (?,?,?,'TR','test','lead',?,?)").bind(b.contact,'+905322222222','Ayşe',timestamp,timestamp),
    env.DB.prepare("INSERT INTO conversations (id,contact_id,status,ai_mode,last_inbound_at,last_message_at,current_context_version,created_at,updated_at) VALUES (?,?,'open','suggestion',?,?,1,?,?)").bind(a.conversation,a.contact,timestamp,timestamp,timestamp,timestamp),
    env.DB.prepare("INSERT INTO conversations (id,contact_id,status,ai_mode,last_inbound_at,last_message_at,current_context_version,created_at,updated_at) VALUES (?,?,'open','suggestion',?,?,1,?,?)").bind(b.conversation,b.contact,timestamp,timestamp,timestamp,timestamp),
    env.DB.prepare("INSERT INTO messages (id,conversation_id,contact_id,direction,sender_type,message_type,text_content,delivery_status,received_at,created_at) VALUES (?,?,?,'inbound','customer','text',?,'delivered',?,?)").bind(a.message,a.conversation,a.contact,'A müşterisinin özel bütçesi 15000 TL',timestamp,timestamp),
    env.DB.prepare("INSERT INTO messages (id,conversation_id,contact_id,direction,sender_type,message_type,text_content,delivery_status,received_at,created_at) VALUES (?,?,?,'inbound','customer','text',?,'delivered',?,?)").bind(b.message,b.conversation,b.contact,'B müşterisinin gizli projesi',timestamp,timestamp)
  ]);
  return { a, b };
}

beforeEach(async () => { await resetBusinessData(); });

describe('customer isolation and final send gates', () => {
  it('builds context only from the verified contact and conversation pair', async () => {
    const { a, b } = await seedPair();
    vi.spyOn(env.AI, 'run').mockResolvedValue({ data: [[1,0,0]] } as never);
    vi.spyOn(env.KNOWLEDGE_INDEX, 'query').mockResolvedValue({ count: 0, matches: [] } as never);
    const context = await buildAiContext(env, a.conversation, a.contact, 'Fiyat nedir?');
    expect(context.contact.displayName).toBe('Ahmet');
    expect(context.recentMessages.map(item => item.text).join(' ')).toContain('15000');
    expect(context.recentMessages.map(item => item.text).join(' ')).not.toContain('gizli projesi');
    await expect(buildAiContext(env, a.conversation, b.contact, 'Yanlış eşleşme')).rejects.toThrow('CONVERSATION_SCOPE_INVALID');
  });

  it('keeps manual messages idempotent and switches only that conversation to human takeover', async () => {
    const auth = await setupAdmin();
    const { a, b } = await seedPair();
    const clientRequestId = crypto.randomUUID();
    const payload = { conversationId: a.conversation, text: 'Yönetici yanıtı', clientRequestId };
    const first = await request('/api/messages/text', { method: 'POST', headers: authHeaders(auth), body: JSON.stringify(payload) });
    const second = await request('/api/messages/text', { method: 'POST', headers: authHeaders(auth), body: JSON.stringify(payload) });
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect((await json<any>(second)).data.duplicate).toBe(true);
    const count = await env.DB.prepare('SELECT COUNT(*) AS count FROM messages WHERE client_request_id=?').bind(clientRequestId).first<{ count: number }>();
    expect(count?.count).toBe(1);
    const states = await env.DB.prepare('SELECT id,ai_mode,human_takeover FROM conversations ORDER BY id').all<{ id:string;ai_mode:string;human_takeover:number }>();
    expect(states.results.find(item=>item.id===a.conversation)).toMatchObject({ai_mode:'human',human_takeover:1});
    expect(states.results.find(item=>item.id===b.conversation)).toMatchObject({ai_mode:'suggestion',human_takeover:0});
  });

  it('blocks AI when globally off, after human takeover, and for a stale message', async () => {
    const { a } = await seedPair();
    const job: InboundAiJob = { jobId:crypto.randomUUID(), conversationId:a.conversation, contactId:a.contact, sourceMessageId:a.message, expectedLastMessageId:a.message, enqueuedAt:now() };
    expect(await finalSendGate(env, job, decision)).toEqual({allowed:false,reason:'global_ai_off'});

    await env.DB.prepare("UPDATE system_settings SET value_json='\"auto\"' WHERE key='ai_global_mode'").run();
    await env.DB.prepare("UPDATE system_settings SET value_json='true' WHERE key='ai_auto_reply_enabled'").run();
    await env.DB.prepare("UPDATE conversations SET ai_mode='auto' WHERE id=?").bind(a.conversation).run();
    expect(await finalSendGate(env, job, decision)).toEqual({allowed:true});

    await env.DB.prepare("UPDATE conversations SET human_takeover=1,ai_mode='human' WHERE id=?").bind(a.conversation).run();
    expect(await finalSendGate(env, job, decision)).toEqual({allowed:false,reason:'conversation_mode'});

    await env.DB.prepare("UPDATE conversations SET human_takeover=0,ai_mode='auto' WHERE id=?").bind(a.conversation).run();
    const newer = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO messages (id,conversation_id,contact_id,direction,sender_type,message_type,text_content,delivery_status,received_at,created_at) VALUES (?,?,?,'inbound','customer','text','Yeni mesaj','delivered',?,?)").bind(newer,a.conversation,a.contact,now(),new Date(Date.now()+1000).toISOString()).run();
    expect(await finalSendGate(env, job, decision)).toEqual({allowed:false,reason:'stale_message'});
  });
});
