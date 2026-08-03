import type { Env, KnowledgeSyncJob } from './types';
import { all, first, nowIso, run } from './db';
import { chunkText, embed } from './ai';

export type VectorSyncOperation = 'upsert' | 'delete' | 'rebuild' | 'clear';

type ArtifactRow = {
  r2_key: string;
  knowledge_version: number;
  checksum: string;
  vector_count: number;
};

type LocalVector = {
  id: string;
  vector: number[];
  metadata: Record<string, string | number>;
};

export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', buffer));
  return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function enqueueKnowledgeSync(
  env: Env,
  input: {
    knowledgeId?: string | null;
    operation: VectorSyncOperation;
    target?: 'cloud' | 'local' | 'both';
    version?: number | null;
    checksum?: string | null;
    adminId?: string | null;
  }
): Promise<{ jobId: string; duplicate: boolean }> {
  const now = nowIso();
  const target = input.target ?? 'both';
  const identity = `${input.operation}:${target}:${input.knowledgeId ?? 'all'}:${input.version ?? 0}:${input.checksum ?? ''}`;
  const idempotencyKey = await sha256Hex(identity);
  const existing = await first<{ id: string; status: string }>(env.DB,
    'SELECT id,status FROM vector_sync_jobs WHERE idempotency_key=? LIMIT 1', idempotencyKey);
  if (existing) {
    if (existing.status === 'failed' || existing.status === 'dead_letter') {
      await run(env.DB,
        "UPDATE vector_sync_jobs SET status='queued',attempts=0,error_code=NULL,scheduled_at=?,started_at=NULL,completed_at=NULL,updated_at=? WHERE id=?",
        now, now, existing.id);
      await env.KNOWLEDGE_SYNC.send({
        jobId: existing.id,
        knowledgeId: input.knowledgeId ?? null,
        operation: input.operation,
        target,
        expectedVersion: input.version ?? null,
        checksum: input.checksum ?? null,
        enqueuedAt: now
      });
      return { jobId: existing.id, duplicate: false };
    }
    return { jobId: existing.id, duplicate: true };
  }

  const jobId = crypto.randomUUID();
  await run(env.DB,
    `INSERT INTO vector_sync_jobs
      (id,knowledge_id,operation,target,status,knowledge_version,idempotency_key,checksum,attempts,scheduled_at,created_by_admin_id,created_at,updated_at)
     VALUES (?,?,?,?, 'queued', ?,?,?,0,?,?,?,?)`,
    jobId, input.knowledgeId ?? null, input.operation, target, input.version ?? null,
    idempotencyKey, input.checksum ?? null, now, input.adminId ?? null, now, now);
  await env.KNOWLEDGE_SYNC.send({
    jobId,
    knowledgeId: input.knowledgeId ?? null,
    operation: input.operation,
    target,
    expectedVersion: input.version ?? null,
    checksum: input.checksum ?? null,
    enqueuedAt: now
  });
  return { jobId, duplicate: false };
}

export async function consumeKnowledgeSync(batch: MessageBatch<KnowledgeSyncJob>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    const job = message.body;
    try {
      const row = await first<{ status: string }>(env.DB,
        'SELECT status FROM vector_sync_jobs WHERE id=? LIMIT 1', job.jobId);
      if (!row || row.status === 'completed' || row.status === 'cancelled') {
        message.ack();
        continue;
      }
      await run(env.DB,
        "UPDATE vector_sync_jobs SET status='running',attempts=attempts+1,started_at=COALESCE(started_at,?),updated_at=? WHERE id=?",
        nowIso(), nowIso(), job.jobId);

      if (job.operation === 'clear') await clearCloudIndex(env);
      else if (!job.knowledgeId) throw new Error('KNOWLEDGE_ID_REQUIRED');
      else if (job.operation === 'delete') await deleteKnowledgeVectors(env, job.knowledgeId);
      else await upsertKnowledgeVectors(env, job.knowledgeId, job.expectedVersion, job.checksum);

      await run(env.DB,
        "UPDATE vector_sync_jobs SET status='completed',error_code=NULL,completed_at=?,updated_at=? WHERE id=?",
        nowIso(), nowIso(), job.jobId);
      message.ack();
    } catch (error) {
      const errorCode = safeErrorCode(error);
      await run(env.DB,
        "UPDATE vector_sync_jobs SET status='failed',error_code=?,updated_at=? WHERE id=?",
        errorCode, nowIso(), job.jobId).catch(() => undefined);
      if (message.attempts >= 4) {
        await run(env.DB,
          "UPDATE vector_sync_jobs SET status='dead_letter',completed_at=?,updated_at=? WHERE id=?",
          nowIso(), nowIso(), job.jobId).catch(() => undefined);
        await env.AI_DLQ.send({ sourceQueue: batch.queue, originalJob: job, errorCode, failedAt: nowIso() });
        message.ack();
      } else {
        message.retry({ delaySeconds: Math.min(600, 2 ** Math.max(1, message.attempts) * 15) });
      }
    }
  }
}

async function upsertKnowledgeVectors(
  env: Env,
  knowledgeId: string,
  expectedVersion: number | null,
  expectedChecksum: string | null
): Promise<void> {
  const knowledge = await first<{
    id: string;
    title: string;
    category: string;
    content: string;
    status: string;
    usage_permission: string;
    vector_version: number;
  }>(env.DB,
    `SELECT id,title,category,content,status,usage_permission,vector_version
       FROM business_knowledge WHERE id=? AND deleted_at IS NULL`, knowledgeId);
  if (!knowledge || knowledge.status !== 'approved') {
    await deleteKnowledgeVectors(env, knowledgeId);
    return;
  }

  const version = await first<{
    version: number;
    source_id: string | null;
    scope: 'global' | 'contact' | 'conversation';
    contact_id: string | null;
    conversation_id: string | null;
    priority: number;
    valid_from: string | null;
    valid_until: string | null;
    checksum: string;
  }>(env.DB,
    `SELECT version,source_id,scope,contact_id,conversation_id,priority,valid_from,valid_until,checksum
       FROM knowledge_versions WHERE knowledge_id=? ORDER BY version DESC LIMIT 1`, knowledgeId);

  const resolvedVersion = version?.version ?? Math.max(1, knowledge.vector_version + 1);
  if (expectedVersion != null && resolvedVersion !== expectedVersion) throw new Error('KNOWLEDGE_VERSION_STALE');
  const checksum = version?.checksum ?? await sha256Hex(`${knowledge.title}\n${knowledge.category}\n${knowledge.content}\n${knowledge.usage_permission}`);
  if (expectedChecksum && checksum !== expectedChecksum) throw new Error('KNOWLEDGE_CHECKSUM_STALE');

  const existing = await all<{ vector_id: string | null; content_hash: string }>(env.DB,
    'SELECT vector_id,content_hash FROM knowledge_chunks WHERE knowledge_id=? ORDER BY chunk_index', knowledgeId);
  const previousArtifact = await first<ArtifactRow>(env.DB,
    'SELECT r2_key,knowledge_version,checksum,vector_count FROM knowledge_vector_artifacts WHERE knowledge_id=?', knowledgeId);
  const chunks = chunkText(`${knowledge.title}\n\n${knowledge.content}`, 1100, 160);
  const chunkHashes = await Promise.all(chunks.map(content => sha256Hex(content)));
  const chunksMatch = existing.length === chunks.length
    && existing.every((item, index) => Boolean(item.vector_id) && item.content_hash === chunkHashes[index]);
  const artifactMatches = previousArtifact?.knowledge_version === resolvedVersion
    && previousArtifact.checksum === checksum
    && previousArtifact.vector_count === chunks.length
    && Boolean(await env.FILES.head(previousArtifact.r2_key).catch(() => null));
  if (chunksMatch && artifactMatches) {
    await run(env.DB,
      "UPDATE business_knowledge SET vector_status='indexed',vector_version=?,updated_at=? WHERE id=?",
      resolvedVersion, nowIso(), knowledgeId);
    return;
  }

  const cloudVectors: VectorizeVector[] = [];
  const localVectors: LocalVector[] = [];
  const insertStatements: D1PreparedStatement[] = [];
  const createdAt = nowIso();
  for (let index = 0; index < chunks.length; index += 1) {
    const content = chunks[index]!;
    const chunkId = crypto.randomUUID();
    const vectorId = `knowledge:${knowledge.id}:v${resolvedVersion}:${index}`;
    const values = await embed(env, content);
    if (values.length !== 1024 || values.some(value => !Number.isFinite(value))) throw new Error('EMBEDDING_DIMENSION_INVALID');
    const metadata = {
      knowledgeId: knowledge.id,
      chunkId,
      sourceId: version?.source_id ?? '',
      title: knowledge.title,
      category: knowledge.category,
      usagePermission: knowledge.usage_permission,
      scope: version?.scope ?? 'global',
      contactId: version?.contact_id ?? '',
      conversationId: version?.conversation_id ?? '',
      priority: version?.priority ?? 100,
      validFrom: version?.valid_from ?? '',
      validUntil: version?.valid_until ?? '',
      language: 'tr',
      version: resolvedVersion,
      checksum: chunkHashes[index]!,
      content
    };
    cloudVectors.push({ id: vectorId, values, metadata });
    localVectors.push({ id: vectorId, vector: values, metadata });
    insertStatements.push(env.DB.prepare(
      `INSERT INTO knowledge_chunks
        (id,knowledge_id,chunk_index,content,content_hash,vector_id,embedding_model,created_at)
       VALUES (?,?,?,?,?,?,?,?)`
    ).bind(chunkId, knowledge.id, index, content, chunkHashes[index], vectorId, env.DEFAULT_EMBEDDING_MODEL, createdAt));
  }

  for (let offset = 0; offset < cloudVectors.length; offset += 100) {
    await env.KNOWLEDGE_INDEX.upsert(cloudVectors.slice(offset, offset + 100));
  }

  const artifactKey = `knowledge-vectors/${knowledge.id}/v${resolvedVersion}-${checksum}.json`;
  const artifactBody = JSON.stringify({
    format: 'wpai-local-vectors',
    version: 1,
    knowledgeId: knowledge.id,
    knowledgeVersion: resolvedVersion,
    checksum,
    embeddingModel: env.DEFAULT_EMBEDDING_MODEL,
    dimensions: 1024,
    vectors: localVectors
  });
  await env.FILES.put(artifactKey, artifactBody, {
    httpMetadata: { contentType: 'application/json; charset=utf-8', cacheControl: 'private, no-store' },
    customMetadata: { knowledgeId: knowledge.id, checksum, version: String(resolvedVersion) }
  });

  const oldIds = existing.flatMap(item => item.vector_id ? [item.vector_id] : []);
  const newIds = new Set(cloudVectors.map(item => item.id));
  const staleOldIds = oldIds.filter(id => !newIds.has(id));
  const statements: D1PreparedStatement[] = [
    env.DB.prepare('DELETE FROM knowledge_chunks WHERE knowledge_id=?').bind(knowledgeId),
    ...insertStatements,
    env.DB.prepare(
      `INSERT INTO knowledge_vector_artifacts
        (knowledge_id,knowledge_version,checksum,r2_key,vector_count,embedding_model,dimensions,created_at,updated_at)
       VALUES (?,?,?,?,?,?,1024,?,?)
       ON CONFLICT(knowledge_id) DO UPDATE SET
         knowledge_version=excluded.knowledge_version,checksum=excluded.checksum,r2_key=excluded.r2_key,
         vector_count=excluded.vector_count,embedding_model=excluded.embedding_model,dimensions=1024,updated_at=excluded.updated_at`
    ).bind(knowledge.id, resolvedVersion, checksum, artifactKey, localVectors.length, env.DEFAULT_EMBEDDING_MODEL, createdAt, createdAt),
    env.DB.prepare(
      "UPDATE business_knowledge SET vector_status='indexed',vector_version=?,updated_at=? WHERE id=?"
    ).bind(resolvedVersion, createdAt, knowledge.id)
  ];

  try {
    const results = await env.DB.batch(statements);
    if (results.some(result => !result.success)) throw new Error('KNOWLEDGE_VECTOR_STATE_WRITE_FAILED');
  } catch (error) {
    await env.FILES.delete(artifactKey).catch(() => undefined);
    const newOnlyIds = [...newIds].filter(id => !oldIds.includes(id));
    if (newOnlyIds.length) await deleteByBatches(env, newOnlyIds).catch(() => undefined);
    throw error;
  }

  if (staleOldIds.length) await deleteByBatches(env, staleOldIds);
  if (previousArtifact?.r2_key && previousArtifact.r2_key !== artifactKey) {
    await env.FILES.delete(previousArtifact.r2_key).catch(() => undefined);
  }
}

export async function deleteKnowledgeVectors(env: Env, knowledgeId: string): Promise<void> {
  const [existing, artifact] = await Promise.all([
    all<{ vector_id: string | null }>(env.DB,
      'SELECT vector_id FROM knowledge_chunks WHERE knowledge_id=?', knowledgeId),
    first<ArtifactRow>(env.DB,
      'SELECT r2_key,knowledge_version,checksum,vector_count FROM knowledge_vector_artifacts WHERE knowledge_id=?', knowledgeId)
  ]);
  const ids = existing.flatMap(item => item.vector_id ? [item.vector_id] : []);
  if (ids.length) await deleteByBatches(env, ids);
  if (artifact?.r2_key) await env.FILES.delete(artifact.r2_key);
  const results = await env.DB.batch([
    env.DB.prepare('DELETE FROM knowledge_chunks WHERE knowledge_id=?').bind(knowledgeId),
    env.DB.prepare('DELETE FROM knowledge_vector_artifacts WHERE knowledge_id=?').bind(knowledgeId),
    env.DB.prepare(
      "UPDATE business_knowledge SET vector_status=CASE WHEN status='approved' THEN 'pending' ELSE 'disabled' END,updated_at=? WHERE id=?"
    ).bind(nowIso(), knowledgeId)
  ]);
  if (results.some(result => !result.success)) throw new Error('KNOWLEDGE_VECTOR_DELETE_FAILED');
}

async function clearCloudIndex(env: Env): Promise<void> {
  const [rows, artifacts] = await Promise.all([
    all<{ vector_id: string | null }>(env.DB,
      'SELECT vector_id FROM knowledge_chunks WHERE vector_id IS NOT NULL'),
    all<{ r2_key: string }>(env.DB, 'SELECT r2_key FROM knowledge_vector_artifacts')
  ]);
  const ids = rows.flatMap(item => item.vector_id ? [item.vector_id] : []);
  if (ids.length) await deleteByBatches(env, ids);
  for (const artifact of artifacts) await env.FILES.delete(artifact.r2_key);
  const results = await env.DB.batch([
    env.DB.prepare('DELETE FROM knowledge_chunks'),
    env.DB.prepare('DELETE FROM knowledge_vector_artifacts'),
    env.DB.prepare(
      "UPDATE business_knowledge SET vector_status=CASE WHEN status='approved' THEN 'pending' ELSE 'disabled' END,updated_at=?"
    ).bind(nowIso())
  ]);
  if (results.some(result => !result.success)) throw new Error('KNOWLEDGE_VECTOR_CLEAR_FAILED');
}

async function deleteByBatches(env: Env, ids: string[]): Promise<void> {
  for (let offset = 0; offset < ids.length; offset += 100) {
    await env.KNOWLEDGE_INDEX.deleteByIds(ids.slice(offset, offset + 100));
  }
}

export async function vectorStatus(env: Env): Promise<{
  indexName: string;
  embeddingModel: string;
  dimensions: number;
  metric: 'cosine';
  activeChunks: number;
  localArtifacts: number;
  pendingJobs: number;
  failedJobs: number;
}> {
  const [chunks, artifacts, pending, failed] = await Promise.all([
    first<{ count: number }>(env.DB,
      `SELECT COUNT(*) AS count FROM knowledge_chunks kc
        JOIN business_knowledge bk ON bk.id=kc.knowledge_id
       WHERE bk.status='approved' AND bk.deleted_at IS NULL AND kc.vector_id IS NOT NULL`),
    first<{ count: number }>(env.DB,
      `SELECT COUNT(*) AS count FROM knowledge_vector_artifacts a
        JOIN business_knowledge bk ON bk.id=a.knowledge_id
       WHERE bk.status='approved' AND bk.deleted_at IS NULL`),
    first<{ count: number }>(env.DB,
      "SELECT COUNT(*) AS count FROM vector_sync_jobs WHERE status IN ('queued','running')"),
    first<{ count: number }>(env.DB,
      "SELECT COUNT(*) AS count FROM vector_sync_jobs WHERE status IN ('failed','dead_letter')")
  ]);
  return {
    indexName: 'wa-ai-knowledge-prod',
    embeddingModel: env.DEFAULT_EMBEDDING_MODEL,
    dimensions: 1024,
    metric: 'cosine',
    activeChunks: chunks?.count ?? 0,
    localArtifacts: artifacts?.count ?? 0,
    pendingJobs: pending?.count ?? 0,
    failedJobs: failed?.count ?? 0
  };
}

function safeErrorCode(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/[^A-Z0-9_:-]/gi, '_').slice(0, 160) || 'VECTOR_SYNC_FAILED';
}
