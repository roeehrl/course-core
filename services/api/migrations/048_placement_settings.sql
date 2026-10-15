-- Placement administration. Placement is off unless BOTH the course manifest offers it and
-- staff enable it for the course here (no row = off). Settings can only tighten what the
-- author declared: max_items is capped by the manifest's maxItems, and
-- min_families_per_episode is an extra requirement on top of each gate's own rule.
CREATE TABLE placement_settings (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  course_key text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  retest_cooldown_hours integer NOT NULL DEFAULT 168 CHECK (retest_cooldown_hours BETWEEN 0 AND 8760),
  max_runs integer NOT NULL DEFAULT 1 CHECK (max_runs BETWEEN 1 AND 10),
  max_items integer CHECK (max_items IS NULL OR max_items BETWEEN 1 AND 100),
  min_families_per_episode integer CHECK (min_families_per_episode IS NULL OR min_families_per_episode BETWEEN 1 AND 10),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_by uuid REFERENCES app_users(id),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, course_key)
);

-- Retests: an enrollment may have several numbered runs, at most one in progress.
ALTER TABLE placement_runs DROP CONSTRAINT placement_runs_enrollment_id_key;
ALTER TABLE placement_runs ADD COLUMN run_number integer NOT NULL DEFAULT 1 CHECK (run_number >= 1);
ALTER TABLE placement_runs ADD CONSTRAINT placement_runs_enrollment_run UNIQUE (enrollment_id, run_number);
CREATE UNIQUE INDEX placement_runs_one_in_progress ON placement_runs (enrollment_id) WHERE state = 'in_progress';

-- Staff override of one placement exemption: the episode returns to the learner's path.
-- Append-only; the evidence that justified the exemption is kept. Erasure of the enrollment
-- (course_core.erasure_enrollment, see 018) may only blank the staff reason.
CREATE TABLE placement_exemption_overrides (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  enrollment_id uuid NOT NULL REFERENCES enrollments(id),
  episode_id text NOT NULL CHECK (length(episode_id) BETWEEN 1 AND 200),
  run_id uuid REFERENCES placement_runs(id),
  evidence_refs jsonb NOT NULL,
  reason text NOT NULL CHECK (reason = '[erased]' OR length(reason) BETWEEN 10 AND 2000),
  revoked_by uuid NOT NULL REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX placement_exemption_overrides_enrollment ON placement_exemption_overrides (enrollment_id, created_at);
CREATE FUNCTION placement_exemption_overrides_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND coalesce(current_setting('course_core.erasure_enrollment', true), '') = OLD.enrollment_id::text
    AND NEW.reason = '[erased]' AND (to_jsonb(NEW) - 'reason') = (to_jsonb(OLD) - 'reason') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'PLACEMENT_OVERRIDE_IMMUTABLE' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER placement_exemption_overrides_append_only BEFORE UPDATE OR DELETE ON placement_exemption_overrides
  FOR EACH ROW EXECUTE FUNCTION placement_exemption_overrides_append_only();
CREATE TRIGGER placement_exemption_overrides_no_truncate BEFORE TRUNCATE ON placement_exemption_overrides
  FOR EACH STATEMENT EXECUTE FUNCTION placement_exemption_overrides_append_only();
