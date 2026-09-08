ALTER TABLE users
  ALTER COLUMN email DROP NOT NULL,
  ALTER COLUMN password_hash DROP NOT NULL;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS identity_type text NOT NULL DEFAULT 'operator'
    CHECK (identity_type IN ('operator', 'agent'));

CREATE TABLE IF NOT EXISTS dashboard_access_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS dashboard_access_tokens_active
  ON dashboard_access_tokens(token_hash, expires_at)
  WHERE used_at IS NULL;
