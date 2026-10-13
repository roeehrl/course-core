-- Membership administration: when a member joined, who added them, and a
-- workspace-scoped idempotency receipt for people commands. Receipts never
-- store sign-in codes.
ALTER TABLE memberships ADD COLUMN created_at timestamptz NOT NULL DEFAULT clock_timestamp();
ALTER TABLE memberships ADD COLUMN added_by uuid REFERENCES app_users(id);
CREATE TABLE people_command_receipts(
  workspace_id uuid NOT NULL REFERENCES workspaces(id),idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 128),
  request_digest text NOT NULL,actor_id uuid NOT NULL REFERENCES app_users(id),response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(workspace_id,idempotency_key)
);
