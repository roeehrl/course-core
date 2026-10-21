-- Course-supplied extensions (course-supplied-extensions.ts). A course package may carry the exact
-- bytes of two kinds of extension Core can run without a host-installed copy: a data-only code
-- fixture registry (hidden cases Core's own grader checks learner code against in the sandbox) and
-- a sandboxed_web activity script (served only inside the opaque-origin activity frame). An
-- owner/admin approves the exact bytes when installing the package; the approval and the bytes are
-- kept here and loaded at startup. Rows are never changed: a new version is a new release's row.
CREATE TABLE course_supplied_extensions (
  release_id uuid NOT NULL REFERENCES course_releases(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  extension_id text NOT NULL CHECK (extension_id ~ '^[a-z][a-z0-9-]{0,100}$'),
  version text NOT NULL CHECK (version ~ '^\d+\.\d+\.\d+$'),
  integrity text NOT NULL CHECK (integrity ~ '^sha256-[a-f0-9]{64}$'),
  kind text NOT NULL CHECK (kind IN ('code_fixtures', 'sandboxed_web')),
  member_name text NOT NULL CHECK (char_length(member_name) BETWEEN 1 AND 255),
  content bytea NOT NULL CHECK (octet_length(content) <= 1048576),
  approved_by uuid NOT NULL REFERENCES app_users(id),
  approved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (release_id, extension_id)
);
CREATE INDEX course_supplied_extensions_identity ON course_supplied_extensions (extension_id, integrity);

CREATE FUNCTION course_supplied_extensions_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'course-supplied extensions are immutable';
END $$;
CREATE TRIGGER course_supplied_extensions_immutable BEFORE UPDATE ON course_supplied_extensions
  FOR EACH ROW EXECUTE FUNCTION course_supplied_extensions_immutable();
