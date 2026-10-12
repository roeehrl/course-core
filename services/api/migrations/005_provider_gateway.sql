CREATE TABLE provider_dispatches (
  operation_id text PRIMARY KEY,
  job_id uuid NOT NULL,
  enrollment_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  request_digest text NOT NULL,
  state text NOT NULL CHECK (state IN ('in_flight','completed','not_started','uncertain')),
  outcome jsonb,
  provider_usage jsonb,
  candidate jsonb,
  failure_code text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  FOREIGN KEY (job_id,enrollment_id,workspace_id) REFERENCES supervisor_jobs(id,enrollment_id,workspace_id)
);
