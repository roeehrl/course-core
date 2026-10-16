-- Course-declared admin sections (SDK defineAdminSection). A release declares each
-- section's settings schema; Core renders the form and stores here only the values
-- staff set, one row per section and scope target (the course, one chapter or one
-- enrollment). Values are validated against the active release's declaration on every
-- write and read again against the declaration that applies when used, so a later
-- release that narrows a setting falls back to its default instead of trusting an old
-- value. Every change is also written to learning_events as
-- admin_section.settings_changed (the section's audit: all_mutations).
CREATE TABLE admin_section_values (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  course_key text NOT NULL,
  section_id text NOT NULL CHECK (length(section_id) BETWEEN 1 AND 200),
  scope text NOT NULL CHECK (scope IN ('course','chapter','enrollment')),
  -- '' for the course; the chapter id or the enrollment id otherwise.
  scope_ref text NOT NULL CHECK (length(scope_ref) <= 200),
  setting_values jsonb NOT NULL CHECK (jsonb_typeof(setting_values) = 'object'),
  section_version text NOT NULL CHECK (length(section_version) BETWEEN 1 AND 100),
  revision integer NOT NULL CHECK (revision >= 1),
  updated_by uuid NOT NULL REFERENCES app_users(id),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, course_key, section_id, scope, scope_ref),
  CHECK ((scope = 'course') = (scope_ref = ''))
);
