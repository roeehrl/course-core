-- How the workspace treats learners whose own spending limit was never set (limit_source='default').
-- 'unset': nothing chosen yet, so those learners get no paid AI work (as before this migration).
-- 'limit': each such learner may spend up to default_enrollment_limit_* in total.
-- 'unlimited': the owner chose not to cap learners one by one. The workspace total, and each
--   learner's daily, per-lesson and own limits, still apply. It is an explicit choice, never a
--   missing value: a NULL amount alone still means "nothing chosen", which pays for nothing.
ALTER TABLE supervisor_workspace_budgets
  ADD COLUMN default_enrollment_limit_mode text NOT NULL DEFAULT 'unset'
    CHECK (default_enrollment_limit_mode IN ('unset', 'limit', 'unlimited'));
UPDATE supervisor_workspace_budgets SET default_enrollment_limit_mode = 'limit'
  WHERE default_enrollment_limit_micro_usd IS NOT NULL;
ALTER TABLE supervisor_workspace_budgets
  ADD CONSTRAINT supervisor_default_enrollment_limit_mode_amounts
    CHECK ((default_enrollment_limit_mode = 'limit') = (default_enrollment_limit_micro_usd IS NOT NULL));
