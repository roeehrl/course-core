-- Workspace AI supervision settings (requirement Q08, B06): how far the supervisor may act on its
-- own after a learner's opt-in, and which tool families it may use. One row per workspace; no row
-- means the defaults (apply verified personal changes, every tool family). Staff changes are
-- audited in workspace_audit. Holds settings only, never learner data.
CREATE TABLE supervision_settings (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id),
  autonomy_level text NOT NULL DEFAULT 'apply_verified_personal'
    CHECK (autonomy_level IN ('recommend_only', 'propose_only', 'apply_verified_personal')),
  permitted_tool_families text[] NOT NULL
    CHECK (cardinality(permitted_tool_families) <= 32 AND array_to_string(permitted_tool_families, ',') ~ '^([a-z][a-z_]{0,39}(,[a-z][a-z_]{0,39})*)?$'),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_by uuid REFERENCES app_users(id),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- The job record names what a job is for (requirement B05): a teaching action, a follow-up, or the
-- learning event's episode objectives. Identifiers only. NULL for jobs recorded before this.
ALTER TABLE supervisor_jobs ADD COLUMN objective jsonb
  CHECK (objective IS NULL OR (jsonb_typeof(objective) = 'object' AND octet_length(objective::text) <= 4096));

-- Teaching actions (requirements B02, B03): the trigger table's reactions that Core itself starts
-- as supervisor work, within the learner's opt-in, the workspace autonomy level and caps, and the
-- follow-ups and transfer probes it schedules after a delivered change. Codes and identifiers only;
-- what the supervisor made lives in the job's artifacts. Never evidence.
CREATE TABLE teaching_actions (
  id uuid PRIMARY KEY,
  enrollment_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('contrast_case','change_representation','visit_prerequisite','transfer_check',
    'worked_example','compress_advance','reevaluate','prepare_review','follow_up','transfer_probe')),
  objective_ids jsonb NOT NULL CHECK (jsonb_typeof(objective_ids) = 'array' AND jsonb_array_length(objective_ids) <= 20),
  rule_id text CHECK (rule_id ~ '^T[0-9]{1,2}$'),
  -- trigger: started by the trigger table; follow_up: scheduled after a delivery; supervisor: a
  -- verified suggestion the supervisor delivered (a new practice problem or a course visual).
  origin text NOT NULL CHECK (origin IN ('trigger','follow_up','supervisor')),
  parent_id uuid REFERENCES teaching_actions(id),
  -- started: its job was asked for; scheduled: a follow-up waiting for its due time;
  -- delivered: the job's change was applied; checked: a follow-up read its outcome; ended: stopped.
  state text NOT NULL CHECK (state IN ('started','scheduled','delivered','checked','ended')),
  end_reason text CHECK (end_reason ~ '^[a-z_]{1,60}$'),
  job_id uuid,
  event_id uuid,
  due_at timestamptz,
  -- A follow-up's deterministic outcome (codes, objective ids and an item id), never learner text.
  outcome jsonb CHECK (outcome IS NULL OR (jsonb_typeof(outcome) = 'object' AND octet_length(outcome::text) <= 4096)),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (enrollment_id, workspace_id) REFERENCES enrollments(id, workspace_id),
  CHECK ((state = 'ended') = (end_reason IS NOT NULL))
);
CREATE INDEX teaching_actions_enrollment ON teaching_actions (enrollment_id, created_at DESC);
CREATE INDEX teaching_actions_job ON teaching_actions (job_id) WHERE job_id IS NOT NULL;

-- Changes the supervisor may not make on its own (requirement B06): a new overall goal, required
-- grading standards or objectives, or a higher paid ceiling. The job waits (needs_input) until the
-- authority named here decides: the learner for their own goal, a workspace owner or admin for the
-- rest. The decider applies an approved change under their own authority; the learner can undo an
-- approved goal change.
CREATE TABLE supervisor_authority_requests (
  id uuid PRIMARY KEY,
  enrollment_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  job_id uuid NOT NULL UNIQUE,
  kind text NOT NULL CHECK (kind IN ('goal_change','required_objectives','grading_standard','paid_ceiling')),
  approver text NOT NULL CHECK (approver IN ('learner','staff')),
  proposal jsonb NOT NULL CHECK (jsonb_typeof(proposal) = 'object' AND octet_length(proposal::text) <= 4096),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','approved','rejected','expired','undone')),
  -- What an approved change replaced, for the learner's undo (a goal change only).
  previous jsonb CHECK (previous IS NULL OR jsonb_typeof(previous) = 'object'),
  decided_by uuid REFERENCES app_users(id),
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (enrollment_id, workspace_id) REFERENCES enrollments(id, workspace_id),
  CHECK ((state = 'pending') = (decided_at IS NULL))
);
CREATE INDEX supervisor_authority_requests_pending ON supervisor_authority_requests (workspace_id, created_at) WHERE state = 'pending';
CREATE INDEX supervisor_authority_requests_enrollment ON supervisor_authority_requests (enrollment_id, created_at DESC);
