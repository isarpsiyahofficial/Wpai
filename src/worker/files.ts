import type { Env } from './types';
import { run, nowIso } from './db';

const allowed = new Map<string, string[]>([
  ['image/png', ['89504e470d0a1a0a']],
  ['image/jpeg', ['ffd8ff']],
  ['image/webp', ['52494646']],
  ['application/pdf', ['25504446']],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', ['504b0304']],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ['504b0304']],
  ['text/csv', []],
  ['text/plain', []]
]);

function hex(bytes: Uint8Array): string { return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join(''); }
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer { const copy = new Uint8Array(bytes.byteLength); copy.set(bytes); return copy.buffer; }

export function validateFileSignature(mime: string, bytes: Uint8Array): boolean {
  const signatures = allowed.get(mime);
  if (!signatures) return false;
  if (!signatures.length) {
    const sample = bytes.slice(0, Math.min(bytes.length, 2048));
    return !sample.some(byte => byte === 0);
  }
  const prefix = hex(bytes.slice(0, 16));
  if (mime === 'image/webp') return prefix.startsWith('52494646') && new TextDecoder().decode(bytes.slice(8, 12)) === 'WEBP';
  return signatures.some(signature => prefix.startsWith(signature));
}

export async function storeAttachment(
  env: Env,
  input: { conversationId: string; contactId: string; originalName: string; mimeType: string; bytes: Uint8Array; source: 'customer' | 'admin' | 'knowledge' | 'import' | 'system'; adminId?: string }
): Promise<{ id: string; r2Key: string; sha256: string }> {
  if (!validateFileSignature(input.mimeType, input.bytes)) throw new Error('FILE_SIGNATURE_REJECTED');
  const max = 25 * 1024 * 1024;
  if (input.bytes.byteLength > max) throw new Error('FILE_TOO_LARGE');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', toArrayBuffer(input.bytes)));
  const sha256 = hex(digest);
  const id = crypto.randomUUID();
  const extension = safeExtension(input.originalName);
  const r2Key = `attachments/${input.conversationId}/${id}${extension}`;
  await env.FILES.put(r2Key, input.bytes, {
    httpMetadata: { contentType: input.mimeType, cacheControl: 'private, no-store' },
    customMetadata: { conversationId: input.conversationId, contactId: input.contactId, sha256 }
  });
  await run(env.DB,
    `INSERT INTO attachments (id, conversation_id, contact_id, r2_key, original_name, safe_name, mime_type, size_bytes, sha256, source, uploaded_by_admin_id, scan_status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'clean', ?)`,
    id, input.conversationId, input.contactId, r2Key, input.originalName.slice(0, 255), `${id}${extension}`, input.mimeType, input.bytes.byteLength, sha256, input.source, input.adminId ?? null, nowIso()
  );
  return { id, r2Key, sha256 };
}

function safeExtension(name: string): string {
  const match = name.toLowerCase().match(/\.(png|jpe?g|webp|pdf|docx|xlsx|csv|txt)$/);
  return match ? match[0] : '';
}
