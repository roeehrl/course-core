-- The wake-up scan walks every active enrollment in bounded batches. A shared
-- keyset cursor lets each tick (from any process) continue where the last one
-- stopped, wrapping around, so no enrollment is starved behind the first batch.
CREATE TABLE wakeup_scan_cursors(
  scan text PRIMARY KEY CHECK(length(scan) BETWEEN 1 AND 64),
  last_enrollment_id uuid,
  passes bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- A failed wake-up step is recorded, never swallowed. Only the stable error code
-- is kept (no message, payload or learner content); one failing enrollment never
-- stops the scan of the others.
CREATE TABLE wakeup_failures(
  enrollment_id uuid NOT NULL REFERENCES enrollments(id),
  stage text NOT NULL CHECK(stage IN('retention','deadline','closure')),
  code text NOT NULL CHECK(code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  failures integer NOT NULL DEFAULT 1 CHECK(failures>0),
  first_failed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_failed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(enrollment_id,stage)
);

-- A chapter or episode deadline that passed while its work was unfinished is
-- signalled once to the supervisor (the course deadline closes instead).
ALTER TABLE wakeup_signals DROP CONSTRAINT wakeup_signals_kind_check;
ALTER TABLE wakeup_signals ADD CONSTRAINT wakeup_signals_kind_check CHECK(kind IN('retention_due','deadline_approaching','deadline_reached'));
