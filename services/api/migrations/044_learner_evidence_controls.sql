-- A learner's own controls over a piece of their evidence (learner-model.ts).
-- 'dispute' asks staff to look at the result again. It is open until the learner
-- withdraws it, staff review the evidence (admin_evidence_reviews) or the
-- evidence is invalidated; while open, the objective shows as disputed.
-- 'exclude' keeps the evidence out of what the companion and supervisor are
-- given about the learner. Neither control grants, removes or changes credit:
-- gate decisions keep reading evidence as before.
-- One active row per evidence and kind; ending a row keeps it as history.
CREATE TABLE learner_evidence_controls (
  id uuid PRIMARY KEY,
  enrollment_id uuid NOT NULL REFERENCES enrollments(id),
  workspace_id uuid NOT NULL,
  evidence_id uuid NOT NULL REFERENCES evidence(id),
  kind text NOT NULL CHECK (kind IN ('dispute','exclude')),
  -- The learner's own words, for the dispute only (see learner-privacy.ts).
  reason text NOT NULL DEFAULT '' CHECK (char_length(reason) <= 500),
  event_id uuid NOT NULL REFERENCES learning_events(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ended_at timestamptz,
  ended_event_id uuid REFERENCES learning_events(id),
  FOREIGN KEY (enrollment_id, workspace_id) REFERENCES enrollments(id, workspace_id),
  CHECK (kind = 'dispute' OR reason = ''),
  CHECK ((ended_at IS NULL) = (ended_event_id IS NULL))
);
CREATE UNIQUE INDEX learner_evidence_controls_active ON learner_evidence_controls (evidence_id, kind) WHERE ended_at IS NULL;
CREATE INDEX learner_evidence_controls_enrollment ON learner_evidence_controls (enrollment_id, kind) WHERE ended_at IS NULL;
