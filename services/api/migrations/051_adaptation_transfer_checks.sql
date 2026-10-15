-- Outcome records for delivered generated teaching: did the learner then pass an independent
-- check on the objective it addressed? Resolved from attempts; never evidence or a grade.
CREATE TABLE adaptation_transfer_checks (
  enrollment_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  proposal_id uuid NOT NULL,
  objective_id text NOT NULL CHECK (objective_id ~ '^[a-z][a-z0-9._:-]{0,127}$'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','passed','failed','expired')),
  attempt_id uuid,
  delivered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  resolved_at timestamptz,
  PRIMARY KEY (enrollment_id,proposal_id,objective_id),
  FOREIGN KEY (enrollment_id,workspace_id) REFERENCES enrollments(id,workspace_id),
  FOREIGN KEY (proposal_id,enrollment_id) REFERENCES adaptation_proposals(id,enrollment_id),
  FOREIGN KEY (attempt_id,enrollment_id) REFERENCES attempts(id,enrollment_id),
  CHECK ((status='pending') = (resolved_at IS NULL)),
  CHECK ((status IN ('passed','failed')) = (attempt_id IS NOT NULL))
);
