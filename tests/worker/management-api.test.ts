import { beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { authHeaders, json, request, resetBusinessData, setupAdmin } from './helpers';

beforeEach(async () => { await resetBusinessData(); vi.restoreAllMocks(); });

async function seedConversation(options: { phone?: string; lastInbound?: string; aiMode?: string } = {}) {
  const contactId = crypto.randomUUID(); const conversationId = crypto.randomUUID(); const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO contacts (id,phone_e164,display_name,company_name,email,city,country_code,source,status,created_at,updated_at) VALUES (?,?,?,?,?,?,'TR','test','lead',?,?)").bind(contactId,options.phone??'+905321112233','Yönetim Test','Test AŞ','test@example.com','Antalya',now,now),
    env.DB.prepare("INSERT INTO conversations (id,contact_id,status,ai_mode,last_inbound_at,last_message_at,unread_count,created_at,updated_at) VALUES (?,?,'open',?,?,?,3,?,?)").bind(conversationId,contactId,options.aiMode??'suggestion',options.lastInbound??now,now,now,now)
  ]);
  return { contactId, conversationId, now };
}

describe('contacts and conversations management', () => {
  it('creates, searches and rejects duplicate contacts', async () => {
    const auth = await setupAdmin();
    const created = await request('/api/contacts',{method:'POST',headers:authHeaders(auth),body:JSON.stringify({displayName:'Ayşe Kaya',phone:'05321234567',companyName:'Kaya Ltd',email:'ayse@example.com',city:'Burdur',countryCode:'TR',source:'manual'})});
    expect(created.status).toBe(201);
    const body=await json<any>(created); expect(body.data.phoneE164).toBe('+905321234567');
    const duplicate=await request('/api/contacts',{method:'POST',headers:authHeaders(auth),body:JSON.stringify({displayName:'Tekrar',phone:'+905321234567',countryCode:'TR',source:'manual'})});
    expect(duplicate.status).toBe(409);
    const list=await request('/api/contacts?q=Kaya',{headers:{Cookie:auth.cookie}}); const rows=(await json<any>(list)).data;
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({display_name:'Ayşe Kaya',company_name:'Kaya Ltd',city:'Burdur'});
  });

  it('returns complete conversation detail, clears unread state and changes AI mode', async () => {
    const auth=await setupAdmin(); const seeded=await seedConversation();
    const messageId=crypto.randomUUID();
    await env.DB.prepare("INSERT INTO messages (id,conversation_id,contact_id,direction,sender_type,message_type,text_content,delivery_status,received_at,created_at) VALUES (?,?,?,'inbound','customer','text','Kurumsal site istiyorum','delivered',?,?)").bind(messageId,seeded.conversationId,seeded.contactId,seeded.now,seeded.now).run();
    const list=await request('/api/conversations?q=Yönetim',{headers:{Cookie:auth.cookie}}); expect((await json<any>(list)).data[0].last_message).toBe('Kurumsal site istiyorum');
    const detail=await request(`/api/conversations/${seeded.conversationId}`,{headers:{Cookie:auth.cookie}}); const data=(await json<any>(detail)).data;
    expect(data.conversation).toMatchObject({contact_id:seeded.contactId,display_name:'Yönetim Test',company_name:'Test AŞ'}); expect(data.messages).toHaveLength(1);
    const read=await request(`/api/conversations/${seeded.conversationId}/read`,{method:'POST',headers:authHeaders(auth)}); expect(read.status).toBe(200);
    expect((await env.DB.prepare('SELECT unread_count FROM conversations WHERE id=?').bind(seeded.conversationId).first<{unread_count:number}>())?.unread_count).toBe(0);
    const mode=await request(`/api/conversations/${seeded.conversationId}/ai-mode`,{method:'PUT',headers:authHeaders(auth),body:JSON.stringify({mode:'human',pausedUntil:null})}); expect(mode.status).toBe(200);
    expect(await env.DB.prepare('SELECT ai_mode,human_takeover,human_takeover_by FROM conversations WHERE id=?').bind(seeded.conversationId).first()).toMatchObject({ai_mode:'human',human_takeover:1,human_takeover_by:auth.adminId});
  });

  it('exports all customer records and permanently deletes D1 and R2 only after phone confirmation', async () => {
    const auth=await setupAdmin(); const seeded=await seedConversation({phone:'+905321119999'}); const attachmentId=crypto.randomUUID(); const key=`attachments/${seeded.conversationId}/${attachmentId}.pdf`;
    await env.DB.prepare("INSERT INTO attachments (id,conversation_id,contact_id,r2_key,original_name,safe_name,mime_type,size_bytes,sha256,source,scan_status,created_at) VALUES (?,?,?,?,?,?,?,?,?,'admin','clean',?)").bind(attachmentId,seeded.conversationId,seeded.contactId,key,'dosya.pdf','safe.pdf','application/pdf',5,'abc',seeded.now).run();
    await env.FILES.put(key,new Uint8Array([0x25,0x50,0x44,0x46,0x2d]));
    const exported=await request(`/api/contacts/${seeded.contactId}/export`,{headers:{Cookie:auth.cookie}}); const exportData=(await json<any>(exported)).data;
    expect(exportData.contact.phone_e164).toBe('+905321119999'); expect(exportData.attachments[0].id).toBe(attachmentId);
    const wrong=await request(`/api/contacts/${seeded.contactId}`,{method:'DELETE',headers:authHeaders(auth),body:JSON.stringify({confirmPhone:'+905320000000'})}); expect(wrong.status).toBe(409);
    expect(await env.FILES.get(key)).not.toBeNull();
    const removed=await request(`/api/contacts/${seeded.contactId}`,{method:'DELETE',headers:authHeaders(auth),body:JSON.stringify({confirmPhone:'+905321119999'})}); expect(removed.status).toBe(200);
    expect(await env.DB.prepare('SELECT id FROM contacts WHERE id=?').bind(seeded.contactId).first()).toBeNull(); expect(await env.FILES.get(key)).toBeNull();
  });
});

describe('messages, templates and files', () => {
  it('requires an approved Meta template for first contact and queues every template field', async () => {
    const auth=await setupAdmin(); const now=new Date().toISOString();
    const rejected=await request('/api/messages/template',{method:'POST',headers:authHeaders(auth),body:JSON.stringify({phone:'05320001122',displayName:'Yeni',templateName:'ilk_mesaj',languageCode:'tr',variables:['Yeni']})}); expect(rejected.status).toBe(409);
    await env.DB.prepare("INSERT INTO message_templates (id,meta_name,language_code,category,status,components_json,created_at,updated_at) VALUES (?,'ilk_mesaj','tr','MARKETING','APPROVED','[]',?,?)").bind(crypto.randomUUID(),now,now).run();
    const sent=await request('/api/messages/template',{method:'POST',headers:authHeaders(auth),body:JSON.stringify({phone:'05320001122',displayName:'Yeni Müşteri',templateName:'ilk_mesaj',languageCode:'tr',variables:['Yeni Müşteri','Web sitesi']})}); expect(sent.status).toBe(201);
    const result=(await json<any>(sent)).data;
    const message=await env.DB.prepare('SELECT message_type,text_content,delivery_status FROM messages WHERE id=?').bind(result.messageId).first<{message_type:string;text_content:string;delivery_status:string}>();
    expect(message?.message_type).toBe('template'); expect(JSON.parse(message?.text_content??'{}')).toEqual({templateName:'ilk_mesaj',languageCode:'tr',variables:['Yeni Müşteri','Web sitesi']}); expect(message?.delivery_status).toBe('queued');
  });

  it('enforces the 24-hour window and stores valid PDF uploads privately in R2', async () => {
    const auth=await setupAdmin(); const old=await seedConversation({phone:'+905321110001',lastInbound:new Date(Date.now()-25*60*60_000).toISOString()});
    const closed=await request(`/api/conversations/${old.conversationId}/attachments`,{method:'POST',headers:{Cookie:auth.cookie,'X-CSRF-Token':auth.csrf},body:new FormData()}); expect(closed.status).toBe(409);
    const open=await seedConversation({phone:'+905321110002'}); const form=new FormData(); form.set('file',new File([new Uint8Array([0x25,0x50,0x44,0x46,0x2d])],'teklif.pdf',{type:'application/pdf'}));
    const uploaded=await request(`/api/conversations/${open.conversationId}/attachments`,{method:'POST',headers:{Cookie:auth.cookie,'X-CSRF-Token':auth.csrf},body:form}); expect(uploaded.status).toBe(201);
    const result=(await json<any>(uploaded)).data; const attachment=await env.DB.prepare('SELECT r2_key,mime_type,scan_status FROM attachments WHERE id=?').bind(result.attachmentId).first<{r2_key:string;mime_type:string;scan_status:string}>();
    expect(attachment).toMatchObject({mime_type:'application/pdf',scan_status:'clean'}); expect(await env.FILES.get(attachment!.r2_key)).not.toBeNull();
  });
});

describe('knowledge, catalog, AI and operational endpoints', () => {
  it('creates and updates knowledge, services and prices with every business field', async () => {
    const auth=await setupAdmin();
    const knowledge=await request('/api/knowledge',{method:'POST',headers:authHeaders(auth),body:JSON.stringify({title:'Teslim Süreci',category:'Süreç',content:'Kapsam onayından sonra geliştirme başlar.',status:'draft',usagePermission:'both'})}); expect(knowledge.status).toBe(201); const knowledgeId=(await json<any>(knowledge)).data.id;
    const approved=await request(`/api/knowledge/${knowledgeId}`,{method:'PUT',headers:authHeaders(auth),body:JSON.stringify({title:'Teslim Süreci',category:'Süreç',content:'Kapsam onayından sonra geliştirme başlar.',status:'approved',usagePermission:'both'})}); expect(approved.status).toBe(200);
    const row=await env.DB.prepare('SELECT status,usage_permission,vector_status,vector_version FROM business_knowledge WHERE id=?').bind(knowledgeId).first(); expect(row).toMatchObject({status:'approved',usage_permission:'both',vector_status:'pending',vector_version:0});
    const vectorJob=await env.DB.prepare('SELECT operation,target,status FROM vector_sync_jobs WHERE knowledge_id=? ORDER BY created_at DESC LIMIT 1').bind(knowledgeId).first(); expect(vectorJob).toMatchObject({operation:'upsert',target:'cloud',status:'queued'});
    const service=await request('/api/catalog/services',{method:'POST',headers:authHeaders(auth),body:JSON.stringify({name:'Kurumsal Web',description:'Özel tasarım kurumsal web sitesi',status:'approved',features:['Responsive','Admin paneli']})}); expect(service.status).toBe(201); const serviceId=(await json<any>(service)).data.id;
    const price=await request('/api/catalog/prices',{method:'POST',headers:authHeaders(auth),body:JSON.stringify({serviceId,title:'Kurumsal paket',amountMin:10000,amountMax:15000,currencyCode:'try',status:'approved',rule:{includes:['design']}})}); expect(price.status).toBe(201);
    const catalog=(await json<any>(await request('/api/catalog',{headers:{Cookie:auth.cookie}}))).data; expect(catalog.services[0]).toMatchObject({id:serviceId,status:'approved'}); expect(JSON.parse(catalog.services[0].features_json)).toEqual(['Responsive','Admin paneli']); expect(catalog.prices[0]).toMatchObject({amount_min:10000,amount_max:15000,currency_code:'TRY',status:'approved'});
  });

  it('saves all AI settings, emergency-stops jobs, chats and creates training records', async () => {
    const auth=await setupAdmin(); const seeded=await seedConversation(); const sourceId=crypto.randomUUID(); const jobId=crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO messages (id,conversation_id,contact_id,direction,sender_type,message_type,text_content,delivery_status,received_at,created_at) VALUES (?,?,?,'inbound','customer','text','Merhaba','delivered',?,?)").bind(sourceId,seeded.conversationId,seeded.contactId,seeded.now,seeded.now),
      env.DB.prepare("INSERT INTO ai_jobs (id,conversation_id,contact_id,source_message_id,status,expected_context_version,created_at,updated_at) VALUES (?,?,?,?,'queued',0,?,?)").bind(jobId,seeded.conversationId,seeded.contactId,sourceId,seeded.now,seeded.now)
    ]);
    const settingsPayload={globalMode:'auto',autoReplyEnabled:true,suggestionMode:true,businessInstructions:'Yalnız onaylı bilgiyi kullan.',handoffRules:['Pazarlık','Hukuki soru'],minimumConfidence:.91,recentMessageCount:12,debounceSeconds:9};
    expect((await request('/api/ai/settings',{method:'PUT',headers:authHeaders(auth),body:JSON.stringify(settingsPayload)})).status).toBe(200);
    const settings=(await json<any>(await request('/api/ai/settings',{headers:{Cookie:auth.cookie}}))).data; expect(settings).toMatchObject(settingsPayload);
    const stopped=await request('/api/ai/emergency-stop',{method:'POST',headers:authHeaders(auth)}); expect(stopped.status).toBe(200); expect((await env.DB.prepare('SELECT status FROM ai_jobs WHERE id=?').bind(jobId).first<{status:string}>())?.status).toBe('cancelled');
    vi.spyOn(env.AI,'run').mockResolvedValue({response:'Onaylı bilgi dışına çıkmadan yanıt verin.'} as never);
    const chat=await request('/api/ai/assistant',{method:'POST',headers:authHeaders(auth),body:JSON.stringify({message:'Fiyat sorulursa ne yapmalıyım?',conversationId:seeded.conversationId})}); expect(chat.status).toBe(200); const chatData=(await json<any>(chat)).data;
    const thread=(await json<any>(await request(`/api/ai/assistant/threads/${chatData.threadId}`,{headers:{Cookie:auth.cookie}}))).data; expect(thread.messages.map((item:any)=>item.role)).toEqual(['admin','assistant']);
    const training=await request('/api/ai/training',{method:'POST',headers:authHeaders(auth),body:JSON.stringify({title:'Fiyat güvenliği',category:'Satış',content:'Onaylı fiyat yoksa kesin rakam vermeden insana devret.',usagePermission:'both',approve:false,sourceThreadId:chatData.threadId})}); expect(training.status).toBe(201); expect((await env.DB.prepare('SELECT status,source_type,usage_permission FROM business_knowledge WHERE id=?').bind((await json<any>(training)).data.id).first())).toMatchObject({status:'draft',source_type:'admin_chat',usage_permission:'both'});
  });

  it('returns dashboard, reports, files, notifications and settings with their required fields', async () => {
    const auth=await setupAdmin(); const seeded=await seedConversation(); const notificationId=crypto.randomUUID();
    await env.DB.prepare("INSERT INTO admin_notifications (id,type,priority,status,contact_id,conversation_id,title,body,created_at,updated_at) VALUES (?,'follow_up','normal','unread',?,?,'Ara','Müşteriyi ara',?,?)").bind(notificationId,seeded.contactId,seeded.conversationId,seeded.now,seeded.now).run();
    const dashboard=(await json<any>(await request('/api/dashboard',{headers:{Cookie:auth.cookie}}))).data; expect(dashboard).toMatchObject({contacts:1,activeConversations:1,unreadMessages:3,unreadNotifications:1});
    const reports=(await json<any>(await request('/api/reports/overview',{headers:{Cookie:auth.cookie}}))).data; expect(reports).toHaveProperty('daily'); expect(reports).toHaveProperty('delivery'); expect(reports).toHaveProperty('leadStages');
    const files=(await json<any>(await request('/api/files',{headers:{Cookie:auth.cookie}}))).data; expect(files).toEqual([]);
    const notifications=(await json<any>(await request('/api/notifications',{headers:{Cookie:auth.cookie}}))).data; expect(notifications[0]).toMatchObject({id:notificationId,status:'unread',priority:'normal'});
    expect((await request(`/api/notifications/${notificationId}/status`,{method:'PUT',headers:authHeaders(auth),body:JSON.stringify({status:'completed'})})).status).toBe(200);
    const settings=(await json<any>(await request('/api/settings',{headers:{Cookie:auth.cookie}}))).data; expect(settings).toMatchObject({timezone:'Europe/Istanbul',aiModel:'@cf/meta/llama-3.1-8b-instruct-fp8-fast',embeddingModel:'@cf/baai/bge-m3'}); expect(settings).toHaveProperty('branding'); expect(settings).toHaveProperty('meta');
  });
});
