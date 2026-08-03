-- Existing deployments may contain duplicate webhook payload hashes from before
-- payload-level idempotency was enforced. Keep the earliest row safely.
DELETE FROM webhook_events
WHERE rowid NOT IN (
  SELECT MIN(rowid)
  FROM webhook_events
  GROUP BY payload_hash
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_webhook_events_payload_hash
  ON webhook_events(payload_hash);
