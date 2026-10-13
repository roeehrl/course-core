-- One supervised wake-up per boundary. The commit-time policy checks remain
-- authoritative; a late or missed wake-up never extends or bypasses anything.
CREATE TABLE wakeup_signals(
  enrollment_id uuid NOT NULL REFERENCES enrollments(id),kind text NOT NULL CHECK(kind IN('retention_due','deadline_approaching')),
  boundary_key text NOT NULL CHECK(length(boundary_key) BETWEEN 1 AND 200),event_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(enrollment_id,kind,boundary_key)
);
