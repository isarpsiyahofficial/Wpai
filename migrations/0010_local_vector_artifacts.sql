PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS knowledge_vector_artifacts (
  knowledge_id TEXT PRIMARY KEY REFERENCES business_knowledge(id) ON DELETE CASCADE,
  knowledge_version INTEGER NOT NULL,
  checksum TEXT NOT NULL,
  r2_key TEXT NOT NULL UNIQUE,
  vector_count INTEGER NOT NULL CHECK (vector_count >= 0),
  embedding_model TEXT NOT NULL,
  dimensions INTEGER NOT NULL CHECK (dimensions = 1024),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_vector_artifacts_version
  ON knowledge_vector_artifacts(knowledge_version, updated_at DESC);
