-- A transfer check resolved from a reviewed written answer is amended, never rewritten, when an
-- appeal later changes that review's decision: the original resolution stays as stored and the
-- amended outcome is kept beside it with the appeal that caused it.
ALTER TABLE adaptation_transfer_checks
  ADD COLUMN amended_status text CHECK (amended_status IN ('passed','failed')),
  ADD COLUMN amended_at timestamptz,
  ADD COLUMN amended_by_appeal_id uuid REFERENCES rubric_appeals(id),
  ADD CONSTRAINT adaptation_transfer_checks_amendment CHECK (
    (amended_status IS NULL) = (amended_at IS NULL) AND (amended_status IS NULL) = (amended_by_appeal_id IS NULL)
    AND (amended_status IS NULL OR (status IN ('passed','failed') AND amended_status<>status)));

-- A resolved check keeps its original resolution, and an amendment is written once.
CREATE FUNCTION adaptation_transfer_checks_keep_resolution() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status<>'pending' AND (NEW.status,NEW.attempt_id,NEW.resolved_at) IS DISTINCT FROM (OLD.status,OLD.attempt_id,OLD.resolved_at) THEN
    RAISE EXCEPTION 'TRANSFER_CHECK_RESOLUTION_IMMUTABLE';
  END IF;
  IF OLD.amended_status IS NOT NULL AND (NEW.amended_status,NEW.amended_at,NEW.amended_by_appeal_id) IS DISTINCT FROM (OLD.amended_status,OLD.amended_at,OLD.amended_by_appeal_id) THEN
    RAISE EXCEPTION 'TRANSFER_CHECK_AMENDMENT_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER adaptation_transfer_checks_keep_resolution BEFORE UPDATE ON adaptation_transfer_checks
  FOR EACH ROW EXECUTE FUNCTION adaptation_transfer_checks_keep_resolution();
