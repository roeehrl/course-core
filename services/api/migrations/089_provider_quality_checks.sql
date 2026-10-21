-- Quality checks run from the admin "AI services" page. The server runs Core's public eval suite
-- against the open setup draft's models with the workspace's own key, as a durable job: one row
-- per check holds its state, progress and per-job outcome (grader names and dialogue ids only;
-- never model answers, prompts, keys or learner data). A passing run is recorded exactly as an
-- uploaded report (provider_eval_results), so the gate itself is unchanged.
CREATE TABLE provider_quality_checks (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  draft_id uuid NOT NULL,
  provider_revision integer NOT NULL CHECK (provider_revision >= 0),
  actor_id uuid NOT NULL REFERENCES app_users(id),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN ('running', 'passed', 'failed', 'error')),
  reason_code text CHECK (reason_code ~ '^[A-Z][A-Z0-9_]{1,99}$'),
  roles text[] NOT NULL CHECK (cardinality(roles) BETWEEN 1 AND 5),
  total_dialogues integer NOT NULL CHECK (total_dialogues BETWEEN 1 AND 200),
  completed_dialogues integer NOT NULL DEFAULT 0 CHECK (completed_dialogues >= 0 AND completed_dialogues <= total_dialogues),
  estimate_micro_usd bigint NOT NULL CHECK (estimate_micro_usd >= 0),
  reserved_micro_usd bigint NOT NULL CHECK (reserved_micro_usd >= 0),
  outcome jsonb CHECK (outcome IS NULL OR jsonb_typeof(outcome) = 'array'),
  deadline_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  UNIQUE (workspace_id, idempotency_key),
  CHECK ((state = 'running') = (finished_at IS NULL)),
  CHECK (state <> 'error' OR reason_code IS NOT NULL)
);
-- At most one running check per workspace.
CREATE UNIQUE INDEX provider_quality_checks_running ON provider_quality_checks (workspace_id) WHERE state = 'running';
CREATE INDEX provider_quality_checks_recent ON provider_quality_checks (workspace_id, created_at DESC);

-- A quality-check call is workspace paid work with no learner: it is charged to the workspace
-- budget and recorded in the same spend ledger as every other AI call, without an enrollment.
ALTER TABLE provider_spend_ledger DROP CONSTRAINT provider_spend_ledger_source_check;
ALTER TABLE provider_spend_ledger ADD CONSTRAINT provider_spend_ledger_source_check
  CHECK (source IN ('supervisor', 'media', 'quality_check'));
ALTER TABLE provider_spend_ledger ALTER COLUMN enrollment_id DROP NOT NULL;
ALTER TABLE provider_spend_ledger ADD CONSTRAINT provider_spend_ledger_enrollment_scope
  CHECK ((enrollment_id IS NULL) = (source = 'quality_check'));
