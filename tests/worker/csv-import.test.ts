import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { authHeaders, json, request, resetBusinessData, setupAdmin } from './helpers';

beforeEach(async () => { await resetBusinessData(); });

describe('CSV contact import', () => {
  it('previews duplicates, invalid, existing and opt-out rows before committing eligible contacts', async () => {
    const auth = await setupAdmin();
    const now = new Date().toISOString();
    const existingId = crypto.randomUUID();
    const optOutId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO contacts (id,phone_e164,display_name,country_code,source,status,created_at,updated_at) VALUES (?,?,?,'TR','test','lead',?,?)").bind(existingId, '+905322222222', 'Existing', now, now),
      env.DB.prepare("INSERT INTO contacts (id,phone_e164,display_name,country_code,source,status,created_at,updated_at) VALUES (?,?,?,'TR','test','lead',?,?)").bind(optOutId, '+905323333333', 'Opt Out', now, now),
      env.DB.prepare("INSERT INTO opt_outs (id,contact_id,scope,reason,created_at) VALUES (?,?,'marketing','test',?)").bind(crypto.randomUUID(), optOutId, now)
    ]);
    const csv = [
      'telefon;isim;firma;sehir;not',
      '05321111111;Alice;Acme;Antalya;',
      '5321111111;Alice Duplicate;;;;',
      'bad;Invalid;;;;',
      '+905322222222;Existing;;;;',
      '+905323333333;Opted;;;;',
      '+905324444444;New Note;Nova;İstanbul;Müşteri kurumsal site istiyor'
    ].join('\n');

    const preview = await request('/api/contacts/import-csv', {
      method: 'POST', headers: authHeaders(auth), body: JSON.stringify({ csv, defaultCountryCode: 'TR', commit: false })
    });
    expect(preview.status).toBe(200);
    expect((await json<any>(preview)).data).toMatchObject({
      totalRows: 6, validUnique: 4, duplicateInFile: 1, alreadyRegistered: 1,
      optOutExcluded: 1, eligible: 2, committed: 0
    });

    const committed = await request('/api/contacts/import-csv', {
      method: 'POST', headers: authHeaders(auth), body: JSON.stringify({ csv, defaultCountryCode: 'TR', commit: true })
    });
    expect(committed.status).toBe(200);
    expect((await json<any>(committed)).data.committed).toBe(2);
    const contacts = await env.DB.prepare("SELECT phone_e164,country_code FROM contacts WHERE source='csv' ORDER BY phone_e164").all<{ phone_e164:string;country_code:string }>();
    expect(contacts.results).toEqual([
      { phone_e164: '+905321111111', country_code: 'TR' },
      { phone_e164: '+905324444444', country_code: 'TR' }
    ]);
    const note = await env.DB.prepare("SELECT note_text,source FROM customer_notes WHERE note_text LIKE 'Müşteri kurumsal%'").first<{ note_text:string;source:string }>();
    expect(note).toEqual({ note_text: 'Müşteri kurumsal site istiyor', source: 'admin' });
  });
});
