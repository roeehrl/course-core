-- Organization ceilings: the outermost level of the policy hierarchy
-- (organization → course → enrollment → chapter → episode). A workspace may set an end date,
-- a longest enrollment, work caps, whether extensions exist at all and whether finished
-- learners keep reading access. Every level below may only tighten these. Like course policy
-- settings, a new enrollment copies the ceilings in force when it starts.
CREATE TABLE organization_policy_ceilings(
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id),
  revision integer NOT NULL CHECK(revision>0),
  ceilings jsonb NOT NULL CHECK(jsonb_typeof(ceilings)='object'),
  changed_by uuid NOT NULL REFERENCES app_users(id),
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Every saved revision of organization ceilings and course policy settings, with who saved it
-- and the reason they gave. The current row stays in its own table; this is the history.
CREATE TABLE policy_setting_revisions(
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  level text NOT NULL CHECK(level IN('organization','course')),
  catalog_id uuid REFERENCES admin_course_catalog(id),
  revision integer NOT NULL CHECK(revision>0),
  settings jsonb NOT NULL CHECK(jsonb_typeof(settings)='object'),
  reason text CHECK(reason IS NULL OR length(reason) BETWEEN 1 AND 1000),
  changed_by uuid REFERENCES app_users(id),
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK((level='course')=(catalog_id IS NOT NULL))
);
CREATE UNIQUE INDEX policy_setting_revisions_one ON policy_setting_revisions(workspace_id,level,coalesce(catalog_id,'00000000-0000-0000-0000-000000000000'::uuid),revision);
INSERT INTO policy_setting_revisions(workspace_id,level,catalog_id,revision,settings,changed_by,changed_at)
  SELECT workspace_id,'course',catalog_id,revision,settings,changed_by,changed_at FROM course_policy_settings;

-- One reviewed accommodation or outage adjustment applied to several learners at once. The
-- batch keeps who previewed and applied it, the exact per-learner preview, the reason and
-- which learners it reached; each learner's own ledger entry names the batch.
CREATE TABLE policy_accommodation_batches(
  id uuid PRIMARY KEY,
  catalog_id uuid NOT NULL REFERENCES admin_course_catalog(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  actor_id uuid NOT NULL REFERENCES app_users(id),
  kind text NOT NULL CHECK(kind IN('accommodation','outage')),
  scope_id text NOT NULL CHECK(length(scope_id) BETWEEN 1 AND 200),
  change jsonb NOT NULL CHECK(jsonb_typeof(change)='object'),
  preview jsonb NOT NULL CHECK(jsonb_typeof(preview)='object'),
  preview_digest text NOT NULL CHECK(preview_digest ~ '^[a-f0-9]{64}$'),
  state text NOT NULL DEFAULT 'previewed' CHECK(state IN('previewed','applied')),
  reason text CHECK(reason IS NULL OR length(reason) BETWEEN 1 AND 300),
  applied_count integer CHECK(applied_count IS NULL OR applied_count>=0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  applied_at timestamptz,
  CHECK((state='applied')=(applied_at IS NOT NULL AND reason IS NOT NULL AND applied_count IS NOT NULL))
);
CREATE INDEX policy_accommodation_batches_course ON policy_accommodation_batches(catalog_id,created_at DESC);

-- The optional continuation track after closure: a separate, opt-in path for spaced review
-- and reading. It never reopens the closed enrollment, adds required work or changes its
-- closure report. The learner opts in explicitly and may stop at any time.
CREATE TABLE continuation_tracks(
  enrollment_id uuid PRIMARY KEY REFERENCES enrollments(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  state text NOT NULL CHECK(state IN('active','stopped')),
  focus text NOT NULL DEFAULT 'review' CHECK(focus IN('review')),
  opted_in_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  stopped_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  CHECK((state='stopped')=(stopped_at IS NOT NULL))
);
