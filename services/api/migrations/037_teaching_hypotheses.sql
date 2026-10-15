-- Teaching hypotheses: revisable, learner-visible explanations for an error
-- (possible misconception, missing prerequisite, useful analogy). They guide
-- teaching only. Nothing here is assessment evidence, and diagnostic probe runs
-- never write attempts or evidence rows.
CREATE TABLE teaching_hypotheses(
  id uuid PRIMARY KEY,
  enrollment_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  template_id text CHECK (template_id IS NULL OR template_id ~ '^[a-z][a-z0-9._:-]{0,127}$'),
  kind text NOT NULL CHECK (kind IN ('misconception','missing_prerequisite','slip','ambiguous_item','useful_analogy')),
  statement text NOT NULL CHECK (length(statement) BETWEEN 1 AND 500),
  objective_ids jsonb NOT NULL CHECK (jsonb_typeof(objective_ids)='array' AND jsonb_array_length(objective_ids) BETWEEN 1 AND 20),
  evidence_refs jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(evidence_refs)='array' AND jsonb_array_length(evidence_refs)<=50),
  uncertainty text NOT NULL CHECK (uncertainty IN ('low','medium','high')),
  status text NOT NULL CHECK (status IN ('proposed','probing','confirmed','rejected','resolved')),
  source text NOT NULL CHECK (source IN ('supervisor','companion','assessment','learner')),
  pinned boolean NOT NULL DEFAULT false,
  learner_correction text CHECK (learner_correction IS NULL OR length(learner_correction) BETWEEN 1 AND 500),
  rejected_by text CHECK (rejected_by IS NULL OR rejected_by IN ('learner','evidence','supervisor')),
  observations integer NOT NULL DEFAULT 1 CHECK (observations BETWEEN 0 AND 1000),
  course_digest text NOT NULL CHECK (course_digest ~ '^[a-f0-9]{64}$'),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id,enrollment_id,workspace_id),
  FOREIGN KEY (enrollment_id,workspace_id) REFERENCES enrollments(id,workspace_id),
  CHECK ((status='rejected')=(rejected_by IS NOT NULL)),
  -- A pinned hypothesis stays until the learner unpins it.
  CHECK (NOT pinned OR (status<>'rejected' AND expires_at IS NULL))
);
-- At most one active hypothesis per author-declared template.
CREATE UNIQUE INDEX teaching_hypotheses_active_template ON teaching_hypotheses(enrollment_id,template_id)
  WHERE template_id IS NOT NULL AND status IN ('proposed','probing','confirmed');
CREATE INDEX teaching_hypotheses_scope ON teaching_hypotheses(enrollment_id,workspace_id,updated_at DESC,id DESC);

-- Append-only audit of every change, by the learner, a supervisor tool or a trigger.
CREATE TABLE teaching_hypothesis_changes(
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id uuid NOT NULL UNIQUE,
  hypothesis_id uuid NOT NULL,
  enrollment_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  hypothesis_revision integer NOT NULL CHECK (hypothesis_revision > 0),
  actor_kind text NOT NULL CHECK (actor_kind IN ('learner','agent','system')),
  actor_id uuid REFERENCES app_users(id),
  action text NOT NULL CHECK (action IN ('proposed','observed','status_changed','evidence_added','corrected','rejected','pinned','unpinned','probe_scheduled','probe_answered')),
  job_id uuid,
  event_id uuid,
  data jsonb NOT NULL CHECK (jsonb_typeof(data)='object' AND octet_length(data::text)<=16384),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (hypothesis_id,enrollment_id,workspace_id) REFERENCES teaching_hypotheses(id,enrollment_id,workspace_id),
  CHECK (actor_kind<>'learner' OR actor_id IS NOT NULL)
);
CREATE INDEX teaching_hypothesis_changes_scope ON teaching_hypothesis_changes(enrollment_id,workspace_id,sequence DESC);
CREATE INDEX teaching_hypothesis_changes_job ON teaching_hypothesis_changes(job_id) WHERE job_id IS NOT NULL;
CREATE TRIGGER teaching_hypothesis_changes_immutable BEFORE UPDATE OR DELETE ON teaching_hypothesis_changes
  FOR EACH ROW EXECUTE FUNCTION learner_model_immutable();

-- One discriminating probe item shown to the learner. It is graded only to
-- separate hypotheses; grants_evidence is structurally false.
CREATE TABLE diagnostic_probe_runs(
  id uuid PRIMARY KEY,
  enrollment_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  probe_id text NOT NULL CHECK (probe_id ~ '^[a-z][a-z0-9._:-]{0,127}$'),
  assessment_id text NOT NULL CHECK (length(assessment_id) BETWEEN 1 AND 200),
  course_digest text NOT NULL CHECK (course_digest ~ '^[a-f0-9]{64}$'),
  hypothesis_ids jsonb NOT NULL CHECK (jsonb_typeof(hypothesis_ids)='array' AND jsonb_array_length(hypothesis_ids) BETWEEN 1 AND 8),
  requested_by text NOT NULL CHECK (requested_by IN ('supervisor','learner','trigger')),
  request_id uuid,
  job_id uuid,
  state text NOT NULL DEFAULT 'scheduled' CHECK (state IN ('scheduled','answered','abstained','expired','cancelled')),
  response jsonb,
  outcome jsonb,
  grants_evidence boolean NOT NULL DEFAULT false CHECK (NOT grants_evidence),
  scheduled_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  answered_at timestamptz,
  UNIQUE (id,enrollment_id,workspace_id),
  FOREIGN KEY (enrollment_id,workspace_id) REFERENCES enrollments(id,workspace_id),
  CHECK ((state IN ('answered','abstained'))=(answered_at IS NOT NULL AND outcome IS NOT NULL))
);
CREATE UNIQUE INDEX diagnostic_probe_runs_open ON diagnostic_probe_runs(enrollment_id,probe_id) WHERE state='scheduled';
CREATE INDEX diagnostic_probe_runs_scope ON diagnostic_probe_runs(enrollment_id,workspace_id,scheduled_at DESC);

-- A learner's request to check one of their hypotheses (or an objective).
CREATE TABLE diagnostic_requests(
  id uuid PRIMARY KEY,
  enrollment_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  hypothesis_id uuid,
  objective_id text CHECK (objective_id IS NULL OR objective_id ~ '^[a-z][a-z0-9._:-]{0,127}$'),
  note text CHECK (note IS NULL OR length(note) BETWEEN 1 AND 500),
  state text NOT NULL CHECK (state IN ('probe_scheduled','awaiting_supervisor','fulfilled')),
  probe_run_id uuid,
  event_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (enrollment_id,workspace_id) REFERENCES enrollments(id,workspace_id),
  FOREIGN KEY (hypothesis_id,enrollment_id,workspace_id) REFERENCES teaching_hypotheses(id,enrollment_id,workspace_id),
  FOREIGN KEY (probe_run_id,enrollment_id,workspace_id) REFERENCES diagnostic_probe_runs(id,enrollment_id,workspace_id),
  CHECK ((hypothesis_id IS NULL) <> (objective_id IS NULL))
);
CREATE INDEX diagnostic_requests_scope ON diagnostic_requests(enrollment_id,created_at DESC);

-- Each learner signal the trigger table evaluated, with the rules that matched,
-- the bounded effects applied, recommended teaching actions and restraints.
CREATE TABLE teaching_signals(
  id uuid PRIMARY KEY,
  enrollment_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  signal_kind text NOT NULL CHECK (signal_kind IN ('answer.incorrect','answer.correct','answer.abstained','companion.question','grade.challenged','review.due')),
  objective_ids jsonb NOT NULL CHECK (jsonb_typeof(objective_ids)='array' AND jsonb_array_length(objective_ids)<=20),
  source_ref jsonb NOT NULL CHECK (jsonb_typeof(source_ref)='object' AND octet_length(source_ref::text)<=2048),
  rule_ids jsonb NOT NULL CHECK (jsonb_typeof(rule_ids)='array'),
  effects jsonb NOT NULL CHECK (jsonb_typeof(effects)='array' AND octet_length(effects::text)<=16384),
  recommendations jsonb NOT NULL CHECK (jsonb_typeof(recommendations)='array'),
  restraints jsonb NOT NULL CHECK (jsonb_typeof(restraints)='array'),
  skipped jsonb NOT NULL CHECK (jsonb_typeof(skipped)='array'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (enrollment_id,workspace_id) REFERENCES enrollments(id,workspace_id)
);
CREATE INDEX teaching_signals_scope ON teaching_signals(enrollment_id,signal_kind,created_at DESC);
