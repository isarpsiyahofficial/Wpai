import { Hono } from 'hono';
import type { AppContext } from './types';
import { all } from './db';
import { fail, ok, requireAuth } from './http';
import { sha256Hex } from './vectorSync';

type ArtifactRow = {
  knowledge_id: string;
  knowledge_version: number;
  checksum: string;
  r2_key: string;
  vector_count: number;
  embedding_model: string;
  dimensions: number;
};

type ArtifactVector = {
  id: string;
  vector: number[];
  metadata: Record<string, unknown>;
};

type ArtifactPayload = {
  format: string;
  version: number;
  knowledgeId: string;
  knowledgeVersion: number;
  checksum: string;
  embeddingModel: string;
  dimensions: number;
  vectors: ArtifactVector[];
};

export const localIndexApiRoutes = new Hono<AppContext>();
localIndexApiRoutes.use('*', requireAuth);

localIndexApiRoutes.get('/training/local-index-bundle', async c => {
  const rows = await all<ArtifactRow>(c.env.DB,
    `SELECT a.knowledge_id,a.knowledge_version,a.checksum,a.r2_key,a.vector_count,a.embedding_model,a.dimensions
       FROM knowledge_vector_artifacts a
       JOIN business_knowledge bk ON bk.id=a.knowledge_id
      WHERE bk.status='approved' AND bk.deleted_at IS NULL
      ORDER BY a.knowledge_id`);
  const expectedCount = rows.reduce((total, row) => total + row.vector_count, 0);
  if (expectedCount > 10_000) {
    return fail(c, 'LOCAL_INDEX_LIMIT_EXCEEDED', 'Yerel indeks 10.000 vektör güvenlik sınırını aşıyor.', 409);
  }

  const vectors: ArtifactVector[] = [];
  for (const row of rows) {
    if (row.dimensions !== 1024 || row.embedding_model !== c.env.DEFAULT_EMBEDDING_MODEL) {
      return fail(c, 'LOCAL_ARTIFACT_CONFIGURATION_MISMATCH', 'Yerel indeks artifact yapılandırması güncel değil.', 409);
    }
    const object = await c.env.FILES.get(row.r2_key);
    if (!object) return fail(c, 'LOCAL_ARTIFACT_MISSING', 'Yerel indeks artifact dosyası eksik; yeniden indeksleme gerekli.', 503);
    if (object.size > 100 * 1024 * 1024) return fail(c, 'LOCAL_ARTIFACT_TOO_LARGE', 'Yerel indeks artifact dosyası güvenlik sınırını aşıyor.', 503);
    let payload: ArtifactPayload;
    try {
      payload = JSON.parse(await object.text()) as ArtifactPayload;
    } catch {
      return fail(c, 'LOCAL_ARTIFACT_INVALID_JSON', 'Yerel indeks artifact dosyası okunamadı.', 503);
    }
    if (
      payload.format !== 'wpai-local-vectors'
      || payload.version !== 1
      || payload.knowledgeId !== row.knowledge_id
      || payload.knowledgeVersion !== row.knowledge_version
      || payload.checksum !== row.checksum
      || payload.embeddingModel !== row.embedding_model
      || payload.dimensions !== 1024
      || !Array.isArray(payload.vectors)
      || payload.vectors.length !== row.vector_count
    ) {
      return fail(c, 'LOCAL_ARTIFACT_STATE_MISMATCH', 'Yerel indeks artifact sürüm veya checksum doğrulaması başarısız.', 503);
    }
    for (const vector of payload.vectors) {
      if (
        !vector
        || typeof vector.id !== 'string'
        || !vector.id.startsWith(`knowledge:${row.knowledge_id}:v${row.knowledge_version}:`)
        || !Array.isArray(vector.vector)
        || vector.vector.length !== 1024
        || vector.vector.some(value => typeof value !== 'number' || !Number.isFinite(value))
        || vector.vector.every(value => value === 0)
        || !vector.metadata
        || typeof vector.metadata !== 'object'
        || Array.isArray(vector.metadata)
        || String(vector.metadata.knowledgeId ?? '') !== row.knowledge_id
        || Number(vector.metadata.version ?? -1) !== row.knowledge_version
      ) {
        return fail(c, 'LOCAL_ARTIFACT_VECTOR_INVALID', 'Yerel indeks artifact içinde geçersiz vektör bulundu.', 503);
      }
      vectors.push(vector);
    }
  }

  if (vectors.length !== expectedCount) {
    return fail(c, 'LOCAL_INDEX_COUNT_MISMATCH', 'Yerel indeks kayıt sayısı doğrulanamadı.', 503);
  }
  const sourceChecksum = await sha256Hex(JSON.stringify(rows.map(row => [
    row.knowledge_id,
    row.knowledge_version,
    row.checksum,
    row.vector_count,
    row.embedding_model,
    row.dimensions
  ])));
  return ok(c, {
    format: 'wpai-local-index-bundle',
    version: 1,
    generatedAt: new Date().toISOString(),
    sourceChecksum,
    count: vectors.length,
    dimensions: 1024,
    embeddingModel: c.env.DEFAULT_EMBEDDING_MODEL,
    vectors
  });
});
