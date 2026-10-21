-- Trigger T10 "session ended" (requirement B03) and which agent strategy each provider dispatch
-- ran (requirement B08).

-- One row per enrollment: the learner's current (or last) study session. A learner event opens or
-- extends it; it ends when the learner leaves (an explicit end from the app) or after a quiet
-- period (the wake-up scan). Ending is a single transition, so a session ends at most once.
-- Timestamps only: no content of what the learner did.
CREATE TABLE learner_sessions(
  enrollment_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  started_at timestamptz NOT NULL,
  last_activity_at timestamptz NOT NULL,
  ended_at timestamptz,
  end_reason text CHECK(end_reason IN('learner_left','idle')),
  sessions integer NOT NULL DEFAULT 1 CHECK(sessions > 0),
  CHECK((ended_at IS NULL) = (end_reason IS NULL)),
  FOREIGN KEY(enrollment_id,workspace_id) REFERENCES enrollments(id,workspace_id)
);
CREATE INDEX learner_sessions_open ON learner_sessions(last_activity_at) WHERE ended_at IS NULL;
-- The wake-up scan that ends quiet sessions records its failures like its other steps.
ALTER TABLE wakeup_failures DROP CONSTRAINT wakeup_failures_stage_check;
ALTER TABLE wakeup_failures ADD CONSTRAINT wakeup_failures_stage_check CHECK(stage IN('retention','deadline','closure','session'));

-- A session's end is a trigger-table signal like a review coming due.
ALTER TABLE teaching_signals DROP CONSTRAINT teaching_signals_signal_kind_check;
ALTER TABLE teaching_signals ADD CONSTRAINT teaching_signals_signal_kind_check
  CHECK (signal_kind IN ('answer.incorrect','answer.correct','answer.abstained','companion.question','grade.challenged','review.due','session.ended'));

CREATE FUNCTION learner_session_activity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO learner_sessions(enrollment_id,workspace_id,started_at,last_activity_at)
  VALUES(NEW.enrollment_id,NEW.workspace_id,NEW.created_at,NEW.created_at)
  ON CONFLICT(enrollment_id) DO UPDATE SET
    started_at=CASE WHEN learner_sessions.ended_at IS NULL THEN learner_sessions.started_at ELSE EXCLUDED.started_at END,
    sessions=learner_sessions.sessions+CASE WHEN learner_sessions.ended_at IS NULL THEN 0 ELSE 1 END,
    last_activity_at=GREATEST(learner_sessions.last_activity_at,EXCLUDED.last_activity_at),
    ended_at=NULL,end_reason=NULL;
  RETURN NULL;
END $$;
CREATE TRIGGER learning_events_learner_session AFTER INSERT ON learning_events FOR EACH ROW
  WHEN (NEW.actor_kind='learner' AND NEW.enrollment_id IS NOT NULL AND NEW.event_type<>'session.ended')
  EXECUTE FUNCTION learner_session_activity();

-- The strategy that answered each dispatch: Core's own or a course-declared one that narrows it,
-- its version, the role revision it ran as, and whether that revision had a passing quality check
-- or an owner's approval at the time (the eval gate, agent-evals/gate.ts).
ALTER TABLE provider_dispatches
  ADD COLUMN strategy_id text CHECK(strategy_id IS NULL OR length(strategy_id) BETWEEN 1 AND 200),
  ADD COLUMN strategy_version text CHECK(strategy_version IS NULL OR length(strategy_version) BETWEEN 1 AND 64),
  ADD COLUMN strategy_source text CHECK(strategy_source IS NULL OR strategy_source IN('core','course')),
  ADD COLUMN role_revision_digest text CHECK(role_revision_digest IS NULL OR role_revision_digest ~ '^[a-f0-9]{64}$'),
  ADD COLUMN eval_standing text CHECK(eval_standing IS NULL OR eval_standing IN('passed','approved','not_checked','unknown'));

-- Media spend counts toward a learner's per-day and per-lesson AI limits like supervisor spend
-- (requirement B09): its ledger rows name the lesson they were for (the per-learner index exists, 039).
ALTER TABLE provider_spend_ledger
  ADD COLUMN episode_id text CHECK(episode_id IS NULL OR length(episode_id) BETWEEN 1 AND 200);
