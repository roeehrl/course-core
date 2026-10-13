-- A reviewer may ask again for an AI draft when the earlier request can no longer
-- produce one: its job failed or was cancelled, it was never admitted, or the
-- learner's consent grant it was made under has ended. The earlier request is
-- kept as superseded for audit; at most one request per answer is live.
ALTER TABLE rubric_assist_requests DROP CONSTRAINT rubric_assist_requests_state_check;
ALTER TABLE rubric_assist_requests ADD CONSTRAINT rubric_assist_requests_state_check CHECK(state IN('requested','suggested','superseded'));
ALTER TABLE rubric_assist_requests DROP CONSTRAINT rubric_assist_requests_attempt_id_key;
CREATE UNIQUE INDEX rubric_assist_requests_one_live ON rubric_assist_requests(attempt_id) WHERE state<>'superseded';
CREATE INDEX rubric_assist_requests_attempt ON rubric_assist_requests(attempt_id);
