-- Release safety: an item found defective after publication is recorded per release. Marking
-- it invalidates the evidence learners earned on it (with the reason), closes open challenges
-- for it, and stops it from being issued again on that release. Rows are append-only.
CREATE TABLE release_defective_items (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  release_id uuid NOT NULL REFERENCES course_releases(id),
  assessment_id text NOT NULL CHECK (length(assessment_id) BETWEEN 1 AND 200),
  reason text NOT NULL CHECK (length(reason) BETWEEN 10 AND 2000),
  marked_by uuid NOT NULL REFERENCES app_users(id),
  preview_digest text NOT NULL CHECK (preview_digest ~ '^[a-f0-9]{64}$'),
  replacement_item_ids jsonb NOT NULL,
  acknowledged_no_replacement boolean NOT NULL,
  invalidated_evidence integer NOT NULL CHECK (invalidated_evidence >= 0),
  affected_enrollments integer NOT NULL CHECK (affected_enrollments >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (release_id, assessment_id),
  CHECK (acknowledged_no_replacement OR jsonb_array_length(replacement_item_ids) > 0)
);
CREATE FUNCTION release_defective_items_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'DEFECTIVE_ITEM_IMMUTABLE' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER release_defective_items_append_only BEFORE UPDATE OR DELETE ON release_defective_items
  FOR EACH ROW EXECUTE FUNCTION release_defective_items_append_only();
CREATE TRIGGER release_defective_items_no_truncate BEFORE TRUNCATE ON release_defective_items
  FOR EACH STATEMENT EXECUTE FUNCTION release_defective_items_append_only();
