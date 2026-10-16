-- A supervisor event whose preparation hits a permanent state conflict (a 409: consent changed
-- after dispatch, the request was withdrawn, cancelled or already linked, its context is invalid)
-- is consumed for good with disposition 'refused' and the conflict's error code, instead of being
-- retried until the dispatcher quarantines it under a generic code. Transient failures (storage,
-- configuration, a lost lease) are unchanged: retried with bounded backoff, then quarantined.
ALTER TABLE supervisor_preparations DROP CONSTRAINT supervisor_preparations_disposition_check,
  ADD CONSTRAINT supervisor_preparations_disposition_check
  CHECK (disposition IN ('prepared','inactive','policy_denied','agent_event','supervision_stopped','coalesced','oversized','refused')),
  ADD COLUMN reason_code text CHECK (reason_code ~ '^[A-Z][A-Z0-9_]{0,79}$'),
  ADD CONSTRAINT supervisor_preparations_refused CHECK ((disposition='refused') = (reason_code IS NOT NULL));
-- The staff supervision view lists an enrollment's refused and quarantined deliveries.
CREATE INDEX supervisor_preparations_refused ON supervisor_preparations(enrollment_id,created_at) WHERE disposition='refused';
CREATE INDEX outbox_supervisor_quarantined ON outbox((payload->>'enrollmentId'),quarantined_at)
  WHERE kind='supervisor.event' AND quarantined_at IS NOT NULL AND last_error_code IS NOT NULL;

-- A research request whose dispatched event was refused never stays 'dispatched': it ends
-- 'refused' with the conflict code, or 'cancelled' for the deadline when that passed first.
ALTER TABLE research_requests DROP CONSTRAINT research_requests_state_check,
  ADD CONSTRAINT research_requests_state_check CHECK (state IN ('staged','dispatched','collected','cancelled','refused')),
  ADD COLUMN refusal_code text CHECK (refusal_code ~ '^[A-Z][A-Z0-9_]{0,79}$'),
  ADD CONSTRAINT research_requests_refused CHECK ((state='refused') = (refusal_code IS NOT NULL));
