-- A written answer can continue as a short conversation: the reviewer asks for
-- clarification and the learner replies. The reviewer judges the exchange; only
-- a neutral probe (declared by the reviewer, no hint) keeps the reply independent.
ALTER TABLE attempts ADD COLUMN continues_attempt_id uuid REFERENCES attempts(id);
CREATE UNIQUE INDEX attempts_one_reply ON attempts(continues_attempt_id) WHERE continues_attempt_id IS NOT NULL;
ALTER TABLE rubric_reviews ADD COLUMN probe_only boolean NOT NULL DEFAULT false;
