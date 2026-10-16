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
  revoked_reason text CHECK (revoked_reason IN ('learner','erased')),
  last_used_at timestamptz,
  FOREIGN KEY (enrollment_id, workspace_id) REFERENCES enrollments(id, workspace_id),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '90 days'),
  CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL))
);
CREATE INDEX agent_tool_grants_enrollment ON agent_tool_grants (enrollment_id, created_at DESC);

-- One row per tool call: which grant called which tool and the outcome code. Never arguments,
-- results, learner text or the token.
CREATE TABLE agent_tool_calls (
  id uuid PRIMARY KEY,
  grant_id uuid NOT NULL REFERENCES agent_tool_grants(id),
  enrollment_id uuid NOT NULL REFERENCES enrollments(id),
  tool text NOT NULL CHECK (tool IN ('get_context','get_profile','get_evidence','get_history','propose_intervention')),
  outcome text NOT NULL CHECK (outcome ~ '^[A-Z0-9_]{1,64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX agent_tool_calls_grant ON agent_tool_calls (grant_id, created_at DESC);
