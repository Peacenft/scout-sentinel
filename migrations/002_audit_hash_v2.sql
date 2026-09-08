ALTER TABLE audit_events
  ADD COLUMN IF NOT EXISTS hash_version integer NOT NULL DEFAULT 1
  CHECK (hash_version IN (1, 2));
