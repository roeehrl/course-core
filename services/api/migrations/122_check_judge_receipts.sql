-- The check judge of graded-check integrity (companion-check-judge.ts, docs/companion-check-integrity.md).
--
-- A companion reply in check-coaching mode is judged by a second model call before it is kept.
-- That call belongs to the same supervisor operation and is charged to its one reservation: the
-- dispatch's cost_micro_usd, and so the ledger row's charged and actual amounts, are the reply's
-- call plus the judge's. The judge's own model, price version, cost, usage receipt and verdict code
-- are recorded beside them, on the dispatch and on its ledger row. Codes and counts only: no
-- learner text, no reply, no judge reasoning.
ALTER TABLE provider_dispatches
  ADD COLUMN judge_model_id text CHECK(judge_model_id IS NULL OR length(judge_model_id) BETWEEN 1 AND 2048),
  ADD COLUMN judge_pricing_version_id uuid REFERENCES provider_model_prices(id),
  ADD COLUMN judge_cost_micro_usd bigint CHECK(judge_cost_micro_usd IS NULL OR judge_cost_micro_usd >= 0),
  ADD COLUMN judge_usage jsonb,
  ADD COLUMN judge_verdict text CHECK(judge_verdict IS NULL OR length(judge_verdict) BETWEEN 1 AND 120),
  ADD CONSTRAINT provider_dispatch_judge_cost_priced CHECK(judge_cost_micro_usd IS NULL OR judge_pricing_version_id IS NOT NULL);

ALTER TABLE provider_spend_ledger
  ADD COLUMN judge_model_id text CHECK(judge_model_id IS NULL OR length(judge_model_id) BETWEEN 1 AND 2048),
  ADD COLUMN judge_pricing_version_id uuid REFERENCES provider_model_prices(id),
  ADD COLUMN judge_actual_micro_usd bigint CHECK(judge_actual_micro_usd IS NULL OR judge_actual_micro_usd >= 0),
  ADD CONSTRAINT provider_spend_ledger_judge_reconciled CHECK(judge_actual_micro_usd IS NULL
    OR (state = 'reconciled' AND judge_pricing_version_id IS NOT NULL AND judge_actual_micro_usd <= actual_micro_usd));
