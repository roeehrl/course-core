-- Written explanations assessed against an author rubric. An attempt carries no
-- evidence until an authorized reviewer (never the learner) records criterion
-- findings with quotations from the learner's own response.
CREATE TABLE rubric_reviews(
  id uuid PRIMARY KEY,attempt_id uuid NOT NULL UNIQUE REFERENCES attempts(id),enrollment_id uuid NOT NULL REFERENCES enrollments(id),
  reviewer_id uuid NOT NULL REFERENCES app_users(id),decision text NOT NULL CHECK(decision IN('met','not_met','needs_clarification')),
  criteria jsonb NOT NULL,learner_note text CHECK(learner_note IS NULL OR length(learner_note) BETWEEN 1 AND 2000),
  rubric_digest text NOT NULL CHECK(rubric_digest~'^[a-f0-9]{64}$'),created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX rubric_reviews_enrollment ON rubric_reviews(enrollment_id,created_at DESC);
