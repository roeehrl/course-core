-- People scopes and two more roles.
--
-- support_observer: read-only support staff. Sees course administration and the
--   workspace audit log, never learner-private material (learner-privacy.ts).
-- service: a non-human integration principal with read-only course access.
-- course_scoped: a member with no workspace-wide role. Their access to a course
--   comes only from an active course grant below; everywhere else they hold no
--   permission (the role is in no permission matrix and no staff-read list).
ALTER TABLE memberships DROP CONSTRAINT memberships_role_check;
ALTER TABLE memberships ADD CONSTRAINT memberships_role_check CHECK (role IN
  ('owner','admin','author','instructor','reviewer','learner','observer','support_observer','service','course_scoped'));

-- A course grant gives one member one role on one course until it expires or is
-- revoked. Grants never confer owner/admin/service. Rows are kept after expiry and
-- revocation as the record of who had access when; only revocation fields change.
CREATE TABLE course_access_grants (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  catalog_id uuid NOT NULL REFERENCES admin_course_catalog(id),
  user_id uuid NOT NULL REFERENCES app_users(id),
  role text NOT NULL CHECK (role IN ('author','instructor','reviewer','observer','support_observer')),
  reason_code text NOT NULL CHECK (reason_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  granted_by uuid NOT NULL REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_by uuid REFERENCES app_users(id),
  revoke_reason_code text CHECK (revoke_reason_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  CHECK (expires_at > created_at),
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL) AND (revoked_at IS NULL) = (revoke_reason_code IS NULL))
);
-- A grant only applies while its holder is a course_scoped member of the workspace;
-- removing the member revokes their open grants (people-routes.ts).
-- At most one unrevoked grant per person and course; an expired one is revoked
-- (reason 'expired') before a new one is made.
CREATE UNIQUE INDEX course_access_grants_one_open ON course_access_grants (catalog_id, user_id) WHERE revoked_at IS NULL;
CREATE INDEX course_access_grants_user ON course_access_grants (user_id, expires_at) WHERE revoked_at IS NULL;

CREATE FUNCTION course_access_grants_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'COURSE_GRANT_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF OLD.revoked_at IS NOT NULL OR NEW.id <> OLD.id OR NEW.workspace_id <> OLD.workspace_id OR NEW.catalog_id <> OLD.catalog_id
    OR NEW.user_id <> OLD.user_id OR NEW.role <> OLD.role OR NEW.reason_code <> OLD.reason_code OR NEW.granted_by <> OLD.granted_by
    OR NEW.created_at <> OLD.created_at OR NEW.expires_at <> OLD.expires_at THEN
    RAISE EXCEPTION 'COURSE_GRANT_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER course_access_grants_guard BEFORE UPDATE OR DELETE ON course_access_grants
  FOR EACH ROW EXECUTE FUNCTION course_access_grants_guard();
CREATE TRIGGER course_access_grants_no_truncate BEFORE TRUNCATE ON course_access_grants
  FOR EACH STATEMENT EXECUTE FUNCTION course_access_grants_guard();

-- The workspace audit log reads learning_events newest first.
CREATE INDEX learning_events_workspace_sequence ON learning_events (workspace_id, sequence DESC);
