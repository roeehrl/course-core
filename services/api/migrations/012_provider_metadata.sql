CREATE TABLE workspace_provider_inspections (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  provider_revision integer NOT NULL,
  adapter_id text NOT NULL CHECK(length(adapter_id) BETWEEN 1 AND 128),
  actor_id uuid NOT NULL REFERENCES app_users(id),
  idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 200),
  state text NOT NULL CHECK(state IN ('in_flight','complete','failed')),
  result jsonb,
  reason_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  deadline_at timestamptz NOT NULL,
  finished_at timestamptz,
  UNIQUE(workspace_id,idempotency_key),
  FOREIGN KEY(workspace_id,provider_revision) REFERENCES workspace_provider_versions(workspace_id,revision)
);
