-- Learner control over optional personal additions: hide and restore. Applied
-- adaptation history and evidence stay immutable; required changes cannot be hidden.
CREATE TABLE personal_change_visibility(
  enrollment_id uuid NOT NULL REFERENCES enrollments(id),episode_id text NOT NULL,block_id text NOT NULL,
  hidden boolean NOT NULL,changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(enrollment_id,episode_id,block_id)
);
