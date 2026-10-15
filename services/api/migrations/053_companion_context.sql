-- Companion context (context-capsule.ts).
--
-- navigation_revision counts the enrollment revisions that only move the
-- learner or add to their own conversation: reading a block (which also
-- switches episode) and asking the companion. The supervisor fence uses
-- revision - navigation_revision, so switching episode or asking a second
-- question no longer drops an answer that is still being prepared; every other
-- change (an answer, an independent check, profile, policy, learner-model and
-- evidence controls) still fences it.
ALTER TABLE enrollments ADD COLUMN navigation_revision integer NOT NULL DEFAULT 0;
ALTER TABLE enrollments ADD CONSTRAINT enrollments_navigation_revision CHECK (navigation_revision >= 0 AND navigation_revision < revision);

-- What one companion or supervisor job was given about a learner question: the
-- bounded, episode-scoped retrieval with references, the learner's selection,
-- the media position and the resolved constraint snapshot. The assistant
-- message answering that question links to it through job_id. Bounded to 32 KB.
CREATE TABLE companion_context_capsules (
  job_id uuid PRIMARY KEY REFERENCES supervisor_jobs(id),
  enrollment_id uuid NOT NULL REFERENCES enrollments(id),
  workspace_id uuid NOT NULL,
  learner_message_id uuid NOT NULL REFERENCES companion_messages(id),
  capsule jsonb NOT NULL CHECK (octet_length(capsule::text) <= 32768),
  digest text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (enrollment_id, workspace_id) REFERENCES enrollments(id, workspace_id)
);
CREATE INDEX companion_context_capsules_message ON companion_context_capsules (learner_message_id);

-- Earlier messages the learner asked the companion not to use again. Ending a
-- row (using it again) keeps it as history. Retrieval skips active rows.
CREATE TABLE companion_context_exclusions (
  id uuid PRIMARY KEY,
  enrollment_id uuid NOT NULL REFERENCES enrollments(id),
  workspace_id uuid NOT NULL,
  message_id uuid NOT NULL REFERENCES companion_messages(id),
  event_id uuid NOT NULL REFERENCES learning_events(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ended_at timestamptz,
  FOREIGN KEY (enrollment_id, workspace_id) REFERENCES enrollments(id, workspace_id)
);
CREATE UNIQUE INDEX companion_context_exclusions_active ON companion_context_exclusions (message_id) WHERE ended_at IS NULL;
CREATE INDEX companion_context_exclusions_enrollment ON companion_context_exclusions (enrollment_id) WHERE ended_at IS NULL;
CREATE INDEX companion_messages_episode ON companion_messages (enrollment_id, (context->>'episodeId'), created_at DESC);
