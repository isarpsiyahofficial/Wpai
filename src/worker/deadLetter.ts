import type { DeadLetterJob, Env } from './types';
import { first, nowIso, run } from './db';

export async function consumeDeadLetterBatch(batch: MessageBatch<DeadLetterJob>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    const body = message.body;
    const id = crypto.randomUUID();
    const safePayload = redactSecrets(body.originalJob);
    const now = nowIso();
    try {
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO dead_letter_jobs
            (id,source_queue,payload_json,error_code,status,attempts,failed_at,created_at)
           VALUES (?,?,?,?,'pending',0,?,?)`
        ).bind(id, body.sourceQueue.slice(0, 100), JSON.stringify(safePayload).slice(0, 500_000), safeCode(body.errorCode), body.failedAt || now, now),
        env.DB.prepare(
          `INSERT INTO admin_notifications
            (id,type,priority,status,title,body,deduplication_key,created_at,updated_at)
           VALUES (?,'system_error','high','unread','Kuyruk işi başarısız',?,?,?,?)`
        ).bind(crypto.randomUUID(), `${body.sourceQueue}: ${safeCode(body.errorCode)}`, `dlq:${id}`, now, now)
      ]);
      message.ack();
    } catch {
      message.retry({ delaySeconds: 60 });
    }
  }
}

export async function retryDeadLetter(env: Env, id: string): Promise<{ sourceQueue: string }> {
  const row = await first<{ source_queue: string; payload_json: string; status: string }>(env.DB,
    "SELECT source_queue,payload_json,status FROM dead_letter_jobs WHERE id=? AND status IN ('pending','retrying')", id);
  if (!row) throw new Error('DEAD_LETTER_NOT_RETRYABLE');
  const payload = parseRecord(row.payload_json);
  await run(env.DB,
    "UPDATE dead_letter_jobs SET status='retrying',attempts=attempts+1,retried_at=? WHERE id=?",
    nowIso(), id);
  try {
    await sendToSourceQueue(env, row.source_queue, payload);
    await run(env.DB,
      "UPDATE dead_letter_jobs SET status='resolved',resolved_at=? WHERE id=?",
      nowIso(), id);
    return { sourceQueue: row.source_queue };
  } catch (error) {
    await run(env.DB,
      "UPDATE dead_letter_jobs SET status='pending',error_code=? WHERE id=?",
      safeCode(error), id);
    throw error;
  }
}

async function sendToSourceQueue(env: Env, sourceQueue: string, payload: Record<string, unknown>): Promise<void> {
  if (sourceQueue === 'wa-inbound-ai') {
    const job = {
      jobId: requiredString(payload, 'jobId'),
      conversationId: requiredString(payload, 'conversationId'),
      contactId: requiredString(payload, 'contactId'),
      sourceMessageId: requiredString(payload, 'sourceMessageId'),
      expectedLastMessageId: requiredString(payload, 'expectedLastMessageId'),
      enqueuedAt: nowIso()
    };
    await env.INBOUND_AI.send(job);
    return;
  }
  if (sourceQueue === 'wa-outbound') {
    const kind = requiredString(payload, 'kind');
    if (!['text', 'media', 'template'].includes(kind)) throw new Error('DLQ_OUTBOUND_KIND_INVALID');
    const expected = optionalString(payload, 'expectedAiDecisionId');
    await env.OUTBOUND.send({
      jobId: requiredString(payload, 'jobId'),
      conversationId: requiredString(payload, 'conversationId'),
      contactId: requiredString(payload, 'contactId'),
      messageId: requiredString(payload, 'messageId'),
      kind: kind as 'text' | 'media' | 'template',
      ...(expected ? { expectedAiDecisionId: expected } : {}),
      enqueuedAt: nowIso()
    });
    return;
  }
  if (sourceQueue === 'wa-admin-notify') {
    const conversationId = optionalString(payload, 'conversationId');
    await env.ADMIN_NOTIFY.send({
      jobId: requiredString(payload, 'jobId'),
      notificationId: requiredString(payload, 'notificationId'),
      ...(conversationId ? { conversationId } : {}),
      enqueuedAt: nowIso()
    });
    return;
  }
  if (sourceQueue === 'wa-knowledge-index') {
    const operation = requiredString(payload, 'operation');
    const target = requiredString(payload, 'target');
    if (!['upsert', 'delete', 'rebuild', 'clear'].includes(operation)) throw new Error('DLQ_VECTOR_OPERATION_INVALID');
    if (!['cloud', 'local', 'both'].includes(target)) throw new Error('DLQ_VECTOR_TARGET_INVALID');
    await env.KNOWLEDGE_SYNC.send({
      jobId: requiredString(payload, 'jobId'),
      knowledgeId: optionalString(payload, 'knowledgeId'),
      operation: operation as 'upsert' | 'delete' | 'rebuild' | 'clear',
      target: target as 'cloud' | 'local' | 'both',
      expectedVersion: optionalNumber(payload, 'expectedVersion'),
      checksum: optionalString(payload, 'checksum'),
      enqueuedAt: nowIso()
    });
    return;
  }
  throw new Error('DEAD_LETTER_SOURCE_QUEUE_REJECTED');
}

function parseRecord(value: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error('DEAD_LETTER_PAYLOAD_INVALID'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('DEAD_LETTER_PAYLOAD_INVALID');
  return parsed as Record<string, unknown>;
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== 'string' || !field || field.length > 500) throw new Error(`DLQ_FIELD_${key.toUpperCase()}_INVALID`);
  return field;
}
function optionalString(value: Record<string, unknown>, key: string): string | null {
  const field = value[key];
  return typeof field === 'string' && field.length <= 500 ? field : null;
}
function optionalNumber(value: Record<string, unknown>, key: string): number | null {
  const field = value[key];
  return typeof field === 'number' && Number.isFinite(field) ? field : null;
}

function redactSecrets(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[MAX_DEPTH]';
  if (Array.isArray(value)) return value.slice(0, 200).map(item => redactSecrets(item, depth + 1));
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string') return value.slice(0, 20_000);
    return value;
  }
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 200)) {
    if (/token|secret|password|authorization|cookie|credential|api[_-]?key/i.test(key)) output[key] = '[REDACTED]';
    else output[key] = redactSecrets(item, depth + 1);
  }
  return output;
}

function safeCode(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/[^A-Z0-9_:-]/gi, '_').slice(0, 200) || 'UNKNOWN_QUEUE_ERROR';
}
