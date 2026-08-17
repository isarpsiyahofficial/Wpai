PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS system_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS branding_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  app_name TEXT NOT NULL DEFAULT 'WPAI Yönetim Paneli',
  company_name TEXT NOT NULL DEFAULT '',
  short_description TEXT NOT NULL DEFAULT 'Müşteri görüşmeleri ve yapay zekâ yönetimi',
  logo_key TEXT,
  primary_color TEXT NOT NULL DEFAULT '#7657ff',
  secondary_color TEXT NOT NULL DEFAULT '#22c7e8',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admins (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'owner' CHECK (role IN ('owner','admin','agent','viewer')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled','locked')),
  failed_login_count INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  last_login_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  id TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  csrf_token TEXT NOT NULL,
  user_agent_hash TEXT,
  ip_hash TEXT,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS login_attempts (
  id TEXT PRIMARY KEY,
  email_hash TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  success INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  phone_e164 TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  company_name TEXT,
  email TEXT,
  city TEXT,
  country_code TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','lead','customer','archived','blocked')),
  first_contact_at TEXT,
  last_contact_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  color TEXT NOT NULL DEFAULT '#7657ff',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS contact_tags (
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (contact_id, tag_id)
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','pending','closed','archived')),
  assigned_admin_id TEXT REFERENCES admins(id) ON DELETE SET NULL,
  ai_mode TEXT NOT NULL DEFAULT 'suggestion' CHECK (ai_mode IN ('off','suggestion','auto','business_hours','human')),
  ai_paused_until TEXT,
  human_takeover INTEGER NOT NULL DEFAULT 0,
  human_takeover_at TEXT,
  human_takeover_by TEXT REFERENCES admins(id) ON DELETE SET NULL,
  unread_count INTEGER NOT NULL DEFAULT 0,
  last_message_at TEXT,
  last_inbound_at TEXT,
  last_outbound_at TEXT,
  current_context_version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  r2_key TEXT NOT NULL UNIQUE,
  original_name TEXT NOT NULL,
  safe_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('customer','admin','knowledge','import','system')),
  uploaded_by_admin_id TEXT REFERENCES admins(id) ON DELETE SET NULL,
  scan_status TEXT NOT NULL DEFAULT 'pending' CHECK (scan_status IN ('pending','clean','rejected','failed')),
  created_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS ai_decisions (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  source_message_id TEXT,
  action TEXT NOT NULL,
  intent TEXT NOT NULL,
  confidence REAL NOT NULL,
  needs_human INTEGER NOT NULL,
  needs_research INTEGER NOT NULL,
  should_notify_admin INTEGER NOT NULL,
  decision_json TEXT NOT NULL,
  model TEXT NOT NULL,
  context_version INTEGER NOT NULL,
  blocked_reason TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  meta_message_id TEXT UNIQUE,
  client_request_id TEXT UNIQUE,
  direction TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  sender_type TEXT NOT NULL CHECK (sender_type IN ('customer','admin','ai','system')),
  message_type TEXT NOT NULL CHECK (message_type IN ('text','image','document','audio','video','location','contact','interactive','template','reaction','unsupported')),
  text_content TEXT,
  reply_to_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  attachment_id TEXT REFERENCES attachments(id) ON DELETE SET NULL,
  delivery_status TEXT NOT NULL DEFAULT 'queued' CHECK (delivery_status IN ('queued','submitted','sent','delivered','read','failed','cancelled')),
  ai_generated INTEGER NOT NULL DEFAULT 0,
  ai_decision_id TEXT REFERENCES ai_decisions(id) ON DELETE SET NULL,
  error_code TEXT,
  sent_at TEXT,
  received_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS message_status_events (
  id TEXT PRIMARY KEY,
  message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
  meta_message_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued','submitted','sent','delivered','read','failed','cancelled')),
  error_code TEXT,
  error_message_safe TEXT,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(meta_message_id, status, occurred_at)
);

CREATE TABLE IF NOT EXISTS conversation_summaries (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  summary_text TEXT NOT NULL,
  facts_json TEXT NOT NULL DEFAULT '{}',
  through_message_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(conversation_id, version)
);

CREATE TABLE IF NOT EXISTS customer_notes (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('ai','admin','system')),
  note_text TEXT NOT NULL,
  created_by_admin_id TEXT REFERENCES admins(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS customer_requirements (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sector TEXT,
  website_type TEXT,
  requested_pages_json TEXT NOT NULL DEFAULT '[]',
  admin_panel_required INTEGER,
  catalog_required INTEGER,
  ecommerce_required INTEGER,
  multilanguage_required INTEGER,
  domain_status TEXT,
  hosting_status TEXT,
  design_preferences TEXT,
  reference_websites_json TEXT NOT NULL DEFAULT '[]',
  budget_min REAL,
  budget_max REAL,
  currency_code TEXT,
  delivery_expectation TEXT,
  quoted_price REAL,
  discount_amount REAL,
  payment_expectation TEXT,
  next_action TEXT,
  lead_stage TEXT,
  confidence_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL,
  UNIQUE(conversation_id)
);

CREATE TABLE IF NOT EXISTS business_knowledge (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','disabled')),
  usage_permission TEXT NOT NULL DEFAULT 'both' CHECK (usage_permission IN ('internal','customer_answers','both')),
  source_type TEXT NOT NULL DEFAULT 'manual' CHECK (source_type IN ('manual','admin_chat','file','import','system')),
  source_attachment_id TEXT REFERENCES attachments(id) ON DELETE SET NULL,
  vector_status TEXT NOT NULL DEFAULT 'pending' CHECK (vector_status IN ('pending','indexed','failed','disabled')),
  vector_version INTEGER NOT NULL DEFAULT 0,
  created_by_admin_id TEXT REFERENCES admins(id) ON DELETE SET NULL,
  approved_by_admin_id TEXT REFERENCES admins(id) ON DELETE SET NULL,
  approved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id TEXT PRIMARY KEY,
  knowledge_id TEXT NOT NULL REFERENCES business_knowledge(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  vector_id TEXT UNIQUE,
  embedding_model TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(knowledge_id, chunk_index)
);

CREATE TABLE IF NOT EXISTS service_catalog (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','disabled')),
  features_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pricing_rules (
  id TEXT PRIMARY KEY,
  service_id TEXT REFERENCES service_catalog(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  amount_min REAL,
  amount_max REAL,
  currency_code TEXT NOT NULL DEFAULT 'TRY',
  rule_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS message_templates (
  id TEXT PRIMARY KEY,
  meta_name TEXT NOT NULL UNIQUE,
  language_code TEXT NOT NULL,
  category TEXT,
  status TEXT NOT NULL DEFAULT 'unknown',
  components_json TEXT NOT NULL DEFAULT '[]',
  synced_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Kept only for migration compatibility. Campaign execution is intentionally disabled.
CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'disabled',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS campaign_recipients (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'disabled',
  created_at TEXT NOT NULL,
  UNIQUE(campaign_id, contact_id)
);

CREATE TABLE IF NOT EXISTS opt_outs (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('marketing','all_outbound')),
  reason TEXT,
  source_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS ai_jobs (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  source_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('queued','running','completed','cancelled','failed','dead_letter')),
  expected_context_version INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_usage_records (
  id TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  operation_type TEXT NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  estimated_neurons REAL,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  success INTEGER NOT NULL,
  error_code TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS human_handoffs (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  reason_code TEXT NOT NULL,
  reason_text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','resolved','dismissed')),
  ai_decision_id TEXT REFERENCES ai_decisions(id) ON DELETE SET NULL,
  assigned_admin_id TEXT REFERENCES admins(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS admin_notifications (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','critical')),
  status TEXT NOT NULL DEFAULT 'unread' CHECK (status IN ('unread','read','in_progress','snoozed','completed','dismissed')),
  contact_id TEXT REFERENCES contacts(id) ON DELETE CASCADE,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  deduplication_key TEXT,
  cooldown_until TEXT,
  whatsapp_status TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS follow_up_tasks (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  notes TEXT,
  due_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','cancelled','snoozed')),
  assigned_admin_id TEXT REFERENCES admins(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  actor_admin_id TEXT REFERENCES admins(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  summary_json TEXT NOT NULL DEFAULT '{}',
  request_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS webhook_events (
  id TEXT PRIMARY KEY,
  provider_event_id TEXT UNIQUE,
  payload_hash TEXT NOT NULL,
  event_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('received','processed','ignored','failed')),
  received_at TEXT NOT NULL,
  processed_at TEXT,
  error_code TEXT
);

CREATE TABLE IF NOT EXISTS integration_credentials (
  provider TEXT PRIMARY KEY,
  encrypted_payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'configured' CHECK (status IN ('configured','paused','invalid','removed')),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  verified_at TEXT,
  updated_at TEXT NOT NULL,
  updated_by TEXT REFERENCES admins(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS infrastructure_snapshots (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  report_json TEXT NOT NULL,
  overall_status TEXT NOT NULL,
  created_by_admin_id TEXT REFERENCES admins(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_ai_threads (
  id TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  selected_conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_ai_messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES admin_ai_threads(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('admin','assistant','system')),
  content TEXT NOT NULL,
  proposed_knowledge_json TEXT,
  created_at TEXT NOT NULL
);

INSERT OR IGNORE INTO branding_settings (id, updated_at) VALUES (1, CURRENT_TIMESTAMP);
