import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { runScheduled } from '../../src/worker/index';
import { resetBusinessData } from './helpers';

beforeEach(async()=>{await resetBusinessData();});

describe('scheduled maintenance',()=>{
  it('creates one notification per due follow-up and removes only old login attempts',async()=>{
    const contactId=crypto.randomUUID(),conversationId=crypto.randomUUID(),taskId=crypto.randomUUID();const now=new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO contacts (id,phone_e164,display_name,country_code,source,status,created_at,updated_at) VALUES (?,?,?,'TR','test','lead',?,?)").bind(contactId,'+905327770001','Takip Test',now,now),
      env.DB.prepare("INSERT INTO conversations (id,contact_id,status,ai_mode,created_at,updated_at) VALUES (?,?,'open','off',?,?)").bind(conversationId,contactId,now,now),
      env.DB.prepare("INSERT INTO follow_up_tasks (id,contact_id,conversation_id,title,due_at,status,created_at,updated_at) VALUES (?,?,?,'Müşteriyi ara',?,'pending',?,?)").bind(taskId,contactId,conversationId,new Date(Date.now()-60_000).toISOString(),now,now),
      env.DB.prepare("INSERT INTO login_attempts (id,email_hash,ip_hash,success,created_at) VALUES (?,'old','old',0,datetime('now','-3 days'))").bind(crypto.randomUUID()),
      env.DB.prepare("INSERT INTO login_attempts (id,email_hash,ip_hash,success,created_at) VALUES (?,'new','new',1,datetime('now','-1 hour'))").bind(crypto.randomUUID())
    ]);
    await runScheduled(env);await runScheduled(env);
    const notifications=await env.DB.prepare("SELECT COUNT(*) AS count FROM admin_notifications WHERE deduplication_key=?").bind(`followup:${taskId}`).first<{count:number}>();expect(notifications?.count).toBe(1);
    const remaining=await env.DB.prepare('SELECT email_hash FROM login_attempts ORDER BY email_hash').all<{email_hash:string}>();expect(remaining.results).toEqual([{email_hash:'new'}]);
  });

  it('does not notify for future or completed follow-ups',async()=>{
    const contactId=crypto.randomUUID();const now=new Date().toISOString();
    await env.DB.prepare("INSERT INTO contacts (id,phone_e164,display_name,country_code,source,status,created_at,updated_at) VALUES (?,?,?,'TR','test','lead',?,?)").bind(contactId,'+905327770002','Gelecek Test',now,now).run();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO follow_up_tasks (id,contact_id,title,due_at,status,created_at,updated_at) VALUES (?,?,'Gelecek',?,'pending',?,?)").bind(crypto.randomUUID(),contactId,new Date(Date.now()+3600_000).toISOString(),now,now),
      env.DB.prepare("INSERT INTO follow_up_tasks (id,contact_id,title,due_at,status,created_at,updated_at) VALUES (?,?,'Tamam',?,'completed',?,?)").bind(crypto.randomUUID(),contactId,new Date(Date.now()-3600_000).toISOString(),now,now)
    ]);
    await runScheduled(env);expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM admin_notifications WHERE type='follow_up'").first<{count:number}>())?.count).toBe(0);
  });
});
