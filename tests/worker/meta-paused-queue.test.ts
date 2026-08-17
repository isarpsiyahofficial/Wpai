import { beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { handleQueue } from '../../src/worker/queues';
import { saveMetaCredentials } from '../../src/worker/meta';
import type { OutboundJob } from '../../src/worker/types';
import { resetBusinessData, setupAdmin } from './helpers';

beforeEach(async () => {
  await resetBusinessData();
  vi.restoreAllMocks();
});

describe('paused Meta outbound safety gate', () => {
  it('does not call Meta and leaves the queued message retryable while the connection is disabled', async () => {
    const admin = await setupAdmin();
    await saveMetaCredentials(env, {
      accessToken: 'meta-access-token-paused-test-1234567890',
      appSecret: 'meta-app-secret-paused-test-1234567890',
      phoneNumberId: '123456789',
      businessAccountId: '987654321',
      verifyToken: 'meta-verify-token-paused-test-1234567890',
      adminWhatsAppPhone: '+905321234567'
    }, admin.adminId);
    await env.DB.prepare("UPDATE system_settings SET value_json='false' WHERE key='meta_connection_enabled'").run();

    const contactId = crypto.randomUUID();
    const conversationId = crypto.randomUUID();
    const messageId = crypto.randomUUID();
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO contacts (id,phone_e164,display_name,country_code,source,status,created_at,updated_at) VALUES (?,?,?,'TR','test','lead',?,?)"
      ).bind(contactId, '+905326660099', 'Paused Meta', now, now),
      env.DB.prepare(
        "INSERT INTO conversations (id,contact_id,status,ai_mode,last_inbound_at,last_message_at,created_at,updated_at) VALUES (?,?,'open','human',?,?,?,?)"
      ).bind(conversationId, contactId, now, now, now, now),
      env.DB.prepare(
        "INSERT INTO messages (id,conversation_id,contact_id,direction,sender_type,message_type,text_content,delivery_status,created_at) VALUES (?,?,?,'outbound','admin','text','Gönderilmemeli','queued',?)"
      ).bind(messageId, conversationId, contactId, now)
    ]);

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const message = {
      body: {
        jobId: crypto.randomUUID(),
        conversationId,
        contactId,
        messageId,
        kind: 'text',
        enqueuedAt: now
      } satisfies OutboundJob,
      attempts: 1,
      ack: vi.fn(),
      retry: vi.fn()
    };
    await handleQueue({ queue: 'wa-outbound', messages: [message] } as unknown as MessageBatch<unknown>, env);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledOnce();
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    expect(await env.DB.prepare('SELECT delivery_status,meta_message_id FROM messages WHERE id=?').bind(messageId).first()).toMatchObject({
      delivery_status: 'queued',
      meta_message_id: null
    });
  });
});
