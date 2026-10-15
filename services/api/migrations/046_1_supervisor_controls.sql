-- Staff control over an enrollment's AI supervision: pause, stop and resume.
-- The row is authoritative; Temporal signals sent from the change log only wake workflows.
-- A missing row means 'active' at revision 0. Only codes are stored, never free text.
CREATE TABLE supervisor_controls(
  enrollment_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','paused','stopped')),
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  reason_code text CHECK (reason_code IS NULL OR reason_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  changed_by uuid REFERENCES app_users(id),
  changed_at timestamptz,
  FOREIGN KEY (enrollment_id,workspace_id) REFERENCES enrollments(id,workspace_id)
);
-- Append-only history, and the delivery queue for the wake-up signals.
CREATE TABLE supervisor_control_changes(
  id uuid PRIMARY KEY,
  enrollment_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  action text NOT NULL CHECK (action IN ('pause','stop','resume')),
  from_state text NOT NULL CHECK (from_state IN ('active','paused','stopped')),
  to_state text NOT NULL CHECK (to_state IN ('active','paused','stopped')),
  reason_code text CHECK (reason_code IS NULL OR reason_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  actor_id uuid REFERENCES app_users(id),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  -- Run references of the enrollment's live jobs when the change committed.
  jobs jsonb NOT NULL CHECK (jsonb_typeof(jobs)='array' AND jsonb_array_length(jobs) <= 64),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 20),
  lease_token uuid,
  claimed_until timestamptz,
  delivered_at timestamptz,
  abandoned_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (enrollment_id,idempotency_key),
  UNIQUE (enrollment_id,revision),
  FOREIGN KEY (enrollment_id,workspace_id) REFERENCES enrollments(id,workspace_id),
  CHECK (from_state <> to_state),
  CHECK (delivered_at IS NULL OR abandoned_at IS NULL)
);
CREATE INDEX supervisor_control_changes_pending ON supervisor_control_changes(created_at,id)
  WHERE delivered_at IS NULL AND abandoned_at IS NULL;
-- Events that arrive while supervision is stopped are consumed without starting a job.
ALTER TABLE supervisor_preparations DROP CONSTRAINT supervisor_preparations_disposition_check,
  ADD CONSTRAINT supervisor_preparations_disposition_check
  CHECK (disposition IN ('prepared','inactive','policy_denied','agent_event','supervision_stopped'));
