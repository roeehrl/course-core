-- Course updates: where a course's new packages come from (a public GitHub release URL, or a
-- folder inside one of the host's configured package directories, named by the directory's id
-- and a relative subpath, never an absolute host path), its automatic-update setting and the
-- outcome of the latest check. One row per course (workspace + course key).
CREATE TABLE course_update_sources (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  course_key text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('github', 'path')),
  url text CHECK (url IS NULL OR (url ~ '^https://github\.com/' AND length(url) <= 2048)),
  root_id text CHECK (root_id IS NULL OR root_id ~ '^[a-f0-9]{16}$'),
  subpath text CHECK (subpath IS NULL OR length(subpath) <= 1024),
  -- off (default) | check | install | publish. publish needs acknowledged_by (an actor that held
  -- release.review and release.publish when saving) and an explicit acknowledgement.
  level text NOT NULL DEFAULT 'off' CHECK (level IN ('off', 'check', 'install', 'publish')),
  interval_hours integer NOT NULL DEFAULT 24 CHECK (interval_hours BETWEEN 1 AND 720),
  -- publish only: the acknowledgement also covers approving a registry whose digest changed.
  auto_approve_registry boolean NOT NULL DEFAULT false,
  acknowledged_by uuid REFERENCES app_users(id),
  acknowledged_at timestamptz,
  revision integer NOT NULL DEFAULT 1,
  updated_by uuid NOT NULL REFERENCES app_users(id),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  next_check_at timestamptz,
  last_checked_at timestamptz,
  last_trigger text CHECK (last_trigger IS NULL OR last_trigger IN ('manual', 'automatic')),
  last_result text CHECK (last_result IS NULL OR last_result IN ('up_to_date', 'update_available', 'installed', 'published', 'failed')),
  last_error_code text CHECK (last_error_code IS NULL OR last_error_code ~ '^[A-Z0-9_]{1,80}$'),
  available_version text CHECK (available_version IS NULL OR length(available_version) <= 128),
  available_sha256 text CHECK (available_sha256 IS NULL OR available_sha256 ~ '^[a-f0-9]{64}$'),
  consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  PRIMARY KEY (workspace_id, course_key),
  CHECK ((kind = 'github') = (url IS NOT NULL) AND (kind = 'path') = (root_id IS NOT NULL AND subpath IS NOT NULL)),
  CHECK (level <> 'publish' OR acknowledged_by IS NOT NULL),
  CHECK (level = 'publish' OR NOT auto_approve_registry)
);
CREATE INDEX course_update_sources_due ON course_update_sources (next_check_at) WHERE level <> 'off';

-- Every check attempt, manual or automatic (codes and versions only).
CREATE TABLE course_update_attempts (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  course_key text NOT NULL,
  trigger text NOT NULL CHECK (trigger IN ('manual', 'automatic')),
  attempted_at timestamptz NOT NULL,
  result text NOT NULL CHECK (result IN ('up_to_date', 'update_available', 'installed', 'published', 'failed')),
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[A-Z0-9_]{1,80}$'),
  version text CHECK (version IS NULL OR length(version) <= 128),
  package_sha256 text CHECK (package_sha256 IS NULL OR package_sha256 ~ '^[a-f0-9]{64}$'),
  release_id uuid REFERENCES course_releases(id)
);
CREATE INDEX course_update_attempts_course ON course_update_attempts (workspace_id, course_key, attempted_at DESC);
