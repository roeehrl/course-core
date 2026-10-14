-- Read-only "view as learner" for workspace owners and admins. Every opening is
-- recorded before any learner data is read: who (and in which role), which
-- enrollment, at which enrollment revision, and when. Rows hold no learner
-- content, are shown to the learner and included in their data export, and can
-- be neither changed nor removed (erasure keeps them as part of the audit
-- skeleton). The runtime role receives ordinary DML grants on startup; the
-- trigger below refuses UPDATE and DELETE for every role.
CREATE TABLE staff_learner_views(
  id uuid PRIMARY KEY,
  enrollment_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  viewer_id uuid NOT NULL REFERENCES app_users(id),
  viewer_role text NOT NULL CHECK (viewer_role IN ('owner','admin')),
  enrollment_revision integer NOT NULL CHECK (enrollment_revision > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (enrollment_id, workspace_id) REFERENCES enrollments(id, workspace_id)
);
CREATE INDEX staff_learner_views_enrollment ON staff_learner_views (enrollment_id, created_at);
CREATE FUNCTION staff_learner_views_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'STAFF_VIEW_AUDIT_IMMUTABLE' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER staff_learner_views_append_only BEFORE UPDATE OR DELETE ON staff_learner_views
  FOR EACH ROW EXECUTE FUNCTION staff_learner_views_append_only();
