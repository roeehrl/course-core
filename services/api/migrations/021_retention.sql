-- Delayed independent checks on held-out items. Retention is recorded beside,
-- never instead of, demonstrated understanding; a failed check marks review.
ALTER TABLE attempts DROP CONSTRAINT attempts_mode_check;
ALTER TABLE attempts ADD CONSTRAINT attempts_mode_check CHECK (mode IN ('practice','independent','placement','retention'));
ALTER TABLE assessment_challenges DROP CONSTRAINT assessment_challenges_mode_check;
ALTER TABLE assessment_challenges ADD CONSTRAINT assessment_challenges_mode_check CHECK (mode IN ('practice','independent','placement','retention'));
CREATE TABLE retention_schedules(
  enrollment_id uuid NOT NULL REFERENCES enrollments(id),objective_id text NOT NULL,
  demonstrated_at timestamptz NOT NULL,step integer NOT NULL DEFAULT 0 CHECK(step>=0),
  due_at timestamptz,retained_at timestamptz,needs_review boolean NOT NULL DEFAULT false,
  last_attempt_id uuid REFERENCES attempts(id),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(enrollment_id,objective_id)
);
