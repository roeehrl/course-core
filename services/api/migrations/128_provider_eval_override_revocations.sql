-- Withdrawn owner approvals ("approved without checking"), agent-evals/gate.ts. Turning a job off
-- (provider-setup.ts `turnOff`) withdraws every approval of that job's revisions, so turning the
-- same model on again needs a quality check or a fresh owner approval instead of silently reusing
-- the old one. The approval row itself stays as it was (append-only evidence); a revocation is its
-- own append-only row. Codes and ids only.
CREATE TABLE provider_eval_override_revocations (
  override_id uuid PRIMARY KEY REFERENCES provider_eval_overrides(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  reason text NOT NULL CHECK (reason IN ('role_turned_off')),
  provider_revision integer NOT NULL CHECK (provider_revision >= 0),
  actor_id uuid NOT NULL REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX provider_eval_override_revocations_workspace ON provider_eval_override_revocations (workspace_id, created_at DESC);
