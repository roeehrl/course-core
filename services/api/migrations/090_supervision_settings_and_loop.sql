-- Workspace AI supervision settings (requirement Q08, B06): how far the supervisor may act on its
-- own after a learner's opt-in, and which tool families it may use. One row per workspace; no row
-- means the defaults (apply verified personal changes, every tool family). Staff changes are
-- audited in workspace_audit. Holds settings only, never learner data.
CREATE TABLE supervision_settings (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id),
  autonomy_level text NOT NULL DEFAULT 'apply_verified_personal'
    CHECK (autonomy_level IN ('recommend_only', 'propose_only', 'apply_verified_personal')),
  permitted_tool_families text[] NOT NULL
    CHECK (cardinality(permitted_tool_families) <= 32 AND array_to_string(permitted_tool_families, ',') ~ '^([a-z][a-z_]{0,39}(,[a-z][a-z_]{0,39})*)?$'),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_by uuid REFERENCES app_users(id),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
