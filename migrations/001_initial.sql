CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz
);

CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS sessions_active_lookup ON sessions(token_hash, expires_at) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS mandates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  name text NOT NULL,
  document jsonb NOT NULL,
  document_hash text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, version),
  UNIQUE (user_id, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_mandate_per_user ON mandates(user_id) WHERE active;

CREATE TABLE IF NOT EXISTS proposals (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mandate_id uuid NOT NULL REFERENCES mandates(id),
  mandate_version integer NOT NULL,
  document jsonb NOT NULL,
  document_hash text NOT NULL,
  created_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (mandate_id, mandate_version) REFERENCES mandates(id, version)
);

CREATE TABLE IF NOT EXISTS evaluations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mandate_id uuid NOT NULL REFERENCES mandates(id),
  mandate_version integer NOT NULL,
  proposal_id uuid NOT NULL REFERENCES proposals(id),
  portfolio_state jsonb NOT NULL,
  portfolio_state_hash text NOT NULL,
  verdict jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (mandate_id, mandate_version) REFERENCES mandates(id, version)
);
CREATE INDEX IF NOT EXISTS evaluations_proposal_lookup ON evaluations(proposal_id, created_at DESC);

CREATE TABLE IF NOT EXISTS confirmation_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  evaluation_id uuid NOT NULL REFERENCES evaluations(id),
  terms_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  confirmed_at timestamptz,
  consumed_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_live_confirmation_per_evaluation
  ON confirmation_requests(evaluation_id)
  WHERE confirmed_at IS NULL AND consumed_at IS NULL AND cancelled_at IS NULL;

CREATE TABLE IF NOT EXISTS execution_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  confirmation_id uuid NOT NULL UNIQUE REFERENCES confirmation_requests(id),
  idempotency_key text NOT NULL,
  status text NOT NULL CHECK (status IN ('created', 'submitting', 'pending', 'confirmed', 'rejected', 'failed', 'unknown')),
  provider text NOT NULL CHECK (provider = 'binance_agent_os'),
  provider_operation_id text,
  request_document jsonb NOT NULL,
  response_document jsonb,
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS audit_events (
  sequence bigserial PRIMARY KEY,
  id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  payload jsonb NOT NULL,
  previous_hash text,
  event_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_events_user_sequence ON audit_events(user_id, sequence);

CREATE TABLE IF NOT EXISTS schema_migrations (
  filename text PRIMARY KEY,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);
