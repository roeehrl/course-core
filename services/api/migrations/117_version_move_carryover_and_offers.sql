-- Course-version moves, owner decisions of 2026-10-24 (course-version-moves.ts).
--
-- 1. Unchanged checkpoints carry over. When a checkpoint's rules are the same in both versions and
--    every item it lists has the same item, answer key or rubric, and evaluator digests (M03 grading
--    provenance, migration 097), the learner's passing attempts on it count on the new version too.
--    Attempts and evidence are never rewritten: one row here per carried attempt says which version
--    it now also counts on. An undone move marks its rows undone; they then count for nothing.
CREATE TABLE carried_checkpoint_attempts (
  move_id uuid NOT NULL REFERENCES course_version_moves(id),
  enrollment_id uuid NOT NULL REFERENCES enrollments(id),
  attempt_id uuid NOT NULL REFERENCES attempts(id),
  gate_id text NOT NULL CHECK (char_length(gate_id) BETWEEN 1 AND 200),
  from_course_digest text NOT NULL CHECK (from_course_digest ~ '^[a-f0-9]{64}$'),
  course_digest text NOT NULL CHECK (course_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  undone_at timestamptz,
  PRIMARY KEY (move_id, attempt_id),
  CHECK (from_course_digest <> course_digest)
);
CREATE INDEX carried_checkpoint_attempts_live ON carried_checkpoint_attempts(attempt_id, created_at DESC) WHERE undone_at IS NULL;
CREATE INDEX carried_checkpoint_attempts_enrollment ON carried_checkpoint_attempts(enrollment_id);

-- 2. Learners with personal changes. A move still refuses them by default; the learner is offered the
--    move instead ("drop my personal changes and move"). They accept or decline in the app; an owner or
--    admin may force it with a reason. One offer per learner per confirmed move.
CREATE TABLE course_version_move_offers (
  move_id uuid NOT NULL REFERENCES course_version_moves(id),
  enrollment_id uuid NOT NULL REFERENCES enrollments(id),
  state text NOT NULL DEFAULT 'offered' CHECK (state IN ('offered', 'accepted', 'declined', 'forced', 'withdrawn')),
  decided_by uuid REFERENCES app_users(id),
  -- Staff-written; required for a forced move. Redacted on erasure.
  force_reason text CHECK (force_reason IS NULL OR length(force_reason) BETWEEN 1 AND 1000),
  -- Why an offer was withdrawn: a stable code, never a message.
  code text CHECK (code IS NULL OR code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  decided_at timestamptz,
  PRIMARY KEY (move_id, enrollment_id),
  CHECK ((state = 'offered') = (decided_at IS NULL)),
  CHECK ((state = 'forced') = (force_reason IS NOT NULL))
);
CREATE UNIQUE INDEX course_version_move_offers_one_open ON course_version_move_offers(enrollment_id) WHERE state = 'offered';

-- A waiting move that drops the learner's personal changes when it runs (accepted or forced).
ALTER TABLE course_version_move_entries ADD COLUMN drops_personal_changes boolean NOT NULL DEFAULT false;

-- 3. Personal changes a move set aside are archived, never lost: the adaptation state as it was (so an
--    undo can restore it), and the list the learner was shown. Their proposals, applications and
--    artifacts stay where they are (immutable history) and remain in the learner's record and export.
CREATE TABLE personal_change_archives (
  id uuid PRIMARY KEY,
  move_id uuid NOT NULL REFERENCES course_version_moves(id),
  enrollment_id uuid NOT NULL REFERENCES enrollments(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  from_release_id uuid NOT NULL REFERENCES course_releases(id),
  how text NOT NULL CHECK (how IN ('accepted', 'forced')),
  -- Lesson ids, titles and change kinds; redacted to '[]' on erasure.
  changes jsonb NOT NULL CHECK (jsonb_typeof(changes) = 'array' AND octet_length(changes::text) <= 262144),
  -- The adaptation_states row as it was; redacted to '{}' on erasure.
  state jsonb CHECK (state IS NULL OR jsonb_typeof(state) = 'object'),
  pending_declined integer NOT NULL DEFAULT 0 CHECK (pending_declined >= 0),
  archived_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  restored_at timestamptz,
  UNIQUE (move_id, enrollment_id)
);
CREATE INDEX personal_change_archives_enrollment ON personal_change_archives(enrollment_id, archived_at DESC);
