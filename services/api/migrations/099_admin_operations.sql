-- Administration operations: per-run cancellation by staff, and provider-billed figures that
-- staff record next to the application's own cost estimates for reconciliation.

-- A staff member asked one supervisor run to stop. The job's cancellation flag is the authority
-- (every bridge step of a flagged job stops it before any provider call); this row records who
-- asked, why, and the receipt that makes the request idempotent. One request per run.
CREATE TABLE supervisor_run_cancellations (
  job_id uuid PRIMARY KEY REFERENCES supervisor_jobs(id),
  enrollment_id uuid NOT NULL REFERENCES enrollments(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  actor_id uuid NOT NULL REFERENCES app_users(id),
  reason text NOT NULL CHECK (length(reason) BETWEEN 10 AND 500 OR reason = '[erased]'),
  previous_state text NOT NULL,
  event_id uuid NOT NULL REFERENCES learning_events(id),
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (enrollment_id, idempotency_key)
);

-- The wake-up signal for a staff cancellation travels on the existing delivery queue.
ALTER TABLE supervisor_job_cancellations DROP CONSTRAINT supervisor_job_cancellations_reason_check;
ALTER TABLE supervisor_job_cancellations ADD CONSTRAINT supervisor_job_cancellations_reason_check
  CHECK (reason IN ('data_erasure', 'provider_changed', 'staff_cancelled'));

-- What a provider actually billed for a period, typed in by an owner or administrator from the
-- provider's own invoice or usage page. Core never fetches billing data; these rows only sit next
-- to the estimated spend ledger so the two can be compared. Never a credential or account number.
CREATE TABLE provider_billed_statements (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  provider_label text NOT NULL CHECK (provider_label ~ '^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$'),
  period_start date NOT NULL,
  period_end date NOT NULL,
  billed_micro_usd bigint NOT NULL CHECK (billed_micro_usd BETWEEN 0 AND 1000000000000),
  currency text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  source_note text NOT NULL CHECK (length(source_note) BETWEEN 3 AND 300),
  recorded_by uuid NOT NULL REFERENCES app_users(id),
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (period_end >= period_start AND period_end - period_start <= 92),
  UNIQUE (workspace_id, idempotency_key)
);
CREATE INDEX provider_billed_statements_period ON provider_billed_statements (workspace_id, period_start DESC);

-- A run that staff cancelled before it applied anything may be retried, like a failed one.
ALTER TABLE supervisor_job_retries DROP CONSTRAINT supervisor_job_retries_outcome_check;
ALTER TABLE supervisor_job_retries ADD CONSTRAINT supervisor_job_retries_outcome_check
  CHECK (outcome IN ('failed', 'uncertain', 'cancelled'));
