-- Operator/provider state is distinct from learner mastery and learning caps.
CREATE TABLE workspace_provider_settings (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id),
  revision integer NOT NULL CHECK(revision>0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE workspace_provider_versions (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  revision integer NOT NULL CHECK(revision>0),
  configuration jsonb NOT NULL,
  job_policy jsonb NOT NULL,
  sealed_credentials jsonb NOT NULL,
  changed_by uuid NOT NULL REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,revision)
);
ALTER TABLE workspace_provider_settings ADD CONSTRAINT workspace_provider_current
  FOREIGN KEY(workspace_id,revision) REFERENCES workspace_provider_versions(workspace_id,revision) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE supervisor_jobs ADD COLUMN provider_revision integer,
  ADD CONSTRAINT supervisor_provider_version FOREIGN KEY(workspace_id,provider_revision) REFERENCES workspace_provider_versions(workspace_id,revision);
CREATE TABLE provider_setup_receipts (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 200),
  request_digest text NOT NULL CHECK(request_digest~'^[a-f0-9]{64}$'),
  actor_id uuid NOT NULL REFERENCES app_users(id),
  operation text NOT NULL CHECK(operation IN ('configuration','budget')),
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,idempotency_key)
);
ALTER TABLE supervisor_workspace_budgets ADD COLUMN configuration_revision integer NOT NULL DEFAULT 0 CHECK(configuration_revision>=0);
ALTER TABLE supervisor_enrollment_budgets ADD COLUMN configuration_revision integer NOT NULL DEFAULT 0 CHECK(configuration_revision>=0);
