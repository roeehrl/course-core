-- Supervisor job phases and parked states, coalesced and oversized events, per-day and
-- per-artifact (per-episode, per-day) budgets, and reconciliation of uncertain calls.
ALTER TABLE supervisor_jobs DROP CONSTRAINT supervisor_jobs_state_check,
  ADD CONSTRAINT supervisor_jobs_state_check CHECK (state IN ('queued','running','waiting','verifying','ready','applied','failed','cancelled','budget_wait',
    'analyzing','building','evaluating','needs_input','follow_up_due'));
-- Set when the host moves a job to a new generation; cleared when that generation's workflow loads it.
ALTER TABLE supervisor_jobs ADD COLUMN resume_requested_at timestamptz;
CREATE INDEX supervisor_jobs_resume ON supervisor_jobs(resume_requested_at) WHERE resume_requested_at IS NOT NULL;
CREATE INDEX supervisor_jobs_parked ON supervisor_jobs(workspace_id) WHERE state='follow_up_due';

ALTER TABLE supervisor_preparations DROP CONSTRAINT supervisor_preparations_disposition_check,
  ADD CONSTRAINT supervisor_preparations_disposition_check
  CHECK (disposition IN ('prepared','inactive','policy_denied','agent_event','supervision_stopped','coalesced','oversized')),
  ADD COLUMN coalesced_into uuid,
  ADD CONSTRAINT supervisor_preparations_coalesced CHECK ((disposition='coalesced') = (coalesced_into IS NOT NULL));

-- NULL means no ceiling of that kind. Days are UTC days; the artifact scope is the job's episode.
ALTER TABLE supervisor_enrollment_budgets
  ADD COLUMN daily_limit_micro_usd bigint CHECK (daily_limit_micro_usd BETWEEN 0 AND 1000000000),
  ADD COLUMN daily_limit_tokens bigint CHECK (daily_limit_tokens BETWEEN 0 AND 1000000000),
  ADD COLUMN artifact_limit_micro_usd bigint CHECK (artifact_limit_micro_usd BETWEEN 0 AND 1000000000),
  ADD COLUMN artifact_limit_tokens bigint CHECK (artifact_limit_tokens BETWEEN 0 AND 1000000000);

-- One row per uncertain call settled from its finished gateway receipt (never by calling again).
CREATE TABLE supervisor_reconciliations (
  operation_id text PRIMARY KEY,
  job_id uuid NOT NULL,
  enrollment_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  outcome_status text NOT NULL CHECK (outcome_status IN ('succeeded','not_started')),
  resumed_generation integer CHECK (resumed_generation BETWEEN 2 AND 16),
  reconciled_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (job_id,enrollment_id,workspace_id) REFERENCES supervisor_jobs(id,enrollment_id,workspace_id)
);
