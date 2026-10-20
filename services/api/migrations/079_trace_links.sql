-- Trace links: the OpenTelemetry trace that wrote each learning event, supervisor job and provider
-- dispatch, so an operator can open the trace from the record (and the record from the trace).
-- Filled by the application only while tracing is on and the writing span is valid and sampled;
-- otherwise null. The database never generates one. A trace ID is a random W3C identifier with no
-- learner data in it; it is kept through erasure like the row's other random IDs.
ALTER TABLE learning_events ADD COLUMN trace_id text
  CHECK (trace_id IS NULL OR (trace_id ~ '^[0-9a-f]{32}$' AND trace_id <> repeat('0', 32)));
ALTER TABLE supervisor_jobs ADD COLUMN trace_id text
  CHECK (trace_id IS NULL OR (trace_id ~ '^[0-9a-f]{32}$' AND trace_id <> repeat('0', 32)));
ALTER TABLE provider_dispatches ADD COLUMN trace_id text
  CHECK (trace_id IS NULL OR (trace_id ~ '^[0-9a-f]{32}$' AND trace_id <> repeat('0', 32)));
-- Lookup from a trace to its records. Partial, so a deployment without tracing pays nothing.
CREATE INDEX learning_events_trace ON learning_events (trace_id) WHERE trace_id IS NOT NULL;
CREATE INDEX supervisor_jobs_trace ON supervisor_jobs (trace_id) WHERE trace_id IS NOT NULL;
CREATE INDEX provider_dispatches_trace ON provider_dispatches (trace_id) WHERE trace_id IS NOT NULL;
