PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS knowledge_source_extractions (
  source_id TEXT PRIMARY KEY REFERENCES knowledge_sources(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','ready','failed')),
  extracted_text TEXT,
  error_code TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_source_extractions_status
  ON knowledge_source_extractions(status, updated_at DESC);
