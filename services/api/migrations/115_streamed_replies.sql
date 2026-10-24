-- Streamed companion replies and wake-on-commit (requirement T01; docs/streamed-replies.md).
--
-- 1. Wake-ups delivered at COMMIT. A NOTIFY is sent only when its transaction commits, so a
--    listener never wakes for work a rollback discarded. Payloads carry no learner data: the
--    outbox channel carries nothing, and the learning-event channel only the enrollment ID, so
--    the API can push that enrollment's new events to its open event streams. Polling stays as
--    the backstop: a missed notification only costs the old poll interval.
CREATE FUNCTION course_notify_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('course_outbox', '');
  RETURN NULL;
END $$;
CREATE TRIGGER outbox_wake AFTER INSERT ON outbox FOR EACH STATEMENT EXECUTE FUNCTION course_notify_outbox();
-- Job cancellations (erasure, provider change, a learner stopping a reply) wake the dispatcher too.
CREATE TRIGGER supervisor_job_cancellations_wake AFTER INSERT ON supervisor_job_cancellations
  FOR EACH STATEMENT EXECUTE FUNCTION course_notify_outbox();

CREATE FUNCTION course_notify_learning_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Postgres folds identical notifications within one transaction into one.
  PERFORM pg_notify('course_events', NEW.enrollment_id::text);
  RETURN NULL;
END $$;
CREATE TRIGGER learning_events_wake AFTER INSERT ON learning_events
  FOR EACH ROW WHEN (NEW.enrollment_id IS NOT NULL) EXECUTE FUNCTION course_notify_learning_event();

-- 2. A learner may stop a reply that is being prepared; its cancellation is delivered like the others.
ALTER TABLE supervisor_job_cancellations DROP CONSTRAINT supervisor_job_cancellations_reason_check;
ALTER TABLE supervisor_job_cancellations ADD CONSTRAINT supervisor_job_cancellations_reason_check
  CHECK (reason IN ('data_erasure', 'provider_changed', 'staff_cancelled', 'learner_cancelled'));
