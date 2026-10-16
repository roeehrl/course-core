-- Host cancellations of supervisor jobs outside staff control (data erasure, provider change).
-- supervisor_jobs.cancellation_requested stays authoritative; each row here only queues the
-- Temporal signals that stop a call, retry wait or hold already under way.
CREATE TABLE supervisor_job_cancellations(
  id uuid PRIMARY KEY,
  enrollment_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  reason text NOT NULL CHECK (reason IN ('data_erasure','provider_changed')),
  -- Run references of the jobs cancelled for this enrollment by one host transaction.
  jobs jsonb NOT NULL CHECK (jsonb_typeof(jobs)='array' AND jsonb_array_length(jobs) BETWEEN 1 AND 64),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 20),
  lease_token uuid,
  claimed_until timestamptz,
  delivered_at timestamptz,
  abandoned_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (enrollment_id,workspace_id) REFERENCES enrollments(id,workspace_id),
  CHECK (delivered_at IS NULL OR abandoned_at IS NULL)
);
CREATE INDEX supervisor_job_cancellations_pending ON supervisor_job_cancellations(created_at,id)
  WHERE delivered_at IS NULL AND abandoned_at IS NULL;
-- Cancelled jobs that no workflow will end (parked, waiting, verifying), halted by reconciliation.
CREATE INDEX supervisor_jobs_cancel_pending ON supervisor_jobs(workspace_id)
  WHERE cancellation_requested AND state NOT IN ('applied','cancelled','failed');
