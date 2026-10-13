CREATE UNIQUE INDEX course_release_catalogue_identity ON course_releases(id,workspace_id,course_key);
ALTER TABLE admin_course_catalog ADD COLUMN active_release_id uuid;
ALTER TABLE admin_course_catalog ADD CONSTRAINT active_release_catalogue_scope
  FOREIGN KEY(active_release_id,workspace_id,course_key) REFERENCES course_releases(id,workspace_id,course_key);
-- Existing deployments had no explicit selection. Preserve their newest
-- published release as the initial catalogue choice; no enrollment is rewritten.
UPDATE admin_course_catalog c SET active_release_id=(
  SELECT r.id FROM course_releases r WHERE r.workspace_id=c.workspace_id
    AND r.course_key=c.course_key AND r.status='published'
  ORDER BY r.created_at DESC,r.id DESC LIMIT 1
);
