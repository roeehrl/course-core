-- A learner may ask for a second opinion on a judged written answer. A different
-- reviewer re-reviews the same answer under the same rules; only a changed
-- decision replaces the original evidence.
CREATE TABLE rubric_appeals(
  id uuid PRIMARY KEY,attempt_id uuid NOT NULL UNIQUE REFERENCES attempts(id),enrollment_id uuid NOT NULL REFERENCES enrollments(id),
  reason text NOT NULL CHECK(length(reason) BETWEEN 10 AND 2000),
  state text NOT NULL DEFAULT 'open' CHECK(state IN('open','upheld','changed')),
  reviewer_id uuid REFERENCES app_users(id),decision text CHECK(decision IS NULL OR decision IN('met','not_met')),
  findings jsonb,reviewer_note text CHECK(reviewer_note IS NULL OR length(reviewer_note) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),decided_at timestamptz,
  CHECK((state='open')=(reviewer_id IS NULL AND decision IS NULL AND decided_at IS NULL))
);
CREATE INDEX rubric_appeals_open ON rubric_appeals(enrollment_id) WHERE state='open';
