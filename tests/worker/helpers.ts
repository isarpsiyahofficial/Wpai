import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import worker from '../../src/worker/index';

export const TEST_PASSWORD = 'GüvenliParola123';
export const TEST_EMAIL = 'owner@example.com';

export async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`https://wpai.test${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

export async function json<T>(response: Response): Promise<T> { return await response.json<T>(); }

export async function setupAdmin(): Promise<{ cookie: string; csrf: string; adminId: string }> {
  const response = await request('/api/auth/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'WPAI-Test' },
    body: JSON.stringify({
      name: 'Test Owner', email: TEST_EMAIL, password: TEST_PASSWORD,
      bootstrapToken: 'test-bootstrap-token-1234567890'
    })
  });
  if (response.status !== 201) throw new Error(`SETUP_FAILED_${response.status}_${await response.text()}`);
  const payload = await json<{ ok: true; data: { admin: { id: string }; csrfToken: string } }>(response);
  const setCookie = response.headers.get('Set-Cookie') ?? '';
  const cookie = setCookie.split(';')[0] ?? '';
  return { cookie, csrf: payload.data.csrfToken, adminId: payload.data.admin.id };
}

export function authHeaders(auth: { cookie: string; csrf: string }, jsonContent = true): HeadersInit {
  return { Cookie: auth.cookie, 'X-CSRF-Token': auth.csrf, ...(jsonContent ? { 'Content-Type': 'application/json' } : {}) };
}

export async function resetBusinessData(): Promise<void> {
  const tables = [
    'source_knowledge_links',
    'knowledge_vector_artifacts',
    'vector_sync_jobs',
    'retrieval_logs',
    'training_item_publications',
    'knowledge_versions',
    'knowledge_source_extractions',
    'knowledge_sources',
    'ai_training_items',
    'ai_training_thread_state',
    'admin_ai_messages',
    'admin_ai_threads',
    'desktop_sessions',
    'desktop_devices',
    'desktop_activation_tokens',
    'csv_import_rows',
    'csv_imports',
    'dead_letter_jobs',
    'canned_replies',
    'infrastructure_snapshots',
    'integration_credentials',
    'webhook_events',
    'audit_logs',
    'follow_up_tasks',
    'admin_notifications',
    'human_handoffs',
    'ai_decisions',
    'ai_usage_records',
    'ai_jobs',
    'opt_outs',
    'campaign_recipients',
    'campaigns',
    'message_status_events',
    'messages',
    'message_templates',
    'knowledge_chunks',
    'business_knowledge',
    'pricing_rules',
    'service_catalog',
    'customer_requirements',
    'customer_notes',
    'conversation_summaries',
    'attachments',
    'conversations',
    'contact_tags',
    'tags',
    'contacts',
    'login_attempts',
    'admin_sessions',
    'admins'
  ];
  for (const table of tables) await env.DB.prepare(`DELETE FROM ${table}`).run();
  await env.DB.prepare("UPDATE system_settings SET value_json='\"off\"' WHERE key='ai_global_mode'").run();
  await env.DB.prepare("UPDATE system_settings SET value_json='false' WHERE key='ai_auto_reply_enabled'").run();
  await env.DB.prepare("UPDATE system_settings SET value_json='true' WHERE key='ai_suggestion_mode'").run();
  await env.DB.prepare("UPDATE system_settings SET value_json='false' WHERE key='meta_connection_enabled'").run();
  await env.DB.prepare("UPDATE system_settings SET value_json='false' WHERE key='admin_notifications_enabled'").run();
}
