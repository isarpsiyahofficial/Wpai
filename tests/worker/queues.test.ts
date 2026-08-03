import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { handleQueue } from '../../src/worker/queues';
import { saveMetaCredentials } from '../../src/worker/meta';
import type { AdminNotifyJob, DeadLetterJob, InboundAiJob, OutboundJob } from '../../src/worker/types';
import { resetBusinessData, setupAdmin } from './helpers';

beforeEach(async()=>{await resetBusinessData();vi.restoreAllMocks();});
afterEach(()=>vi.unstubAllGlobals());

type FakeMessage<T>={body:T;attempts:number;ack:ReturnType<typeof vi.fn>;retry:ReturnType<typeof vi.fn>};
function fakeMessage<T>(body:T,attempts=1):FakeMessage<T>{return{body,attempts,ack:vi.fn(),retry:vi.fn()};}
async function consume<T>(queue:string,message:FakeMessage<T>){await handleQueue({queue,messages:[message]} as unknown as MessageBatch<unknown>,env);}

async function seedConversation(options:{aiMode?:string;human?:number;phone?:string}={}){
  const contactId=crypto.randomUUID(),conversationId=crypto.randomUUID();const now=new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO contacts (id,phone_e164,display_name,country_code,source,status,created_at,updated_at) VALUES (?,?,?,'TR','test','lead',?,?)").bind(contactId,options.phone??'+905326660001','Queue Test',now,now),
    env.DB.prepare("INSERT INTO conversations (id,contact_id,status,ai_mode,human_takeover,last_inbound_at,last_message_at,created_at,updated_at) VALUES (?,?,'open',?,?,?,?,?,?,?)").bind(conversationId,contactId,options.aiMode??'suggestion',options.human??0,now,now,now,now)
  ]);
  return{contactId,conversationId,now};
}
async function enableMeta(adminId:string){
  await saveMetaCredentials(env,{accessToken:'meta-access-token-queue-test-123456',appSecret:'meta-secret-queue-test-1234567890',phoneNumberId:'123456789',businessAccountId:'987654321',verifyToken:'verify-token-queue-test-1234567890',adminWhatsAppPhone:'+905321234567'},adminId);
  await env.DB.prepare("UPDATE system_settings SET value_json='true' WHERE key='meta_connection_enabled'").run();
}

describe('outbound and notification queues',()=>{
  it('submits a manual text to Meta and records the delivery event exactly once',async()=>{
    const admin=await setupAdmin();await enableMeta(admin.adminId);const seeded=await seedConversation();const messageId=crypto.randomUUID();
    await env.DB.prepare("INSERT INTO messages (id,conversation_id,contact_id,direction,sender_type,message_type,text_content,delivery_status,created_at) VALUES (?,?,?,'outbound','admin','text','Merhaba','queued',?)").bind(messageId,seeded.conversationId,seeded.contactId,seeded.now).run();
    let sentBody:any=null;vi.stubGlobal('fetch',vi.fn(async(_input:RequestInfo|URL,init?:RequestInit)=>{sentBody=JSON.parse(String(init?.body));return new Response(JSON.stringify({messages:[{id:'wamid.outbound.1'}]}),{status:200,headers:{'Content-Type':'application/json'}});}));
    const message=fakeMessage<OutboundJob>({jobId:crypto.randomUUID(),conversationId:seeded.conversationId,contactId:seeded.contactId,messageId,kind:'text',enqueuedAt:seeded.now});await consume('wa-outbound',message);
    expect(message.ack).toHaveBeenCalledOnce();expect(message.retry).not.toHaveBeenCalled();expect(sentBody).toMatchObject({messaging_product:'whatsapp',to:'905326660001',type:'text',text:{preview_url:false,body:'Merhaba'}});
    expect(await env.DB.prepare('SELECT meta_message_id,delivery_status FROM messages WHERE id=?').bind(messageId).first()).toMatchObject({meta_message_id:'wamid.outbound.1',delivery_status:'submitted'});
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM message_status_events WHERE message_id=? AND status='submitted'").bind(messageId).first<{count:number}>())?.count).toBe(1);
  });

  it('cancels an AI message if human takeover changed after the AI decision',async()=>{
    const admin=await setupAdmin();await enableMeta(admin.adminId);const seeded=await seedConversation({aiMode:'human',human:1,phone:'+905326660002'});const decisionId=crypto.randomUUID(),messageId=crypto.randomUUID();
    await env.DB.prepare("INSERT INTO ai_decisions (id,conversation_id,contact_id,action,intent,confidence,needs_human,needs_research,should_notify_admin,decision_json,model,context_version,created_at) VALUES (?,?,?,'reply','general',1,0,0,0,'{}','test',0,?)").bind(decisionId,seeded.conversationId,seeded.contactId,seeded.now).run();
    await env.DB.prepare("INSERT INTO messages (id,conversation_id,contact_id,direction,sender_type,message_type,text_content,delivery_status,ai_generated,ai_decision_id,created_at) VALUES (?,?,?,'outbound','ai','text','AI yanıtı','queued',1,?,?)").bind(messageId,seeded.conversationId,seeded.contactId,decisionId,seeded.now).run();
    const fetchMock=vi.fn();vi.stubGlobal('fetch',fetchMock);const message=fakeMessage<OutboundJob>({jobId:crypto.randomUUID(),conversationId:seeded.conversationId,contactId:seeded.contactId,messageId,kind:'text',expectedAiDecisionId:decisionId,enqueuedAt:seeded.now});await consume('wa-outbound',message);
    expect(message.ack).toHaveBeenCalledOnce();expect(fetchMock).not.toHaveBeenCalled();expect(await env.DB.prepare('SELECT delivery_status,error_code FROM messages WHERE id=?').bind(messageId).first()).toMatchObject({delivery_status:'cancelled',error_code:'AI_GATE_CHANGED'});
  });

  it('marks admin notification as template-required, then sends it when the approved utility template exists',async()=>{
    const admin=await setupAdmin();await enableMeta(admin.adminId);await env.DB.prepare("UPDATE system_settings SET value_json='true' WHERE key='admin_notifications_enabled'").run();const seeded=await seedConversation({phone:'+905326660003'});const notificationId=crypto.randomUUID();
    await env.DB.prepare("INSERT INTO admin_notifications (id,type,priority,status,contact_id,conversation_id,title,body,created_at,updated_at) VALUES (?,'ai_handoff','high','unread',?,?,'Müdahale','Müşteri bekliyor',?,?)").bind(notificationId,seeded.contactId,seeded.conversationId,seeded.now,seeded.now).run();
    const first=fakeMessage<AdminNotifyJob>({jobId:crypto.randomUUID(),notificationId,conversationId:seeded.conversationId,enqueuedAt:seeded.now});await consume('wa-admin-notify',first);expect(first.ack).toHaveBeenCalledOnce();expect((await env.DB.prepare('SELECT whatsapp_status FROM admin_notifications WHERE id=?').bind(notificationId).first<{whatsapp_status:string}>())?.whatsapp_status).toBe('template_required');
    await env.DB.batch([
      env.DB.prepare("INSERT INTO message_templates (id,meta_name,language_code,status,components_json,created_at,updated_at) VALUES (?,'admin_alert_v1','tr','APPROVED','[]',?,?)").bind(crypto.randomUUID(),seeded.now,seeded.now),
      env.DB.prepare("UPDATE admin_notifications SET whatsapp_status=NULL WHERE id=?").bind(notificationId)
    ]);
    vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({messages:[{id:'wamid.admin.1'}]}),{status:200,headers:{'Content-Type':'application/json'}})));
    const second=fakeMessage<AdminNotifyJob>({jobId:crypto.randomUUID(),notificationId,conversationId:seeded.conversationId,enqueuedAt:seeded.now});await consume('wa-admin-notify',second);expect(second.ack).toHaveBeenCalledOnce();expect((await env.DB.prepare('SELECT whatsapp_status FROM admin_notifications WHERE id=?').bind(notificationId).first<{whatsapp_status:string}>())?.whatsapp_status).toBe('sent');
  });

  it('persists a safe system notification for every dead-letter item',async()=>{
    const body:DeadLetterJob={sourceQueue:'wa-outbound',originalJob:{id:'x'},errorCode:'META_SEND_FAILED',failedAt:new Date().toISOString()};const message=fakeMessage(body);await consume('wa-outbound-dlq',message);expect(message.ack).toHaveBeenCalledOnce();expect(await env.DB.prepare("SELECT type,priority,title,body FROM admin_notifications WHERE type='system_error'").first()).toMatchObject({type:'system_error',priority:'high',title:'Kuyruk işi başarısız',body:'wa-outbound: META_SEND_FAILED'});
  });
});

describe('inbound AI queue',()=>{
  async function seedInbound(reply:string){
    const seeded=await seedConversation({aiMode:'auto',phone:'+905326660004'});await env.DB.prepare("UPDATE system_settings SET value_json='\"auto\"' WHERE key='ai_global_mode'").run();await env.DB.prepare("UPDATE system_settings SET value_json='true' WHERE key='ai_auto_reply_enabled'").run();await env.DB.prepare("UPDATE system_settings SET value_json='4' WHERE key='ai_summary_message_interval'").run();
    const messageIds:string[]=[];for(let index=0;index<4;index+=1){const id=crypto.randomUUID();messageIds.push(id);const created=new Date(Date.now()+index*1000).toISOString();await env.DB.prepare("INSERT INTO messages (id,conversation_id,contact_id,direction,sender_type,message_type,text_content,delivery_status,received_at,created_at) VALUES (?,?,?,'inbound','customer','text',?,'delivered',?,?)").bind(id,seeded.conversationId,seeded.contactId,index===3?'Bütçem nedir?':`Mesaj ${index}`,created,created).run();}
    const sourceMessageId=messageIds[3]!,jobId=crypto.randomUUID();await env.DB.prepare("UPDATE conversations SET last_message_at=?,current_context_version=4 WHERE id=?").bind(new Date(Date.now()+3000).toISOString(),seeded.conversationId).run();await env.DB.prepare("INSERT INTO ai_jobs (id,conversation_id,contact_id,source_message_id,status,expected_context_version,created_at,updated_at) VALUES (?,?,?,?,'queued',4,?,?)").bind(jobId,seeded.conversationId,seeded.contactId,sourceMessageId,seeded.now,seeded.now).run();
    vi.spyOn(env.AI,'run').mockImplementation(async(_model,input:any)=>'text' in input?({data:[[1,0,0]],usage:{input_tokens:10}} as never):({response:JSON.stringify({action:'reply',intent:'price_question',confidence:.99,needs_human:false,needs_research:false,should_notify_admin:false,note_updates:[{text:'Kurumsal site istiyor'}],requirement_updates:{sector:'Hizmet',website_type:'kurumsal',budget_min:12000,unknown_field:'ignore'},reply}),usage:{prompt_tokens:100,completion_tokens:20}} as never));
    vi.spyOn(env.KNOWLEDGE_INDEX,'query').mockResolvedValue({count:0,matches:[]} as never);
    return{...seeded,sourceMessageId,jobId};
  }

  it('persists notes, safe requirements and summaries, then blocks an unapproved price and hands off',async()=>{
    const seeded=await seedInbound('Bu çalışma 22.000 TL olur.');const message=fakeMessage<InboundAiJob>({jobId:seeded.jobId,conversationId:seeded.conversationId,contactId:seeded.contactId,sourceMessageId:seeded.sourceMessageId,expectedLastMessageId:seeded.sourceMessageId,enqueuedAt:seeded.now});await consume('wa-inbound-ai',message);
    expect(message.ack).toHaveBeenCalledOnce();expect(await env.DB.prepare("SELECT note_text FROM customer_notes WHERE contact_id=? AND source='ai'").bind(seeded.contactId).first()).toMatchObject({note_text:'Kurumsal site istiyor'});
    const requirements=await env.DB.prepare('SELECT sector,website_type,budget_min FROM customer_requirements WHERE conversation_id=? AND contact_id=?').bind(seeded.conversationId,seeded.contactId).first();expect(requirements).toMatchObject({sector:'Hizmet',website_type:'kurumsal',budget_min:12000});
    expect(await env.DB.prepare('SELECT version,through_message_id FROM conversation_summaries WHERE conversation_id=?').bind(seeded.conversationId).first()).toMatchObject({version:1,through_message_id:seeded.sourceMessageId});
    expect(await env.DB.prepare('SELECT blocked_reason FROM ai_decisions WHERE conversation_id=?').bind(seeded.conversationId).first()).toMatchObject({blocked_reason:'unapproved_price_claim'});expect(await env.DB.prepare('SELECT reason_code,status FROM human_handoffs WHERE conversation_id=?').bind(seeded.conversationId).first()).toMatchObject({reason_code:'unapproved_price_claim',status:'open'});expect(await env.DB.prepare('SELECT ai_mode,human_takeover FROM conversations WHERE id=?').bind(seeded.conversationId).first()).toMatchObject({ai_mode:'human',human_takeover:1});
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM messages WHERE conversation_id=? AND direction='outbound'").bind(seeded.conversationId).first<{count:number}>())?.count).toBe(0);expect((await env.DB.prepare('SELECT status FROM ai_jobs WHERE id=?').bind(seeded.jobId).first<{status:string}>())?.status).toBe('completed');
  });

  it('queues a response when its monetary claim is covered by an approved price rule',async()=>{
    const seeded=await seedInbound('Kurumsal paket 12.500 TL olur.');await env.DB.prepare("INSERT INTO pricing_rules (id,title,amount_min,amount_max,currency_code,rule_json,status,created_at,updated_at) VALUES (?,'Kurumsal',10000,15000,'TRY','{}','approved',?,?)").bind(crypto.randomUUID(),seeded.now,seeded.now).run();const message=fakeMessage<InboundAiJob>({jobId:seeded.jobId,conversationId:seeded.conversationId,contactId:seeded.contactId,sourceMessageId:seeded.sourceMessageId,expectedLastMessageId:seeded.sourceMessageId,enqueuedAt:seeded.now});await consume('wa-inbound-ai',message);
    expect(message.ack).toHaveBeenCalledOnce();const outbound=await env.DB.prepare("SELECT sender_type,text_content,delivery_status,ai_generated FROM messages WHERE conversation_id=? AND direction='outbound'").bind(seeded.conversationId).first();expect(outbound).toMatchObject({sender_type:'ai',text_content:'Kurumsal paket 12.500 TL olur.',delivery_status:'queued',ai_generated:1});expect(await env.DB.prepare('SELECT id FROM human_handoffs WHERE conversation_id=?').bind(seeded.conversationId).first()).toBeNull();
  });
});
