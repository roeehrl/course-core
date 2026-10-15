-- Staff downloads of a learner's data are audited like staff views (030): each
-- row says who exported which enrollment, in which role, when, and the digest of
-- the exported file. Rows hold no learner content, are shown to the learner and
-- included in their own export, and are kept through erasure. The trigger below
-- refuses UPDATE, DELETE and TRUNCATE for every role, so learner exports are
-- append-only too.
ALTER TABLE data_exports ADD COLUMN requester_role text;
-- Rows written before this migration have no recorded role; NOT VALID keeps them
-- while every new row must carry one for staff and none for the learner.
ALTER TABLE data_exports ADD CONSTRAINT data_exports_requester_role CHECK (
  (actor_kind = 'learner' AND requester_role IS NULL)
  OR (actor_kind = 'staff' AND requester_role IS NOT NULL AND requester_role IN ('owner','admin'))) NOT VALID;
CREATE INDEX data_exports_enrollment ON data_exports (enrollment_id, created_at);
CREATE FUNCTION data_exports_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'DATA_EXPORT_AUDIT_IMMUTABLE' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER data_exports_append_only BEFORE UPDATE OR DELETE ON data_exports
  FOR EACH ROW EXECUTE FUNCTION data_exports_append_only();
CREATE TRIGGER data_exports_no_truncate BEFORE TRUNCATE ON data_exports
  FOR EACH STATEMENT EXECUTE FUNCTION data_exports_append_only();
