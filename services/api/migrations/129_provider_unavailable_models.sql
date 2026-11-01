-- Models a provider answered "not found" for (HTTP 404 NOT_FOUND) during a quality check, per
-- workspace connection (provider-quality-checks.ts). A provider's model list can still name a model
-- that its generation endpoint refuses for this key; the admin model picker no longer offers or
-- suggests a model recorded here, and a draft cannot newly choose it. A row goes away when the
-- connection's key changes or when the provider's model list no longer names the model.
-- Codes and numbers only: never a response body, message, prompt or key.
CREATE TABLE provider_unavailable_models (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  connection_id text NOT NULL CHECK (length(connection_id) BETWEEN 1 AND 128),
  remote_model text NOT NULL CHECK (length(remote_model) BETWEEN 1 AND 2048),
  reason_code text NOT NULL CHECK (reason_code IN ('PROVIDER_GUIDE_MODEL_UNAVAILABLE')),
  provider_status integer CHECK (provider_status IS NULL OR provider_status BETWEEN 100 AND 599),
  provider_reason text CHECK (provider_reason IS NULL OR length(provider_reason) <= 128),
  check_id uuid REFERENCES provider_quality_checks(id),
  marked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, connection_id, remote_model)
);
