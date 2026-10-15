-- Host policy settings a course release cannot yet author (SDK 0.5): the hard-deadline time
-- zone, DST disambiguation, extension approvals and offer limits, reserved core headroom,
-- the closed-course question budget and an optional study-pace estimate for feasibility.
-- Settings apply to new enrollments; an existing enrollment keeps the copy it started with.
-- An absent row means the documented defaults, which the admin page shows as such.
CREATE TABLE course_policy_settings(
  catalog_id uuid PRIMARY KEY REFERENCES admin_course_catalog(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  revision integer NOT NULL CHECK(revision > 0),
  settings jsonb NOT NULL CHECK(jsonb_typeof(settings) = 'object'),
  changed_by uuid NOT NULL REFERENCES app_users(id),
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- A reviewed cohort-wide policy change: the exact per-enrollment previews an administrator
-- saw, which shortened grants they acknowledged, and when it was applied. Holds identifiers
-- and policy terms only, never learner content.
CREATE TABLE policy_cohort_migrations(
  id uuid PRIMARY KEY,
  catalog_id uuid NOT NULL REFERENCES admin_course_catalog(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  actor_id uuid NOT NULL REFERENCES app_users(id),
  change jsonb NOT NULL,
  preview jsonb NOT NULL,
  preview_digest text NOT NULL CHECK(preview_digest ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK(state IN('previewed','applied')),
  reason text CHECK(reason IS NULL OR length(reason) BETWEEN 1 AND 1000),
  expires_at timestamptz NOT NULL,
  applied_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK((state = 'applied') = (applied_at IS NOT NULL))
);
CREATE INDEX policy_cohort_migrations_catalog ON policy_cohort_migrations(catalog_id, created_at DESC);
