-- A learner's undo of an applied personal change. The revert is its own plan revision whose
-- rollback target is the plan the change was applied on; the proposal, its application and
-- its artifacts stay as provenance. Identifiers and digests only, never content.
CREATE TABLE adaptation_reverts (
  enrollment_id uuid NOT NULL REFERENCES enrollments(id),
  proposal_id uuid NOT NULL,
  plan_revision integer NOT NULL CHECK (plan_revision > 1),
  plan_digest text NOT NULL CHECK (plan_digest ~ '^[a-f0-9]{64}$'),
  rollback_target_digest text NOT NULL CHECK (rollback_target_digest ~ '^[a-f0-9]{64}$'),
  event_id uuid NOT NULL REFERENCES learning_events(id),
  reverted_by uuid NOT NULL REFERENCES app_users(id),
  reverted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (enrollment_id,proposal_id),
  UNIQUE (enrollment_id,plan_revision),
  -- Only an applied change can be reverted, once.
  FOREIGN KEY (enrollment_id,proposal_id) REFERENCES adaptation_applications(enrollment_id,proposal_id),
  CHECK (plan_digest <> rollback_target_digest)
);
CREATE TRIGGER adaptation_reverts_immutable BEFORE UPDATE OR DELETE ON adaptation_reverts FOR EACH ROW EXECUTE FUNCTION adaptation_immutable();
