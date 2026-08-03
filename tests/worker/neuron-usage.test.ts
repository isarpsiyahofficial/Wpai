import { beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { decide, validateCriticalClaims, type AiContext } from '../../src/worker/ai';
import { authHeaders, json, request, resetBusinessData, setupAdmin } from './helpers';

beforeEach(async () => {
  await resetBusinessData();
  await env.DB.prepare("UPDATE system_settings SET value_json='10000' WHERE key='ai_daily_neuron_limit'").run();
  vi.restoreAllMocks();
});

async function seedConversation(phone = '+905329999991') {
  const contactId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO contacts (id,phone_e164,display_name,country_code,source,status,created_at,updated_at) VALUES (?,?,?,'TR','test','lead',?,?)").bind(contactId, phone, 'Neuron Test', now, now),
    env.DB.prepare("INSERT INTO conversations (id,contact_id,status,ai_mode,created_at,updated_at) VALUES (?,?,'open','auto',?,?)").bind(conversationId, contactId, now, now)
  ]);
  return { contactId, conversationId };
}

describe('exact Neuron usage accounting', () => {
  it('returns used, entitlement, remaining, overage, percentage, tokens and request counts', async () => {
    const auth = await setupAdmin();
    const today = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO ai_usage_records (id,model,operation_type,input_tokens,output_tokens,estimated_neurons,success,created_at) VALUES (?,'model-a','chat',100,20,2.5,1,?)").bind(crypto.randomUUID(), today),
      env.DB.prepare("INSERT INTO ai_usage_records (id,model,operation_type,input_tokens,output_tokens,estimated_neurons,success,error_code,created_at) VALUES (?,'model-a','chat',50,10,1.25,0,'TEST',?)").bind(crypto.randomUUID(), today)
    ]);
    await env.DB.prepare("UPDATE system_settings SET value_json='10' WHERE key='ai_daily_neuron_limit'").run();

    const response = await request('/api/ai/usage', { headers: { Cookie: auth.cookie } });
    expect(response.status).toBe(200);
    const body = await json<any>(response);
    expect(body.data).toMatchObject({
      usedNeurons: 3.75,
      entitlementNeurons: 10,
      freeAllocationNeurons: 10000,
      remainingNeurons: 6.25,
      overageNeurons: 0,
      usagePercent: 37.5,
      inputTokens: 150,
      outputTokens: 30,
      requests: 2,
      successfulRequests: 1,
      failedRequests: 1,
      source: 'recorded_workers_ai_usage'
    });
    expect(body.data.periodStart).toMatch(/T00:00:00\.000Z$/);
    expect(Date.parse(body.data.resetAt)).toBeGreaterThan(Date.parse(body.data.periodStart));
  });

  it('updates the configured entitlement only with authentication and CSRF, and audits the change', async () => {
    const auth = await setupAdmin();
    const unauthenticated = await request('/api/ai/usage-limit', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entitlementNeurons: 400000 })
    });
    expect(unauthenticated.status).toBe(401);
    const noCsrf = await request('/api/ai/usage-limit', {
      method: 'PUT', headers: { Cookie: auth.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ entitlementNeurons: 400000 })
    });
    expect(noCsrf.status).toBe(403);
    const updated = await request('/api/ai/usage-limit', {
      method: 'PUT', headers: authHeaders(auth), body: JSON.stringify({ entitlementNeurons: 400000 })
    });
    expect(updated.status).toBe(200);
    expect((await json<any>(updated)).data.entitlementNeurons).toBe(400000);
    const setting = await env.DB.prepare("SELECT value_json FROM system_settings WHERE key='ai_daily_neuron_limit'").first<{ value_json:string }>();
    expect(setting?.value_json).toBe('400000');
    const audit = await env.DB.prepare("SELECT summary_json FROM audit_logs WHERE action='ai.neuron_limit_changed'").first<{ summary_json:string }>();
    expect(JSON.parse(audit?.summary_json ?? '{}')).toEqual({ entitlementNeurons: 400000 });
  });

  it('creates one quota notification and disables automatic replies when the configured entitlement is exhausted', async () => {
    const { conversationId, contactId } = await seedConversation();
    await env.DB.prepare("UPDATE system_settings SET value_json='1' WHERE key='ai_daily_neuron_limit'").run();
    await env.DB.prepare("UPDATE system_settings SET value_json='\"auto\"' WHERE key='ai_global_mode'").run();
    await env.DB.prepare("UPDATE system_settings SET value_json='true' WHERE key='ai_auto_reply_enabled'").run();
    vi.spyOn(env.AI, 'run').mockResolvedValue({
      response: JSON.stringify({ action:'reply',intent:'general',confidence:.99,needs_human:false,needs_research:false,should_notify_admin:false,note_updates:[],requirement_updates:{},reply:'Merhaba' }),
      usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000 }
    } as never);
    const context: AiContext = {
      conversationId, contactId, contact:{displayName:'Test',companyName:null,city:null},summary:'',requirements:{},recentMessages:[],approvedKnowledge:[],businessInstructions:'',handoffRules:[],contextVersion:0
    };
    await decide(env, context, 'Merhaba');
    await decide(env, context, 'Tekrar');
    const notifications = await env.DB.prepare("SELECT COUNT(*) AS count FROM admin_notifications WHERE type='ai_quota' AND deduplication_key LIKE '%:100'").first<{ count:number }>();
    expect(notifications?.count).toBe(1);
    const settings = await env.DB.prepare("SELECT key,value_json FROM system_settings WHERE key IN ('ai_global_mode','ai_auto_reply_enabled') ORDER BY key").all<{key:string;value_json:string}>();
    expect(Object.fromEntries(settings.results.map(item=>[item.key,item.value_json]))).toEqual({ ai_auto_reply_enabled:'false', ai_global_mode:'"suggestion"' });
  });
});

describe('critical monetary claim isolation', () => {
  it('allows approved prices and this customer quote, but rejects another customer quote', async () => {
    const current = await seedConversation('+905329999992');
    const other = await seedConversation('+905329999993');
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO pricing_rules (id,title,amount_min,amount_max,currency_code,rule_json,status,created_at,updated_at) VALUES (?,'Web paket',10000,15000,'TRY','{}','approved',?,?)").bind(crypto.randomUUID(),now,now),
      env.DB.prepare("INSERT INTO customer_requirements (id,contact_id,conversation_id,quoted_price,currency_code,updated_at) VALUES (?,?,?,?,?,?)").bind(crypto.randomUUID(),current.contactId,current.conversationId,18000,'TRY',now),
      env.DB.prepare("INSERT INTO customer_requirements (id,contact_id,conversation_id,quoted_price,currency_code,updated_at) VALUES (?,?,?,?,?,?)").bind(crypto.randomUUID(),other.contactId,other.conversationId,22000,'TRY',now)
    ]);
    expect(await validateCriticalClaims(env,current.conversationId,current.contactId,'Paket 12.500 TL olur.')).toEqual({valid:true});
    expect(await validateCriticalClaims(env,current.conversationId,current.contactId,'Size özel teklif 18.000 TL.')).toEqual({valid:true});
    const rejected = await validateCriticalClaims(env,current.conversationId,current.contactId,'Size 22.000 TL fiyat verebiliriz.');
    expect(rejected.valid).toBe(false);
    if (!rejected.valid) expect(rejected.claims[0]?.amount).toBe(22000);
  });
});
