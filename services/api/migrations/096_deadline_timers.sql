-- Durable per-deadline timers replace the periodic scan over every active enrollment.
--
-- A timer is one boundary of one enrollment: a binding deadline entering its warning window
-- ('approaching'), a chapter or episode deadline passing ('reached'), the enrollment's own
-- end ('cap'), or a work quota that ran out and must be checked for closure ('quota_cap').
-- Each timer names the policy and ledger revision it was planned from. When it fires, the
-- worker locks the enrollment's policy row and compares: a timer planned from an older
-- revision is re-planned instead of acted on (the commit-time fence), so a deadline moved by
-- a grant, accommodation or migration can never fire at its old time. The action itself is
-- still checked by the policy at commit, so a late timer cannot close or publish early.
CREATE TABLE policy_deadline_timers(
  enrollment_id uuid NOT NULL REFERENCES enrollments(id),
  scope_id text NOT NULL CHECK(length(scope_id) BETWEEN 1 AND 256),
  phase text NOT NULL CHECK(phase IN('approaching','reached','cap','quota_cap')),
  deadline_at timestamptz NOT NULL,
  level text NOT NULL CHECK(length(level) BETWEEN 1 AND 40),
  policy_revision integer NOT NULL CHECK(policy_revision>0),
  ledger_revision integer NOT NULL CHECK(ledger_revision>=0),
  state text NOT NULL DEFAULT 'pending' CHECK(state IN('pending','fired','superseded')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
  -- After a failed attempt the timer waits this long before it is tried again.
  retry_at timestamptz,
  planned_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  fired_at timestamptz,
  PRIMARY KEY(enrollment_id,scope_id,phase,deadline_at),
  CHECK((state='fired')=(fired_at IS NOT NULL))
);
CREATE INDEX policy_deadline_timers_due ON policy_deadline_timers(deadline_at) WHERE state='pending';

-- Enrollments whose timers must be planned again. A trigger writes one row in the same
-- transaction as every change of a policy document or enrollment status, from any code path,
-- so a committed change can never be missed; the worker drains this queue before firing.
CREATE TABLE policy_timer_plans(
  enrollment_id uuid PRIMARY KEY REFERENCES enrollments(id),
  queued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  retry_at timestamptz
);
CREATE FUNCTION queue_timer_plan() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='enrollments' THEN
    INSERT INTO policy_timer_plans(enrollment_id) VALUES(NEW.id) ON CONFLICT(enrollment_id) DO UPDATE SET queued_at=clock_timestamp(),retry_at=NULL;
  ELSE
    INSERT INTO policy_timer_plans(enrollment_id) VALUES(NEW.enrollment_id) ON CONFLICT(enrollment_id) DO UPDATE SET queued_at=clock_timestamp(),retry_at=NULL;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER policy_states_timer_plan AFTER INSERT OR UPDATE ON policy_states FOR EACH ROW EXECUTE FUNCTION queue_timer_plan();
CREATE TRIGGER enrollments_timer_plan AFTER UPDATE OF status ON enrollments FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION queue_timer_plan();
INSERT INTO policy_timer_plans(enrollment_id) SELECT e.id FROM enrollments e JOIN policy_states p ON p.enrollment_id=e.id WHERE e.status='active';
