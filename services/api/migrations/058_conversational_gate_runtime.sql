-- Conversational gate runtime (audit #11).
-- The supervisor may propose quoted findings for a gate conversation itself, without a staff
-- request; the learner's review-assistance consent still governs every proposal.
ALTER TABLE rubric_assist_requests ALTER COLUMN requested_by DROP NOT NULL;
ALTER TABLE rubric_assist_requests ADD COLUMN origin text NOT NULL DEFAULT 'staff' CHECK (origin IN ('staff','supervisor'));
ALTER TABLE rubric_assist_requests ADD CONSTRAINT rubric_assist_requests_origin_requester CHECK ((origin='staff') = (requested_by IS NOT NULL));

-- What an installed deterministic evaluator concluded about a verified proposal. It is recorded
-- whether or not it confirmed, so reviewers see why an answer is still waiting for them.
ALTER TABLE rubric_suggestions ADD COLUMN automatic_check jsonb CHECK (automatic_check IS NULL OR jsonb_typeof(automatic_check)='object');

-- A judgment is confirmed by a human reviewer, or by an installed deterministic evaluator
-- checking a verified, quoted proposal. Deterministic confirmation only ever records "met":
-- anything it cannot confirm stays pending for a human.
ALTER TABLE rubric_reviews ALTER COLUMN reviewer_id DROP NOT NULL;
ALTER TABLE rubric_reviews ADD COLUMN confirmation text NOT NULL DEFAULT 'human' CHECK (confirmation IN ('human','deterministic'));
ALTER TABLE rubric_reviews ADD COLUMN confirmer jsonb;
ALTER TABLE rubric_reviews ADD CONSTRAINT rubric_reviews_confirmation_actor CHECK (
  (confirmation='human' AND reviewer_id IS NOT NULL AND confirmer IS NULL)
  OR (confirmation='deterministic' AND reviewer_id IS NULL AND jsonb_typeof(confirmer)='object' AND suggestion_id IS NOT NULL AND decision='met' AND NOT probe_only));
