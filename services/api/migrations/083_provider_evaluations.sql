-- Agent evaluation gate (requirements J04, N07). A new provider, model or prompt revision of an
-- agent role activates only with a passing evaluation of that exact revision against the current
-- eval suite, or an owner's recorded override. Both tables are append-only evidence bound to the
-- role revision digest and the suite digest. They hold grader codes, digests and staff-written
-- override reasons; never learner data, model answers or credentials.
CREATE TABLE provider_eval_results (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  role text NOT NULL CHECK (role IN ('supervisor','companion','research','media','reviewer')),
  revision_digest text NOT NULL CHECK (revision_digest ~ '^[a-f0-9]{64}$'),
  suite_id text NOT NULL CHECK (length(suite_id) BETWEEN 1 AND 120),
  suite_digest text NOT NULL CHECK (suite_digest ~ '^[a-f0-9]{64}$'),
  grader_version text NOT NULL CHECK (length(grader_version) BETWEEN 1 AND 100),
  mode text NOT NULL CHECK (mode IN ('scripted','live')),
  outcome text NOT NULL CHECK (outcome IN ('passed','failed')),
  grades jsonb NOT NULL CHECK (jsonb_typeof(grades) = 'array'),
  actor_id uuid NOT NULL REFERENCES app_users(id),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (workspace_id, idempotency_key, role)
);
CREATE INDEX provider_eval_results_lookup ON provider_eval_results (workspace_id, role, revision_digest, created_at DESC);

CREATE TABLE provider_eval_overrides (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  role text NOT NULL CHECK (role IN ('supervisor','companion','research','media','reviewer')),
  revision_digest text NOT NULL CHECK (revision_digest ~ '^[a-f0-9]{64}$'),
  suite_id text NOT NULL CHECK (length(suite_id) BETWEEN 1 AND 120),
  suite_digest text NOT NULL CHECK (suite_digest ~ '^[a-f0-9]{64}$'),
  reason text NOT NULL CHECK (length(reason) BETWEEN 20 AND 1000),
  actor_id uuid NOT NULL REFERENCES app_users(id),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (workspace_id, idempotency_key)
);
CREATE INDEX provider_eval_overrides_lookup ON provider_eval_overrides (workspace_id, role, revision_digest, created_at DESC);

-- Why each role of a provider version was allowed to activate. NULL marks a version saved before
-- the gate existed: it stays active (nothing is deactivated by this migration) and its roles are
-- reported as "not evaluated" until a new revision of them is activated through the gate.
ALTER TABLE workspace_provider_versions ADD COLUMN evaluation jsonb
  CHECK (evaluation IS NULL OR jsonb_typeof(evaluation) = 'object');
