-- External agent tools (agent-tools-routes.ts). A learner grants one external agent a scoped,
-- expiring, revocable token for ONE of their enrollments. Only a SHA-256 digest of the token is
-- kept; the token itself is shown once to the learner and never stored, logged or echoed.
CREATE TABLE agent_tool_grants (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  enrollment_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES app_users(id),
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 80),
  scopes text[] NOT NULL CHECK (cardinality(scopes) BETWEEN 1 AND 5
    AND scopes <@ ARRAY['context','profile','evidence','history','propose_intervention']::text[]),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_reason text CHECK (revoked_reason IN ('learner','erased','membership_removed')),
  last_used_at timestamptz,
  FOREIGN KEY (enrollment_id, workspace_id) REFERENCES enrollments(id, workspace_id),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '90 days'),
  CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL))
);
CREATE INDEX agent_tool_grants_enrollment ON agent_tool_grants (enrollment_id, created_at DESC);

-- One row per call (tool calls, MCP protocol requests, unknown tools and failed calls alike):
-- which grant, what was asked and the outcome code. Never arguments, results, learner text or the
-- token. The row is written before the call runs, under a per-enrollment lock, so it is also the
-- rate-limit reservation (agent-tools-routes.ts).
CREATE TABLE agent_tool_calls (
  id uuid PRIMARY KEY,
  grant_id uuid NOT NULL REFERENCES agent_tool_grants(id),
  enrollment_id uuid NOT NULL REFERENCES enrollments(id),
  tool text NOT NULL CHECK (tool IN ('get_context','get_profile','get_evidence','get_history','propose_intervention',
    'mcp_initialize','mcp_ping','mcp_tools_list','mcp_other','unknown_tool')),
  outcome text NOT NULL CHECK (outcome ~ '^[A-Z0-9_]{1,64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX agent_tool_calls_grant ON agent_tool_calls (grant_id, created_at DESC);
CREATE INDEX agent_tool_calls_enrollment ON agent_tool_calls (enrollment_id, created_at DESC);

-- A grant ends with the learner's membership: removing them from the workspace revokes it for
-- good, so adding them back later does not bring an old key back to life.
CREATE FUNCTION agent_tool_grants_membership_removed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE agent_tool_grants SET revoked_at=clock_timestamp(),revoked_reason='membership_removed'
   WHERE workspace_id=OLD.workspace_id AND user_id=OLD.user_id AND revoked_at IS NULL;
  RETURN OLD;
END $$;
CREATE TRIGGER memberships_revoke_agent_grants AFTER DELETE ON memberships
  FOR EACH ROW EXECUTE FUNCTION agent_tool_grants_membership_removed();
