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
