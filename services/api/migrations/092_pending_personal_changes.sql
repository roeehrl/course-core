-- Personal changes waiting for a safe boundary (requirement E03). A supervisor-generated addition
-- to the lesson a learner is mid-attempt in is not applied: it waits here until the learner adds
-- it once the attempt ends, when every check runs again (adaptation-store.ts). Inserting a whole
-- lesson after the current one never waits. Nothing here is evidence or delivered content.
CREATE TABLE adaptation_pending_changes (
  id uuid PRIMARY KEY,
  enrollment_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  -- One run delivers at most one generated change.
  job_id uuid NOT NULL UNIQUE,
  episode_id text NOT NULL CHECK (char_length(episode_id) BETWEEN 1 AND 128),
  artifact_kind text NOT NULL CHECK (artifact_kind IN ('explanation','practice','visual','assessment_variant')),
  -- The verified candidate as the run staged it; redacted to '{}' on erasure.
  selection jsonb NOT NULL CHECK (jsonb_typeof(selection) = 'object'),
  reason text NOT NULL CHECK (reason IN ('attempt_in_progress','activity_in_progress')),
  status text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','applied','lapsed','declined')),
  -- Why a change lapsed: a stable error code, never a message.
  outcome_code text CHECK (outcome_code IS NULL OR outcome_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  proposal_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  resolved_at timestamptz,
  CHECK ((status = 'waiting') = (resolved_at IS NULL)),
  CHECK ((status = 'applied') = (proposal_id IS NOT NULL)),
  CHECK ((status = 'lapsed') = (outcome_code IS NOT NULL)),
  FOREIGN KEY (job_id, enrollment_id, workspace_id) REFERENCES supervisor_jobs(id, enrollment_id, workspace_id),
  FOREIGN KEY (enrollment_id, workspace_id) REFERENCES enrollments(id, workspace_id)
);
CREATE INDEX adaptation_pending_changes_waiting ON adaptation_pending_changes(enrollment_id, created_at) WHERE status = 'waiting';
