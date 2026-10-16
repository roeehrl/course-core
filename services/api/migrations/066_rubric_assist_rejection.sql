-- A reviewer draft that Core's own checks refused (no quotations, quotations that are not the
-- learner's words, wrong criteria, too large) is a definite outcome, not an uncertain provider
-- submission: the request ends as 'rejected' with the reason, and a reviewer may ask again.
ALTER TABLE rubric_assist_requests DROP CONSTRAINT rubric_assist_requests_state_check;
ALTER TABLE rubric_assist_requests ADD CONSTRAINT rubric_assist_requests_state_check CHECK(state IN('requested','suggested','rejected','superseded'));
ALTER TABLE rubric_assist_requests ADD COLUMN rejection_reason text
  CHECK (rejection_reason IN ('no_quotes','quote_not_in_answer','criteria_mismatch','output_too_large','host_check_failed'));
-- A superseded request keeps the reason it was rejected for, for audit.
ALTER TABLE rubric_assist_requests ADD CONSTRAINT rubric_assist_requests_rejection_reason
  CHECK ((state='rejected' AND rejection_reason IS NOT NULL) OR (state IN ('requested','suggested') AND rejection_reason IS NULL) OR state='superseded');
