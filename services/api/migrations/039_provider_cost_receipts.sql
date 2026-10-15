-- Operator-entered model prices, provider cost receipts and reserved-versus-actual spend.
-- Money is integer micro-USD. Token prices are micro-USD per million tokens.

-- Append-only price versions per workspace model. The version in force at a moment is the
-- newest version whose effective_from is not later than that moment. A withdrawn version
-- carries no prices: from its effective time the model is unpriced again.
CREATE TABLE provider_model_prices(
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  model_id text NOT NULL CHECK(length(model_id) BETWEEN 1 AND 2048),
  version integer NOT NULL CHECK(version > 0),
  status text NOT NULL CHECK(status IN('active','withdrawn')),
  currency text NOT NULL CHECK(currency = 'USD'),
  input_micro_usd_per_million bigint CHECK(input_micro_usd_per_million BETWEEN 0 AND 1000000000),
  output_micro_usd_per_million bigint CHECK(output_micro_usd_per_million BETWEEN 0 AND 1000000000),
  cached_input_micro_usd_per_million bigint CHECK(cached_input_micro_usd_per_million BETWEEN 0 AND 1000000000),
  micro_usd_per_request bigint CHECK(micro_usd_per_request BETWEEN 0 AND 100000000),
  micro_usd_per_output_second bigint CHECK(micro_usd_per_output_second BETWEEN 0 AND 100000000),
  effective_from timestamptz NOT NULL,
  source_note text NOT NULL CHECK(length(source_note) BETWEEN 3 AND 500),
  created_by uuid NOT NULL REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(workspace_id, model_id, version),
  CHECK((input_micro_usd_per_million IS NULL) = (output_micro_usd_per_million IS NULL)),
  CHECK(cached_input_micro_usd_per_million IS NULL OR input_micro_usd_per_million IS NOT NULL),
  CHECK(status = 'withdrawn' OR input_micro_usd_per_million IS NOT NULL OR micro_usd_per_request IS NOT NULL
    OR micro_usd_per_output_second IS NOT NULL),
  CHECK(status = 'active' OR (input_micro_usd_per_million IS NULL AND micro_usd_per_request IS NULL
    AND micro_usd_per_output_second IS NULL))
);
CREATE INDEX provider_model_prices_in_force ON provider_model_prices(workspace_id, model_id, effective_from DESC, version DESC);

-- Absent row means the default: paid work needs a price in force for the bound model.
CREATE TABLE workspace_cost_settings(
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id),
  require_priced_models boolean NOT NULL,
  revision integer NOT NULL CHECK(revision > 0),
  changed_by uuid NOT NULL REFERENCES app_users(id),
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

ALTER TABLE provider_dispatches
  ADD COLUMN model_id text CHECK(model_id IS NULL OR length(model_id) BETWEEN 1 AND 2048),
  ADD COLUMN pricing_version_id uuid REFERENCES provider_model_prices(id),
  ADD COLUMN cost_micro_usd bigint CHECK(cost_micro_usd IS NULL OR cost_micro_usd >= 0),
  ADD CONSTRAINT provider_dispatch_cost_priced CHECK(cost_micro_usd IS NULL OR pricing_version_id IS NOT NULL);

-- One row per paid admission. reserved is the per-job allowance taken at admission; the
-- budgets are charged `charged` now: the reservation while in flight, uncertain or unpriced,
-- the actual cost once reconciled, zero when the call certainly never started.
CREATE TABLE provider_spend_ledger(
  id uuid PRIMARY KEY,
  source text NOT NULL CHECK(source IN('supervisor','media')),
  source_ref text NOT NULL CHECK(length(source_ref) BETWEEN 1 AND 200),
  attempt integer NOT NULL CHECK(attempt BETWEEN 1 AND 16),
  workspace_id uuid NOT NULL,
  enrollment_id uuid NOT NULL,
  role text NOT NULL CHECK(role IN('supervisor','companion','research','media','reviewer')),
  model_id text CHECK(model_id IS NULL OR length(model_id) BETWEEN 1 AND 2048),
  pricing_version_id uuid REFERENCES provider_model_prices(id),
  state text NOT NULL CHECK(state IN('reserved','uncertain','reconciled','unpriced','not_started')),
  reserved_micro_usd bigint NOT NULL CHECK(reserved_micro_usd >= 0),
  reserved_tokens bigint NOT NULL CHECK(reserved_tokens >= 0),
  actual_micro_usd bigint CHECK(actual_micro_usd IS NULL OR actual_micro_usd >= 0),
  charged_micro_usd bigint NOT NULL CHECK(charged_micro_usd >= 0),
  released_micro_usd bigint NOT NULL DEFAULT 0 CHECK(released_micro_usd >= 0),
  reserved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  settled_at timestamptz,
  UNIQUE(source, source_ref, attempt),
  FOREIGN KEY(enrollment_id, workspace_id) REFERENCES enrollments(id, workspace_id),
  CHECK((state = 'reconciled') = (actual_micro_usd IS NOT NULL)),
  CHECK(state <> 'reconciled' OR pricing_version_id IS NOT NULL),
  CHECK(released_micro_usd <= reserved_micro_usd),
  CHECK(state IN('reserved','uncertain') OR settled_at IS NOT NULL)
);
CREATE INDEX provider_spend_ledger_workspace ON provider_spend_ledger(workspace_id, reserved_at);
CREATE INDEX provider_spend_ledger_enrollment ON provider_spend_ledger(enrollment_id, reserved_at);

ALTER TABLE provider_setup_receipts DROP CONSTRAINT provider_setup_receipts_operation_check;
ALTER TABLE provider_setup_receipts ADD CONSTRAINT provider_setup_receipts_operation_check
  CHECK(operation IN('configuration','budget','pricing','cost_settings'));
