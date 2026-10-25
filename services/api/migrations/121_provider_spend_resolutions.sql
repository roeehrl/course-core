-- An owner's decision on an AI call whose cost stayed unknown (provider-costs.ts, docs/provider-stalls.md).
--
-- A call that was sent but got no reply, or that stopped before the provider reported how much it
-- used, keeps its whole reservation charged and held (`provider_spend_ledger.state='uncertain'`,
-- `settled_at IS NULL`): Core never guesses an amount and never releases it on a timer. Once
-- nothing can settle it any more (its gateway receipt is final, or there is none), a workspace
-- owner or administrator may settle it explicitly: at zero (the reservation is released to the
-- budgets) or at the reservation (it stays charged). The ledger row is then closed, still
-- `uncertain` because the provider's outcome is still unknown, and this row records who decided
-- what, why and when. One decision per call; a repeated request with the same idempotency key
-- returns the same decision.
CREATE TABLE provider_spend_resolutions (
  id uuid PRIMARY KEY,
  ledger_id uuid NOT NULL UNIQUE REFERENCES provider_spend_ledger(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  decision text NOT NULL CHECK (decision IN ('zero', 'reservation')),
  reserved_micro_usd bigint NOT NULL CHECK (reserved_micro_usd >= 0),
  charged_micro_usd bigint NOT NULL CHECK (charged_micro_usd >= 0),
  released_micro_usd bigint NOT NULL CHECK (released_micro_usd >= 0),
  -- What the person checked (for example the provider's usage page). Staff text about a provider
  -- charge, never learner content.
  reason text NOT NULL CHECK (length(reason) BETWEEN 3 AND 500),
  actor_id uuid NOT NULL REFERENCES app_users(id),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  request_digest text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (workspace_id, idempotency_key),
  CHECK (charged_micro_usd + released_micro_usd = reserved_micro_usd),
  CHECK (decision <> 'zero' OR charged_micro_usd = 0),
  CHECK (decision <> 'reservation' OR released_micro_usd = 0)
);
CREATE INDEX provider_spend_resolutions_workspace ON provider_spend_resolutions(workspace_id, created_at DESC);
