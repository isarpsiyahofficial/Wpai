PRAGMA foreign_keys = ON;

-- Historical feature-module migration restored to the source tree. Every object is
-- additive and idempotent so clean installs and already-provisioned production D1
-- databases remain safe.

CREATE TABLE IF NOT EXISTS ai_training_items (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES admin_ai_threads(id) ON DELETE CASCADE,
  item_type TEXT NOT NULL CHECK (item_type IN ('instruction','correction','positive_example','negative_example','simulation','knowledge_draft')),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  expected_response TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','disabled','archived')),
  usage_permission TEXT NOT NULL DEFAULT 'both' CHECK (usage_permission IN ('internal','customer_answers','both')),
  scope TEXT NOT NULL DEFAULT 'global' CHECK (scope IN ('global','contact','conversation')),
  contact_id TEXT REFERENCES contacts(id) ON DELETE CASCADE,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  priority INTEGER NOT NULL DEFAULT 100 CHECK (priority BETWEEN 0 AND 1000),
  valid_from TEXT,
  valid_until TEXT,
  checksum TEXT NOT NULL,
  created_by_admin_id TEXT NOT NULL REFERENCES admins(id) ON DELETE RESTRICT,
  approved_by_admin_id TEXT REFERENCES admins(id) ON DELETE SET NULL,
  approved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS knowledge_sources (
  id TEXT PRIMARY KEY,
  attachment_id TEXT REFERENCES attachments(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('manual','training_chat','pdf','docx','xlsx','csv','txt','image','import')),
  original_name TEXT,
  mime_type TEXT,
  r2_key TEXT,
  language TEXT NOT NULL DEFAULT 'tr',
  page_count INTEGER,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','disabled','failed')),
  checksum TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_by_admin_id TEXT NOT NULL REFERENCES admins(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS knowledge_versions (
  id TEXT PRIMARY KEY,
  knowledge_id TEXT NOT NULL REFERENCES business_knowledge(id) ON DELETE CASCADE,
  source_id TEXT REFERENCES knowledge_sources(id) ON DELETE SET NULL,
  version INTEGER NOT NULL,
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  content TEXT NOT NULL,
  usage_permission TEXT NOT NULL CHECK (usage_permission IN ('internal','customer_answers','both')),
  scope TEXT NOT NULL DEFAULT 'global' CHECK (scope IN ('global','contact','conversation')),
  contact_id TEXT REFERENCES contacts(id) ON DELETE CASCADE,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  priority INTEGER NOT NULL DEFAULT 100 CHECK (priority BETWEEN 0 AND 1000),
  valid_from TEXT,
  valid_until TEXT,
  change_summary TEXT NOT NULL DEFAULT '',
  checksum TEXT NOT NULL,
  created_by_admin_id TEXT NOT NULL REFERENCES admins(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  UNIQUE(knowledge_id, version)
);

CREATE TABLE IF NOT EXISTS vector_sync_jobs (
  id TEXT PRIMARY KEY,
  knowledge_id TEXT REFERENCES business_knowledge(id) ON DELETE CASCADE,
  operation TEXT NOT NULL CHECK (operation IN ('upsert','delete','rebuild','clear')),
  target TEXT NOT NULL DEFAULT 'cloud' CHECK (target IN ('cloud','local','both')),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed','dead_letter','cancelled')),
  knowledge_version INTEGER,
  idempotency_key TEXT NOT NULL UNIQUE,
  checksum TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  scheduled_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  created_by_admin_id TEXT REFERENCES admins(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS retrieval_logs (
  id TEXT PRIMARY KEY,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  query_hash TEXT NOT NULL,
  model TEXT NOT NULL,
  top_k INTEGER NOT NULL,
  similarity_threshold REAL NOT NULL,
  matches_json TEXT NOT NULL DEFAULT '[]',
  selected_chunk_ids_json TEXT NOT NULL DEFAULT '[]',
  result_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS desktop_devices (
  id TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  device_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'windows',
  app_version TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  last_seen_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE(admin_id, device_hash)
);

CREATE TABLE IF NOT EXISTS desktop_sessions (
  id TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES desktop_devices(id) ON DELETE CASCADE,
  admin_session_id TEXT REFERENCES admin_sessions(id) ON DELETE SET NULL,
  refresh_token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  last_rotated_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS csv_imports (
  id TEXT PRIMARY KEY,
  r2_key TEXT NOT NULL UNIQUE,
  original_name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'preview' CHECK (status IN ('preview','committed','failed')),
  total_rows INTEGER NOT NULL DEFAULT 0,
  valid_rows INTEGER NOT NULL DEFAULT 0,
  invalid_rows INTEGER NOT NULL DEFAULT 0,
  duplicate_rows INTEGER NOT NULL DEFAULT 0,
  excluded_rows INTEGER NOT NULL DEFAULT 0,
  result_json TEXT NOT NULL DEFAULT '{}',
  created_by_admin_id TEXT NOT NULL REFERENCES admins(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  committed_at TEXT
);

CREATE TABLE IF NOT EXISTS csv_import_rows (
  id TEXT PRIMARY KEY,
  import_id TEXT NOT NULL REFERENCES csv_imports(id) ON DELETE CASCADE,
  row_number INTEGER NOT NULL,
  phone_e164 TEXT,
  display_name TEXT,
  company_name TEXT,
  city TEXT,
  note_text TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK (status IN ('eligible','invalid','duplicate','opted_out','committed')),
  reason TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(import_id, row_number)
);

CREATE TABLE IF NOT EXISTS canned_replies (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL UNIQUE,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_by_admin_id TEXT NOT NULL REFERENCES admins(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS dead_letter_jobs (
  id TEXT PRIMARY KEY,
  source_queue TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  error_code TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','retrying','resolved','discarded')),
  attempts INTEGER NOT NULL DEFAULT 0,
  failed_at TEXT NOT NULL,
  retried_at TEXT,
  resolved_at TEXT,
  resolved_by_admin_id TEXT REFERENCES admins(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_training_items_thread_status ON ai_training_items(thread_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_training_items_scope ON ai_training_items(scope, contact_id, conversation_id, status);
CREATE INDEX IF NOT EXISTS idx_knowledge_sources_status ON knowledge_sources(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_knowledge_versions_knowledge ON knowledge_versions(knowledge_id, version DESC);
CREATE INDEX IF NOT EXISTS idx_vector_sync_status ON vector_sync_jobs(status, scheduled_at, attempts);
CREATE INDEX IF NOT EXISTS idx_retrieval_logs_scope ON retrieval_logs(conversation_id, contact_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_desktop_sessions_admin ON desktop_sessions(admin_id, expires_at) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_csv_import_rows_status ON csv_import_rows(import_id, status, row_number);
CREATE INDEX IF NOT EXISTS idx_dead_letter_status ON dead_letter_jobs(status, failed_at DESC);

INSERT OR IGNORE INTO system_settings (key, value_json, updated_at) VALUES
  ('ai_similarity_threshold', '0.62', CURRENT_TIMESTAMP),
  ('desktop_notifications_redact', 'true', CURRENT_TIMESTAMP),
  ('desktop_close_to_tray', 'true', CURRENT_TIMESTAMP),
  ('desktop_autostart_enabled', 'false', CURRENT_TIMESTAMP);
