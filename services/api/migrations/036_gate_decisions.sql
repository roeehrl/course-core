-- Server-side readiness decisions for progression gates. Core computes each decision from
-- persisted, server-issued evidence and binds it to the gate version, course digest and
-- policy revision it was made under. A changed input supersedes the current decision; an
-- advance command recomputes at commit time and refuses a stale or unlinked decision.
CREATE TABLE gate_decisions(
  id uuid PRIMARY KEY,
  enrollment_id uuid NOT NULL REFERENCES enrollments(id),
  workspace_id uuid NOT NULL,
  gate_id text NOT NULL CHECK(length(gate_id) BETWEEN 1 AND 200),
  gate_version text NOT NULL CHECK(length(gate_version) BETWEEN 1 AND 100),
  episode_id text,
  course_digest text NOT NULL,
  policy_revision integer NOT NULL CHECK(policy_revision>=0),
  status text NOT NULL CHECK(status IN('ready','needs_evidence','needs_help','under_review','closed_with_gaps')),
  criterion_results jsonb NOT NULL CHECK(jsonb_typeof(criterion_results)='array'),
  missing_objective_ids jsonb NOT NULL CHECK(jsonb_typeof(missing_objective_ids)='array'),
  unresolved_misconception_ids jsonb NOT NULL CHECK(jsonb_typeof(unresolved_misconception_ids)='array'),
  evidence_refs jsonb NOT NULL CHECK(jsonb_typeof(evidence_refs)='array'),
  evaluator jsonb NOT NULL,
  learner_visible_reason text NOT NULL CHECK(length(learner_visible_reason) BETWEEN 1 AND 8000),
  next_actions jsonb NOT NULL CHECK(jsonb_typeof(next_actions)='array'),
  next_activity_id text,
  inputs_digest text NOT NULL CHECK(inputs_digest~'^[a-f0-9]{64}$'),
  supersedes uuid REFERENCES gate_decisions(id),
  superseded_at timestamptz,
  decided_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(id,enrollment_id),
  FOREIGN KEY(enrollment_id,workspace_id) REFERENCES enrollments(id,workspace_id)
);
CREATE UNIQUE INDEX gate_decisions_current ON gate_decisions(enrollment_id,gate_id) WHERE superseded_at IS NULL;
CREATE INDEX gate_decisions_history ON gate_decisions(enrollment_id,gate_id,decided_at DESC);
-- Decisions are an audit record: never deleted, and the only change is being superseded once.
CREATE FUNCTION gate_decision_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND OLD.superseded_at IS NULL AND NEW.superseded_at IS NOT NULL
    AND (to_jsonb(NEW)-'superseded_at') IS NOT DISTINCT FROM (to_jsonb(OLD)-'superseded_at') THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'GATE_DECISION_IMMUTABLE' USING ERRCODE='23514';
END $$;
CREATE TRIGGER gate_decisions_immutable BEFORE UPDATE OR DELETE ON gate_decisions FOR EACH ROW EXECUTE FUNCTION gate_decision_immutable();
-- A completed episode names the ready decision that authorized it.
ALTER TABLE episode_progress ADD COLUMN gate_decision_id uuid REFERENCES gate_decisions(id);
-- Optional self-rated confidence on the item's declared scale. It never passes or fails anything.
ALTER TABLE attempts ADD COLUMN confidence smallint CHECK(confidence IS NULL OR confidence BETWEEN 1 AND 7);
-- A learner may ask staff to review a gate decision the gate's appeal policy covers. Staff either
-- uphold it (with a reason the learner sees) or authorize an exception. An exception is a separate
-- audited grant, not a gate decision: the decision keeps its honest status and open criteria, and the
-- grant lets the learner advance past this checkpoint only on the course and gate version it names.
CREATE TABLE gate_review_requests(
  id uuid PRIMARY KEY,
  enrollment_id uuid NOT NULL REFERENCES enrollments(id),
  workspace_id uuid NOT NULL,
  gate_id text NOT NULL CHECK(length(gate_id) BETWEEN 1 AND 200),
  decision_id uuid NOT NULL,
  reason text NOT NULL CHECK(reason='[erased]' OR length(reason) BETWEEN 10 AND 2000),
  state text NOT NULL DEFAULT 'open' CHECK(state IN('open','upheld','exception_granted')),
  reviewer_id uuid REFERENCES app_users(id),
  reviewer_note text CHECK(reviewer_note IS NULL OR length(reviewer_note) BETWEEN 1 AND 2000),
  exception_course_digest text,
  exception_gate_version text,
  request_digest text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  decided_at timestamptz,
  UNIQUE(id,enrollment_id),
  FOREIGN KEY(decision_id,enrollment_id) REFERENCES gate_decisions(id,enrollment_id),
  FOREIGN KEY(enrollment_id,workspace_id) REFERENCES enrollments(id,workspace_id),
  CHECK((state='open')=(reviewer_id IS NULL AND decided_at IS NULL AND reviewer_note IS NULL)),
  CHECK((state='exception_granted')=(exception_course_digest IS NOT NULL AND exception_gate_version IS NOT NULL))
);
CREATE UNIQUE INDEX gate_review_requests_open ON gate_review_requests(enrollment_id,gate_id) WHERE state='open';
CREATE INDEX gate_review_requests_queue ON gate_review_requests(workspace_id,state,created_at);
-- A completion authorized by a staff exception names the grant and the course version it was
-- granted on; it stops counting if the enrollment moves to another course version.
ALTER TABLE episode_progress ADD COLUMN gate_exception_id uuid, ADD COLUMN exception_course_digest text,
  ADD CONSTRAINT episode_progress_gate_exception FOREIGN KEY(gate_exception_id,enrollment_id) REFERENCES gate_review_requests(id,enrollment_id),
  ADD CONSTRAINT episode_progress_exception_pair CHECK((gate_exception_id IS NULL)=(exception_course_digest IS NULL));
