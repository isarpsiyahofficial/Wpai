INSERT OR IGNORE INTO system_settings (key, value_json, updated_at) VALUES
  ('ai_daily_neuron_limit', '10000', CURRENT_TIMESTAMP),
  ('ai_quota_fallback_mode', '"suggestion"', CURRENT_TIMESTAMP),
  ('ai_summary_message_interval', '8', CURRENT_TIMESTAMP);

CREATE INDEX IF NOT EXISTS idx_ai_usage_created_at
  ON ai_usage_records(created_at);
CREATE INDEX IF NOT EXISTS idx_conversation_summaries_conversation_version
  ON conversation_summaries(conversation_id, version DESC);
