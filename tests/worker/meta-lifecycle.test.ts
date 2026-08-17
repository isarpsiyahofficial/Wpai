import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { authHeaders, json, request, resetBusinessData, setupAdmin } from './helpers';

const credentials={
  accessToken:'meta-access-token-for-integration-tests-123456',
  appSecret:'meta-app-secret-for-integration-tests-123456',
  phoneNumberId:'123456789012345',
  businessAccountId:'987654321098765',
  verifyToken:'meta-webhook-verify-token-123456789',
  adminWhatsAppPhone:'+905321234567'
};

beforeEach(async()=>{await resetBusinessData();});
afterEach(()=>vi.unstubAllGlobals());

describe('Meta WhatsApp connection lifecycle',()=>{
  it('encrypts credentials, verifies the phone, pauses/resumes and removes the connection',async()=>{
    const auth=await setupAdmin();
    const calls:string[]=[];
    vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL)=>{
      const url=String(input);calls.push(url);
      return new Response(JSON.stringify({display_phone_number:'+90 532 123 45 67',verified_name:'WPAI Test'}),{status:200,headers:{'Content-Type':'application/json'}});
    }));
    const saved=await request('/api/meta/credentials',{method:'PUT',headers:authHeaders(auth),body:JSON.stringify(credentials)});expect(saved.status).toBe(200);
    const stored=await env.DB.prepare("SELECT encrypted_payload,status FROM integration_credentials WHERE provider='meta_whatsapp'").first<{encrypted_payload:string;status:string}>();
    expect(stored?.status).toBe('configured');expect(stored?.encrypted_payload).not.toContain(credentials.accessToken);expect(stored?.encrypted_payload).not.toContain(credentials.appSecret);expect(()=>JSON.parse(stored?.encrypted_payload??'')).toThrow();
    const preStatus=(await json<any>(await request('/api/meta/status',{headers:{Cookie:auth.cookie}}))).data;expect(preStatus).toMatchObject({configured:true,status:'configured',verifiedAt:null});
    const verified=await request('/api/meta/verify',{method:'POST',headers:authHeaders(auth)});expect(verified.status).toBe(200);expect((await json<any>(verified)).data).toEqual({displayPhoneNumber:'+90 532 123 45 67',verifiedName:'WPAI Test'});expect(calls[0]).toContain('/v23.0/123456789012345?fields=');
    expect((await env.DB.prepare("SELECT value_json FROM system_settings WHERE key='meta_connection_enabled'").first<{value_json:string}>())?.value_json).toBe('true');
    const verifiedStatus=(await json<any>(await request('/api/meta/status',{headers:{Cookie:auth.cookie}}))).data;expect(verifiedStatus.configured).toBe(true);expect(verifiedStatus.phoneNumberIdMasked).toBe('012345');expect(verifiedStatus.verifiedAt).toBeTruthy();
    expect((await request('/api/meta/pause',{method:'POST',headers:authHeaders(auth),body:JSON.stringify({paused:true})})).status).toBe(200);expect((await json<any>(await request('/api/meta/status',{headers:{Cookie:auth.cookie}}))).data.status).toBe('paused');
    expect((await request('/api/meta/pause',{method:'POST',headers:authHeaders(auth),body:JSON.stringify({paused:false})})).status).toBe(200);expect((await json<any>(await request('/api/meta/status',{headers:{Cookie:auth.cookie}}))).data.status).toBe('configured');
    expect((await request('/api/meta/credentials',{method:'DELETE',headers:authHeaders(auth)})).status).toBe(200);const removed=(await json<any>(await request('/api/meta/status',{headers:{Cookie:auth.cookie}}))).data;expect(removed).toMatchObject({configured:false,status:'removed',verifiedAt:null});
    const row=await env.DB.prepare("SELECT encrypted_payload,metadata_json FROM integration_credentials WHERE provider='meta_whatsapp'").first<{encrypted_payload:string;metadata_json:string}>();expect(row).toEqual({encrypted_payload:'',metadata_json:'{}'});
  });

  it('synchronizes every Meta template field and updates an existing template without duplicates',async()=>{
    const auth=await setupAdmin();
    await request('/api/meta/credentials',{method:'PUT',headers:authHeaders(auth),body:JSON.stringify(credentials)});
    let version=1;
    vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({data:[{name:'ilk_mesaj',language:'tr',category:'MARKETING',status:'APPROVED',components:[{type:'BODY',text:version===1?'Merhaba {{1}}':'Selam {{1}}'}]}]}),{status:200,headers:{'Content-Type':'application/json'}})));
    const firstSync=await request('/api/templates/sync',{method:'POST',headers:authHeaders(auth)});expect(firstSync.status).toBe(200);expect((await json<any>(firstSync)).data.count).toBe(1);
    version=2;const secondSync=await request('/api/templates/sync',{method:'POST',headers:authHeaders(auth)});expect(secondSync.status).toBe(200);
    const rows=(await json<any>(await request('/api/templates',{headers:{Cookie:auth.cookie}}))).data;expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({meta_name:'ilk_mesaj',language_code:'tr',category:'MARKETING',status:'APPROVED'});expect(JSON.parse(rows[0].components_json)[0].text).toBe('Selam {{1}}');
    const audit=await env.DB.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action='meta.templates_synced'").first<{count:number}>();expect(audit?.count).toBe(2);
  });

  it('does not enable Meta when Graph verification fails',async()=>{
    const auth=await setupAdmin();await request('/api/meta/credentials',{method:'PUT',headers:authHeaders(auth),body:JSON.stringify(credentials)});
    vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({error:{code:190}}),{status:401,headers:{'Content-Type':'application/json'}})));
    const response=await request('/api/meta/verify',{method:'POST',headers:authHeaders(auth)});expect(response.status).toBe(500);
    expect((await env.DB.prepare("SELECT value_json FROM system_settings WHERE key='meta_connection_enabled'").first<{value_json:string}>())?.value_json).toBe('false');
  });
});
