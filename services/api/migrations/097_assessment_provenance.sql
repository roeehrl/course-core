-- Assessment provenance, graded spaced review, translatable gate reasons and assessment fixtures.

-- Grading provenance (M03). Every graded attempt binds the exact item, its answer key or rubric,
-- and the evaluator that graded it, each as a SHA-256 of its canonical JSON (see
-- grading-provenance.ts). code_image names the sandbox image a code answer ran in. Rows written
-- before this migration keep NULL: their provenance is the course digest and evaluator_ref only.
ALTER TABLE attempts
  ADD COLUMN item_digest text CHECK (item_digest ~ '^[a-f0-9]{64}$'),
  ADD COLUMN answer_key_digest text CHECK (answer_key_digest ~ '^[a-f0-9]{64}$'),
  ADD COLUMN evaluator_digest text CHECK (evaluator_digest ~ '^[a-f0-9]{64}$'),
  ADD COLUMN code_image text CHECK (char_length(code_image) BETWEEN 1 AND 300);
-- A regrade binds what it graded with, which may differ from the original attempt's.
ALTER TABLE attempt_regrades
  ADD COLUMN item_digest text CHECK (item_digest ~ '^[a-f0-9]{64}$'),
  ADD COLUMN answer_key_digest text CHECK (answer_key_digest ~ '^[a-f0-9]{64}$'),
  ADD COLUMN evaluator_digest text CHECK (evaluator_digest ~ '^[a-f0-9]{64}$'),
  ADD COLUMN code_image text CHECK (char_length(code_image) BETWEEN 1 AND 300);

-- Graded spaced review (F06). A miss steps the schedule back instead of always restarting it:
-- lapses counts misses since the last retained check, and last_outcome is what moved it last.
-- base_due_at is when the schedule alone puts the next check; due_at is that moment moved to the
-- learner's next available day (retention_availability), so a changed availability can recompute it.
ALTER TABLE retention_schedules
  ADD COLUMN lapses integer NOT NULL DEFAULT 0 CHECK (lapses >= 0),
  ADD COLUMN last_outcome text CHECK (last_outcome IN ('retained', 'missed', 'unsure', 'assisted')),
  ADD COLUMN base_due_at timestamptz;
-- The days a learner can study, for one enrollment. Review checks fall due only on those days, in
-- the learner's time zone. weekday_mask: bit 0 is Sunday ... bit 6 is Saturday.
CREATE TABLE retention_availability (
  enrollment_id uuid PRIMARY KEY REFERENCES enrollments(id),
  workspace_id uuid NOT NULL,
  weekday_mask integer NOT NULL CHECK (weekday_mask BETWEEN 1 AND 127),
  time_zone text NOT NULL CHECK (char_length(time_zone) BETWEEN 1 AND 64),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (enrollment_id, workspace_id) REFERENCES enrollments(id, workspace_id)
);

-- A gate decision's learner-visible text as message codes with parameters (reason, criteria, next
-- actions), so the learner app shows it in the learner's language. The SDK record keeps the
-- English text; decisions made before this migration have NULL and show that text.
ALTER TABLE gate_decisions ADD COLUMN messages jsonb CHECK (messages IS NULL OR jsonb_typeof(messages) = 'object');

-- Wrong-answer (and right-answer) fixtures for one course's items (Q09). Staff record answers an
-- item must reject or accept; a fixture run grades every fixture against a release's answer keys.
-- Fixtures belong to the course, not a release, so they keep checking every new draft.
CREATE TABLE assessment_fixtures (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  course_key text NOT NULL CHECK (char_length(course_key) BETWEEN 1 AND 200),
  assessment_id text NOT NULL CHECK (char_length(assessment_id) BETWEEN 1 AND 200),
  label text NOT NULL DEFAULT '' CHECK (char_length(label) <= 200),
  answer jsonb NOT NULL CHECK (octet_length(answer::text) <= 16384),
  expected text NOT NULL CHECK (expected IN ('correct', 'incorrect')),
  created_by uuid NOT NULL REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  removed_by uuid REFERENCES app_users(id),
  removed_at timestamptz,
  CHECK ((removed_at IS NULL) = (removed_by IS NULL))
);
CREATE INDEX assessment_fixtures_item ON assessment_fixtures (workspace_id, course_key, assessment_id) WHERE removed_at IS NULL;
-- One recorded run of a course's fixtures against one release, for the validation report.
CREATE TABLE assessment_fixture_runs (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  course_key text NOT NULL CHECK (char_length(course_key) BETWEEN 1 AND 200),
  release_id uuid NOT NULL REFERENCES course_releases(id),
  release_digest text NOT NULL CHECK (release_digest ~ '^[a-f0-9]{64}$'),
  actor_id uuid NOT NULL REFERENCES app_users(id),
  passed integer NOT NULL CHECK (passed >= 0),
  failed integer NOT NULL CHECK (failed >= 0),
  not_runnable integer NOT NULL CHECK (not_runnable >= 0),
  results jsonb NOT NULL CHECK (jsonb_typeof(results) = 'array'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX assessment_fixture_runs_course ON assessment_fixture_runs (workspace_id, course_key, created_at DESC);

-- The language of a reviewed clip's caption track (a BCP 47 tag the reviewer chose), so the
-- learner's player labels the track correctly instead of assuming English. NULL on older reviews.
ALTER TABLE media_reviews ADD COLUMN captions_language text CHECK (captions_language ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$');
