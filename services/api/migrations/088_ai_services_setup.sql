-- AI services setup (admin "AI services" page): named connections with a non-secret key ending,
-- one open setup draft per workspace, and a workspace default spending limit for each learner.
-- Nothing here is a secret: keys stay sealed in workspace_provider_versions.sealed_credentials.

-- A learner's budget row is created on first use with a limit of 0, so before this migration every
-- new learner was refused paid work until staff set a limit for that learner by hand. The workspace
-- default applies to every enrollment whose own limit was never set (limit_source='default').
ALTER TABLE supervisor_workspace_budgets
  ADD COLUMN default_enrollment_limit_micro_usd bigint
    CHECK (default_enrollment_limit_micro_usd BETWEEN 0 AND 1000000000),
  ADD COLUMN default_enrollment_limit_tokens bigint
    CHECK (default_enrollment_limit_tokens BETWEEN 0 AND 1000000000),
  ADD COLUMN default_enrollment_revision integer NOT NULL DEFAULT 0
    CHECK (default_enrollment_revision >= 0),
  ADD CONSTRAINT supervisor_default_enrollment_limit_pair
    CHECK ((default_enrollment_limit_micro_usd IS NULL) = (default_enrollment_limit_tokens IS NULL));
ALTER TABLE supervisor_enrollment_budgets
  ADD COLUMN limit_source text NOT NULL DEFAULT 'default' CHECK (limit_source IN ('default', 'own'));
-- Rows staff configured before keep their own limit, including an explicit zero.
UPDATE supervisor_enrollment_budgets SET limit_source = 'own'
  WHERE limit_micro_usd > 0 OR limit_tokens > 0 OR configuration_revision > 0;

-- Display facts of a connection (an adapter with its own key slot). The key ending is at most the
-- last four characters of a key of at least 16 characters, stored when the key is saved.
CREATE TABLE workspace_provider_connections (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  adapter_id text NOT NULL CHECK (adapter_id ~ '^[a-z0-9][a-z0-9-]{0,127}$'),
  name text NOT NULL DEFAULT '' CHECK (length(name) <= 80),
  key_ending text CHECK (key_ending ~ '^[!-~]{4}$'),
  key_status text NOT NULL DEFAULT 'untested'
    CHECK (key_status IN ('working', 'rejected', 'untested', 'unreachable')),
  key_reason text CHECK (key_reason ~ '^PROVIDER_[A-Z_]{1,80}$'),
  tested_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, adapter_id)
);

-- The workspace's single open setup draft: a configuration built by the server from the
-- operator's model choices (or the developer JSON editor). Activating it runs the same checks as
-- every other save, including the quality-check gate. Drafts never contain secrets.
CREATE TABLE provider_setup_drafts (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id),
  id uuid NOT NULL UNIQUE,
  base_revision integer NOT NULL CHECK (base_revision >= 0),
  source text NOT NULL CHECK (source IN ('models', 'json')),
  configuration jsonb NOT NULL,
  job_policy jsonb NOT NULL,
  created_by uuid NOT NULL REFERENCES app_users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE provider_setup_receipts DROP CONSTRAINT provider_setup_receipts_operation_check;
ALTER TABLE provider_setup_receipts ADD CONSTRAINT provider_setup_receipts_operation_check
  CHECK (operation IN ('configuration', 'budget', 'pricing', 'cost_settings', 'connection', 'activation'));
