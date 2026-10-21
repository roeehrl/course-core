-- A quality check can also check the active setup (target 'active'): the jobs that are on without
-- a passing check or an owner approval for their current revision and the current suite, for
-- example after an upgrade brought new checks. Such a check belongs to no setup draft. Additive:
-- every existing row is a draft check and keeps its draft.
ALTER TABLE provider_quality_checks ALTER COLUMN draft_id DROP NOT NULL;
ALTER TABLE provider_quality_checks
  ADD COLUMN target text NOT NULL DEFAULT 'draft' CHECK (target IN ('draft', 'active'));
ALTER TABLE provider_quality_checks
  ADD CONSTRAINT provider_quality_checks_target_draft CHECK ((target = 'draft') = (draft_id IS NOT NULL));
