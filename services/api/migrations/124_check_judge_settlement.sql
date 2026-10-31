-- How a failed check-judge call is settled (provider-gateway.ts, docs/provider-stalls.md).
--
-- The judge's call belongs to the companion operation, whose reply's own call answered and was
-- priced. A failed judge call no longer turns the whole operation into an unpriced charge at the
-- full reservation. The judge part is settled by the same policy as any call:
-- - `reported`: the provider reported usage (an answer, a malformed answer, usage up to a stop):
--   priced at that usage (judge_cost_micro_usd);
-- - `not_charged`: no byte of the request could have been accepted (the connection never opened)
--   or every attempt was refused with a documented rejection status: nothing is charged;
-- - `held`: sent, but no answer and no usage: the judge's own ceiling for that request stays charged
--   and held (judge_held_micro_usd) until an owner settles it, at zero or at the amount held
--   (provider-spend-resolutions.ts). The reply's call is still priced and recorded on its own.
-- Codes and amounts only.
ALTER TABLE provider_dispatches
  ADD COLUMN judge_settlement text CHECK(judge_settlement IS NULL OR judge_settlement IN('reported','not_charged','held')),
  ADD COLUMN judge_held_micro_usd bigint CHECK(judge_held_micro_usd IS NULL OR judge_held_micro_usd > 0),
  ADD CONSTRAINT provider_dispatch_judge_held CHECK((judge_settlement = 'held') = (judge_held_micro_usd IS NOT NULL));

-- The ledger row of such an operation records the reply's priced part on its own
-- (companion_actual_micro_usd) beside the judge's part: priced (judge_actual_micro_usd) or held
-- (judge_held_micro_usd, the row then `uncertain` and open until the owner's decision).
ALTER TABLE provider_spend_ledger
  ADD COLUMN companion_actual_micro_usd bigint CHECK(companion_actual_micro_usd IS NULL OR companion_actual_micro_usd >= 0),
  ADD COLUMN judge_held_micro_usd bigint CHECK(judge_held_micro_usd IS NULL OR judge_held_micro_usd > 0),
  ADD CONSTRAINT provider_spend_ledger_judge_held CHECK(judge_held_micro_usd IS NULL
    OR (state IN('uncertain','reconciled') AND companion_actual_micro_usd IS NOT NULL AND pricing_version_id IS NOT NULL
      AND companion_actual_micro_usd + judge_held_micro_usd <= reserved_micro_usd));
