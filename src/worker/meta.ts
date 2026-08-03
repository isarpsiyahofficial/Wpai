import type { Env } from './types';
import { decryptSecret, encryptSecret } from './crypto';
import { first, run, nowIso } from './db';

export type MetaCredentials = {
  accessToken: string;
  appSecret: string;
  phoneNumberId: string;
  businessAccountId: string;
  verifyToken: string;
  adminWhatsAppPhone?: string | undefined;
};

export async function saveMetaCredentials(env: Env, credentials: MetaCredentials, adminId: string): Promise<void> {
  const encrypted = await encryptSecret(JSON.stringify(credentials), env.DATA_ENCRYPTION_KEY);
  await run(env.DB,
    `INSERT INTO integration_credentials (provider, encrypted_payload, status, metadata_json, verified_at, updated_at, updated_by)
     VALUES ('meta_whatsapp', ?, 'configured', '{}', NULL, ?, ?)
     ON CONFLICT(provider) DO UPDATE SET encrypted_payload = excluded.encrypted_payload, status = 'configured', updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    encrypted, nowIso(), adminId
  );
}

export async function getMetaCredentials(env: Env): Promise<MetaCredentials | null> {
  const row = await first<{ encrypted_payload: string; status: string }>(env.DB,
    "SELECT encrypted_payload, status FROM integration_credentials WHERE provider = 'meta_whatsapp' LIMIT 1"
  );
  if (!row || row.status === 'removed') return null;
  return JSON.parse(await decryptSecret(row.encrypted_payload, env.DATA_ENCRYPTION_KEY)) as MetaCredentials;
}

export async function metaStatus(env: Env): Promise<{ configured: boolean; status: string; verifiedAt: string | null; phoneNumberIdMasked?: string }> {
  const row = await first<{ status: string; verified_at: string | null; metadata_json: string }>(env.DB,
    "SELECT status, verified_at, metadata_json FROM integration_credentials WHERE provider = 'meta_whatsapp' LIMIT 1"
  );
  if (!row) return { configured: false, status: 'not_configured', verifiedAt: null };
  let phoneNumberIdMasked: string | undefined;
  try { phoneNumberIdMasked = (JSON.parse(row.metadata_json) as { phoneNumberIdMasked?: string }).phoneNumberIdMasked; } catch { /* safe */ }
  return { configured: row.status !== 'removed', status: row.status, verifiedAt: row.verified_at, ...(phoneNumberIdMasked ? { phoneNumberIdMasked } : {}) };
}

export async function verifyMeta(env: Env): Promise<{ displayPhoneNumber?: string; verifiedName?: string }> {
  const credentials = await getMetaCredentials(env);
  if (!credentials) throw new Error('META_NOT_CONFIGURED');
  const response = await fetch(`https://graph.facebook.com/${env.META_GRAPH_API_VERSION}/${encodeURIComponent(credentials.phoneNumberId)}?fields=display_phone_number,verified_name`, {
    headers: { Authorization: `Bearer ${credentials.accessToken}` }
  });
  if (!response.ok) throw new Error(`META_VERIFY_FAILED_${response.status}`);
  const data = await response.json<{ display_phone_number?: string; verified_name?: string }>();
  await run(env.DB,
    "UPDATE integration_credentials SET status = 'configured', verified_at = ?, metadata_json = ? WHERE provider = 'meta_whatsapp'",
    nowIso(), JSON.stringify({ phoneNumberIdMasked: credentials.phoneNumberId.slice(-6), displayPhoneNumber: data.display_phone_number, verifiedName: data.verified_name })
  );
  return { ...(data.display_phone_number ? { displayPhoneNumber: data.display_phone_number } : {}), ...(data.verified_name ? { verifiedName: data.verified_name } : {}) };
}

export async function setMetaPaused(env: Env, paused: boolean): Promise<void> {
  await run(env.DB, "UPDATE integration_credentials SET status = ?, updated_at = ? WHERE provider = 'meta_whatsapp'", paused ? 'paused' : 'configured', nowIso());
}

export async function removeMeta(env: Env): Promise<void> {
  await run(env.DB, "UPDATE integration_credentials SET encrypted_payload = '', status = 'removed', metadata_json = '{}', verified_at = NULL, updated_at = ? WHERE provider = 'meta_whatsapp'", nowIso());
}

export async function verifyWebhookSignature(appSecret: string, rawBody: ArrayBuffer, signatureHeader: string | null): Promise<boolean> {
  if (!signatureHeader?.startsWith('sha256=')) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(appSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, rawBody));
  const actual = signatureHeader.slice(7).toLowerCase();
  const expected = [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i += 1) diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export async function sendMetaMessage(env: Env, phone: string, payload: Record<string, unknown>): Promise<{ id: string }> {
  const credentials = await getMetaCredentials(env);
  if (!credentials) throw new Error('META_NOT_CONFIGURED');
  const status = await metaStatus(env);
  if (status.status !== 'configured') throw new Error('META_CONNECTION_PAUSED');
  const response = await fetch(`https://graph.facebook.com/${env.META_GRAPH_API_VERSION}/${encodeURIComponent(credentials.phoneNumberId)}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${credentials.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to: phone.replace(/^\+/, ''), ...payload })
  });
  const data = await response.json<{ messages?: Array<{ id: string }>; error?: { code?: number; message?: string } }>();
  if (!response.ok || !data.messages?.[0]) throw new Error(`META_SEND_FAILED_${data.error?.code ?? response.status}`);
  return { id: data.messages[0].id };
}
