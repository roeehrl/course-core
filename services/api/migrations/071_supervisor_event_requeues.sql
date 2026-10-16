-- An operator may re-queue a supervisor event that the dispatcher quarantined after a transient
-- outage (delivery kept failing, or its attempts ran out), once, with fresh attempts. Refused
-- events (a permanent conflict or client error) and events of an erased enrollment are never
-- re-queued. This row is the audit record of who released it, why, and what it replaced; the
-- primary key makes the release once-only. The reason is staff free text, redacted on erasure.
CREATE TABLE supervisor_event_requeues (
  event_id uuid PRIMARY KEY,
  enrollment_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  actor_id uuid NOT NULL REFERENCES app_users(id),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 500),
  previous_code text NOT NULL CHECK (previous_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  previous_attempts integer NOT NULL CHECK (previous_attempts >= 0),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (event_id,enrollment_id,workspace_id) REFERENCES learning_events(id,enrollment_id,workspace_id)
);
CREATE INDEX supervisor_event_requeues_enrollment ON supervisor_event_requeues(enrollment_id,created_at);
