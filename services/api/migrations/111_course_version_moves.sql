-- Moving enrolled learners to a newer version of their course (requirement K13,
-- course-version-moves.ts). Staff preview a move of one learner or of everyone on a version; the
-- preview is stored with its digest and expires. Confirming it records one entry per learner:
-- moved now, waiting for a safe boundary (no question open, no activity being worked on), refused
-- with a code, later undone, or cancelled. Evidence, attempts and progress rows are never
-- rewritten: evidence stays bound to the version it was earned on. Only identifiers, codes,
-- counts and lesson ids are stored; never learner-written text.
CREATE TABLE course_version_moves (
  id uuid PRIMARY KEY,
  catalog_id uuid NOT NULL REFERENCES admin_course_catalog(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  actor_id uuid NOT NULL REFERENCES app_users(id),
  from_release_id uuid NOT NULL REFERENCES course_releases(id),
  to_release_id uuid NOT NULL REFERENCES course_releases(id),
  -- One learner, or every active or paused learner on the from version.
  scope text NOT NULL CHECK (scope IN ('learner', 'cohort')),
  enrollment_id uuid REFERENCES enrollments(id),
  preview jsonb NOT NULL CHECK (jsonb_typeof(preview) = 'object' AND octet_length(preview::text) <= 4194304),
  preview_digest text NOT NULL CHECK (preview_digest ~ '^[a-f0-9]{64}$'),
  state text NOT NULL DEFAULT 'previewed' CHECK (state IN ('previewed', 'confirmed')),
  reason text CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 1000),
  expires_at timestamptz NOT NULL,
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((state = 'confirmed') = (confirmed_at IS NOT NULL AND reason IS NOT NULL)),
  CHECK ((scope = 'learner') = (enrollment_id IS NOT NULL)),
  CHECK (from_release_id <> to_release_id)
);
CREATE INDEX course_version_moves_catalog ON course_version_moves(catalog_id, created_at DESC);

CREATE TABLE course_version_move_entries (
  move_id uuid NOT NULL REFERENCES course_version_moves(id),
  enrollment_id uuid NOT NULL REFERENCES enrollments(id),
  state text NOT NULL CHECK (state IN ('waiting', 'moved', 'refused', 'undone', 'cancelled')),
  -- Why the move was refused or cancelled, why it is waiting, or why an undo was refused last:
  -- a stable code, never a message.
  code text CHECK (code IS NULL OR code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  -- What the learner's move was confirmed to cost them (lessons to redo, scopes added). A waiting
  -- move proceeds only while this is unchanged.
  cost_digest text NOT NULL CHECK (cost_digest ~ '^[a-f0-9]{64}$'),
  -- The enrollment as it was before the move (release, place, course policy) and its revision
  -- right after, so an undo can tell whether the learner has done anything since.
  before jsonb,
  moved_revision integer,
  moved_at timestamptz,
  undone_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (move_id, enrollment_id),
  CHECK ((state IN ('moved', 'undone')) = (moved_at IS NOT NULL AND before IS NOT NULL AND moved_revision IS NOT NULL)),
  CHECK ((state = 'undone') = (undone_at IS NOT NULL))
);
-- A learner waits for at most one move at a time.
CREATE UNIQUE INDEX course_version_move_entries_one_waiting ON course_version_move_entries(enrollment_id) WHERE state = 'waiting';
CREATE INDEX course_version_move_entries_waiting ON course_version_move_entries(updated_at) WHERE state = 'waiting';
