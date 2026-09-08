CREATE TABLE IF NOT EXISTS binance_oauth_flows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  state_hash text NOT NULL UNIQUE,
  code_verifier_ciphertext text,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS binance_oauth_flows_active
  ON binance_oauth_flows(state_hash, expires_at)
  WHERE consumed_at IS NULL;

CREATE TABLE IF NOT EXISTS binance_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  token_ciphertext text NOT NULL,
  token_expires_at timestamptz,
  token_scope text,
  status text NOT NULL CHECK (status IN ('connected', 'expired', 'error')),
  capability_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_verified_at timestamptz,
  last_error_code text,
  connected_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS binance_connections_status
  ON binance_connections(status, token_expires_at);
