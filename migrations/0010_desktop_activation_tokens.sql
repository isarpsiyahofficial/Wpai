PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS desktop_activation_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  bound_device_hash TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  expires_at TEXT NOT NULL,
  first_used_at TEXT,
  last_used_at TEXT,
  use_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_desktop_activation_tokens_status_expiry
  ON desktop_activation_tokens(status, expires_at);

CREATE INDEX IF NOT EXISTS idx_desktop_activation_tokens_device
  ON desktop_activation_tokens(bound_device_hash, status);
