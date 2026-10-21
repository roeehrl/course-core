-- Where a learner is working right now (requirement E03). The learner app reports when the learner
-- starts using an interactive part of a lesson (an activity, a simulation or a generated component)
-- and when they leave it; saving an activity's state also counts. A personal change to that lesson
-- waits while a part is open (generated-content.ts safeBoundary). A report lapses at expires_at, so
-- a closed laptop or crashed tab never holds a change back for long. One row per lesson part;
-- nothing here is evidence, and erasure deletes the rows.
CREATE TABLE activity_presence (
  enrollment_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  episode_id text NOT NULL CHECK (char_length(episode_id) BETWEEN 1 AND 200),
  block_id text NOT NULL CHECK (char_length(block_id) BETWEEN 1 AND 200),
  kind text NOT NULL CHECK (kind IN ('activity','simulation','component')),
  opened_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  closed_at timestamptz,
  PRIMARY KEY (enrollment_id, episode_id, block_id),
  CHECK (expires_at > seen_at),
  FOREIGN KEY (enrollment_id, workspace_id) REFERENCES enrollments(id, workspace_id)
);
CREATE INDEX activity_presence_open ON activity_presence(enrollment_id, episode_id) WHERE closed_at IS NULL;

-- Provenance of a learner-model suggestion (requirement C06): how sure Core is of it, from how much
-- of the learner's own activity it rests on, and until when it is offered. Older rows keep NULL
-- (not stated, never expiring); the learner can no longer accept or correct an expired suggestion.
ALTER TABLE learner_model_proposals
  ADD COLUMN uncertainty text CHECK (uncertainty IS NULL OR uncertainty IN ('low','medium','high')),
  ADD COLUMN expires_at timestamptz CHECK (expires_at IS NULL OR expires_at > created_at);
