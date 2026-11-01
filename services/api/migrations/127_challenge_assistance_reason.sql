-- Why an open question became practice, so the learner app can say it (learner-snapshot.ts,
-- practiceReason): the learner asked the companion while it counted, used a hint, opened the
-- explanation, or asked for a fresh question. Written with the downgrade itself
-- (companion-ask-route.ts, assessment-routes.ts, adaptation-store.ts). A code only; the app words it.
-- Additive: questions downgraded before this migration keep NULL and show no reason, never a guess.
ALTER TABLE assessment_challenges
  ADD COLUMN assistance_reason text CHECK (assistance_reason IS NULL OR assistance_reason IN ('companion','hint','solution','fresh_question'));
