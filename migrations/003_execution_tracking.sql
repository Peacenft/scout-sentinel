ALTER TABLE execution_operations
  ADD COLUMN IF NOT EXISTS mandate_id uuid REFERENCES mandates(id),
  ADD COLUMN IF NOT EXISTS mandate_version integer,
  ADD COLUMN IF NOT EXISTS provider_status text,
  ADD COLUMN IF NOT EXISTS submitted_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_reconciled_at timestamptz,
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0);

CREATE INDEX IF NOT EXISTS execution_operations_status_lookup
  ON execution_operations(status, updated_at);

CREATE TABLE IF NOT EXISTS execution_receipts (
  operation_id uuid PRIMARY KEY REFERENCES execution_operations(id) ON DELETE CASCADE,
  provider_operation_id text NOT NULL,
  provider_status text NOT NULL,
  executed_base_quantity numeric NOT NULL CHECK (executed_base_quantity > 0),
  executed_quote_quantity numeric NOT NULL CHECK (executed_quote_quantity > 0),
  observed_at timestamptz NOT NULL,
  evidence jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tracked_positions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mandate_id uuid NOT NULL REFERENCES mandates(id),
  mandate_version integer NOT NULL,
  source_operation_id uuid NOT NULL UNIQUE REFERENCES execution_operations(id),
  base_asset text NOT NULL,
  quote_asset text NOT NULL,
  venue text NOT NULL CHECK (venue IN ('spot', 'convert')),
  opened_base_quantity numeric NOT NULL CHECK (opened_base_quantity > 0),
  opened_quote_quantity numeric NOT NULL CHECK (opened_quote_quantity > 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
  opened_at timestamptz NOT NULL,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (mandate_id, mandate_version) REFERENCES mandates(id, version)
);
CREATE INDEX IF NOT EXISTS tracked_positions_user_status
  ON tracked_positions(user_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS monitor_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  position_id uuid NOT NULL UNIQUE REFERENCES tracked_positions(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'completed', 'failed')),
  next_run_at timestamptz NOT NULL,
  last_run_at timestamptz,
  consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  lease_owner text,
  lease_expires_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS monitor_jobs_due
  ON monitor_jobs(next_run_at)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS protection_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  position_id uuid NOT NULL REFERENCES tracked_positions(id) ON DELETE CASCADE,
  monitor_job_id uuid NOT NULL REFERENCES monitor_jobs(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN ('drawdown_threshold', 'position_missing')),
  status text NOT NULL DEFAULT 'action_required' CHECK (status IN ('action_required', 'acknowledged', 'resolved')),
  portfolio_state_hash text NOT NULL,
  details jsonb NOT NULL,
  detected_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz,
  resolved_at timestamptz
);
CREATE INDEX IF NOT EXISTS protection_events_user_status
  ON protection_events(user_id, status, detected_at DESC);
