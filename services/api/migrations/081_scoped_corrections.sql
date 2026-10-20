-- Scoped staff corrections (U07): a retry of one supervisor run that failed or ended uncertain,
-- and a regrade of one automated or rubric attempt. Neither rewrites what came before.

-- A retry is a new staff learning event that the dispatcher prepares into a new run through the
-- normal path (policy, fence, budget, verifier, application). This row links the retried run to
-- that event; the primary key makes each run retryable once. The reason is staff free text,
-- redacted on erasure.
CREATE TABLE supervisor_job_retries (
  job_id uuid PRIMARY KEY,
  enrollment_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  retry_event_id uuid NOT NULL UNIQUE,
  actor_id uuid NOT NULL REFERENCES app_users(id),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 500),
  outcome text NOT NULL CHECK (outcome IN ('failed','uncertain')),
  previous_state text NOT NULL CHECK (previous_state ~ '^[a-z][a-z_]{0,31}$'),
  previous_reason text CHECK (previous_reason IS NULL OR previous_reason ~ '^[a-z][a-z0-9_]{0,63}$'),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (job_id,enrollment_id,workspace_id) REFERENCES supervisor_jobs(id,enrollment_id,workspace_id),
  FOREIGN KEY (retry_event_id,enrollment_id,workspace_id) REFERENCES learning_events(id,enrollment_id,workspace_id)
);
CREATE INDEX supervisor_job_retries_enrollment ON supervisor_job_retries(enrollment_id,created_at);

-- A regrade is a new decision on one attempt, linked to the decision it supersedes: the attempt's
-- own automated result, a rubric review, a decided appeal or an earlier regrade. The attempt row
-- and earlier decisions never change. When the outcome changes, the attempt's current evidence is
-- invalidated with a reason and new evidence names this row; an upheld regrade changes no evidence.
-- Each decision has at most one successor, so concurrent regrades cannot fork the chain.
CREATE TABLE attempt_regrades (
  id uuid PRIMARY KEY,
  attempt_id uuid NOT NULL,
  enrollment_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('automated','rubric')),
  supersedes_kind text NOT NULL CHECK (supersedes_kind IN ('attempt','review','appeal','regrade')),
  supersedes_id uuid NOT NULL,
  previous_passed boolean NOT NULL,
  passed boolean NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('changed','upheld')),
  evaluator_ref text NOT NULL CHECK (char_length(evaluator_ref) BETWEEN 1 AND 200),
  result jsonb NOT NULL,
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 2000),
  actor_id uuid NOT NULL REFERENCES app_users(id),
  event_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((outcome = 'changed') = (passed <> previous_passed)),
  CHECK (supersedes_kind <> 'regrade' OR supersedes_id <> id),
  UNIQUE (enrollment_id, idempotency_key),
  FOREIGN KEY (attempt_id,enrollment_id) REFERENCES attempts(id,enrollment_id),
  FOREIGN KEY (event_id,enrollment_id,workspace_id) REFERENCES learning_events(id,enrollment_id,workspace_id)
);
CREATE UNIQUE INDEX attempt_regrades_one_successor ON attempt_regrades(supersedes_kind,supersedes_id);
CREATE INDEX attempt_regrades_attempt ON attempt_regrades(attempt_id,created_at);
