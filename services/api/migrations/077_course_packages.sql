-- Course packages (course-package v1). An inspected, verified package is staged here for a short
-- time, keyed by the SHA-256 of its compressed bytes, so installing it does not fetch or upload it
-- again. Rows expire (the installer deletes expired rows and keeps at most a few per workspace).
CREATE TABLE course_package_staging (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  bytes bytea NOT NULL CHECK (octet_length(bytes) <= 67108864),
  -- Where it came from: {"kind":"upload"} or {"kind":"github",owner,repo,tag,asset,checksumVerified}.
  source jsonb NOT NULL,
  staged_by uuid NOT NULL REFERENCES app_users(id),
  staged_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, sha256)
);
CREATE INDEX course_package_staging_expiry ON course_package_staging (expires_at);

-- The package a release was installed from: its digest and source, and the adaptation (recovery)
-- registry it carried, staged here until an owner/admin approves exactly that digest for the release.
CREATE TABLE course_release_packages (
  release_id uuid PRIMARY KEY REFERENCES course_releases(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  package_sha256 text NOT NULL CHECK (package_sha256 ~ '^[a-f0-9]{64}$'),
  source jsonb NOT NULL,
  sdk_version text NOT NULL,
  minimum_core_version text NOT NULL,
  registry_configuration jsonb,
  registry_digest text CHECK (registry_digest IS NULL OR registry_digest ~ '^[a-f0-9]{64}$'),
  installed_by uuid NOT NULL REFERENCES app_users(id),
  installed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((registry_configuration IS NULL) = (registry_digest IS NULL)),
  UNIQUE (workspace_id, package_sha256)
);
