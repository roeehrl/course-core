-- Opt-in usability measures for a study (P15, study.ts usability section). A study can ask its
-- participants, as part of the same explicit consent, to let the learner app time how quickly
-- they find the required next step, count wrong turns on the way, and note whether a detour
-- (companion, profile, record) brings them back to the same place. Only codes, counts and
-- durations are stored: no lesson ids, no text, no clicks or screen positions.
ALTER TABLE studies ADD COLUMN usability_measures boolean NOT NULL DEFAULT false;

-- Like the rest of the definition, the choice is fixed once anyone could have consented.
CREATE FUNCTION study_usability_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state <> 'draft' AND NEW.usability_measures IS DISTINCT FROM OLD.usability_measures THEN
    RAISE EXCEPTION 'STUDY_DEFINITION_IMMUTABLE' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER studies_usability_frozen BEFORE UPDATE ON studies FOR EACH ROW EXECUTE FUNCTION study_usability_frozen();

-- One timed trial reported by the learner app. A batch is sent once and retried with the same
-- id, so a retry never doubles a trial.
CREATE TABLE study_usability_trials (
  id uuid PRIMARY KEY,
  study_id uuid NOT NULL,
  enrollment_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  position smallint NOT NULL CHECK (position BETWEEN 0 AND 49),
  -- next_action: from a place being shown to the learner taking its required next step.
  -- detour_return: from leaving the lesson for help or another page to being back in a lesson.
  kind text NOT NULL CHECK (kind IN ('next_action','detour_return')),
  place text NOT NULL CHECK (place IN ('course_page','lesson','check','gate','after_detour')),
  device_class text NOT NULL CHECK (device_class IN ('phone','tablet','desktop')),
  -- reached: the step was taken (or the learner came back); abandoned: they left the app first.
  outcome text NOT NULL CHECK (outcome IN ('reached','abandoned')),
  elapsed_ms integer NOT NULL CHECK (elapsed_ms BETWEEN 0 AND 3600000),
  wrong_turns smallint NOT NULL CHECK (wrong_turns BETWEEN 0 AND 100),
  -- detour_return only: whether the same lesson was showing again afterwards.
  context_kept boolean,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (enrollment_id, batch_id, position),
  FOREIGN KEY (study_id, enrollment_id) REFERENCES study_participants(study_id, enrollment_id),
  FOREIGN KEY (study_id, workspace_id) REFERENCES studies(id, workspace_id),
  FOREIGN KEY (enrollment_id, workspace_id) REFERENCES enrollments(id, workspace_id),
  CHECK ((kind = 'detour_return') = (context_kept IS NOT NULL))
);
CREATE INDEX study_usability_trials_participant ON study_usability_trials(study_id, enrollment_id);

-- Trials are never edited, and deleted only by the erasure of their own enrollment.
CREATE FUNCTION study_usability_trial_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND erasure_permits(to_jsonb(OLD)) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'STUDY_USABILITY_TRIAL_IMMUTABLE' USING ERRCODE='23514';
END $$;
CREATE TRIGGER study_usability_trials_guard BEFORE UPDATE OR DELETE ON study_usability_trials
  FOR EACH ROW EXECUTE FUNCTION study_usability_trial_guard();
