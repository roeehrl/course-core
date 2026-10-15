-- The learning-event envelope (events.ts, event-envelope.ts). Every column is
-- metadata about the event, never learner content, so erasure keeps the
-- identifiers and clears only the device fields (platform, app_version,
-- client_sequence, occurred_at) with the payload.
--   schema_version        envelope version (1).
--   platform, app_version the client that caused it, when a client did.
--   client_sequence       the client's own counter, to spot gaps and reordering.
--   occurred_at           when the client says it happened; received_at is the server's time.
--   course_digest         the course version the enrollment was on.
--   activity_instance_id  the check or activity instance (for answers, the challenge).
--   attempt_id            the attempt the event records, when there is one.
--   payload_ref           a reference to a payload stored elsewhere.
--   causation_id          the event that caused this one.
-- No column has a volatile default at ADD time, so existing rows are not rewritten; rows
-- written before this migration read received_at as created_at.
ALTER TABLE learning_events
  ADD COLUMN schema_version smallint NOT NULL DEFAULT 1 CHECK (schema_version >= 1),
  ADD COLUMN platform text CHECK (platform IN ('web','ios','android','server')),
  ADD COLUMN app_version text CHECK (char_length(app_version) BETWEEN 1 AND 64),
  ADD COLUMN client_sequence bigint CHECK (client_sequence >= 0),
  ADD COLUMN occurred_at timestamptz,
  ADD COLUMN received_at timestamptz,
  ADD COLUMN course_digest text CHECK (char_length(course_digest) <= 128),
  ADD COLUMN activity_instance_id text CHECK (char_length(activity_instance_id) <= 200),
  ADD COLUMN attempt_id uuid,
  ADD COLUMN payload_ref text CHECK (char_length(payload_ref) <= 512),
  ADD COLUMN causation_id uuid;
ALTER TABLE learning_events ALTER COLUMN received_at SET DEFAULT clock_timestamp();
