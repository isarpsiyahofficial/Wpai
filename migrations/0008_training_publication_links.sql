PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS training_item_publications (
  item_id TEXT PRIMARY KEY REFERENCES ai_training_items(id) ON DELETE CASCADE,
  knowledge_id TEXT NOT NULL REFERENCES business_knowledge(id) ON DELETE CASCADE,
  current_version INTEGER NOT NULL DEFAULT 1,
  published_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS source_knowledge_links (
  source_id TEXT NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,
  knowledge_id TEXT NOT NULL REFERENCES business_knowledge(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (source_id, knowledge_id)
);

CREATE INDEX IF NOT EXISTS idx_training_publications_knowledge
  ON training_item_publications(knowledge_id);
CREATE INDEX IF NOT EXISTS idx_source_knowledge_links_knowledge
  ON source_knowledge_links(knowledge_id);
