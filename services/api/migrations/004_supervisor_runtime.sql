-- Service orchestration state is separate from the learner policy/evidence ledger.
ALTER TABLE outbox
  ADD COLUMN lease_token uuid,
  ADD COLUMN lease_owner uuid,
  ADD COLUMN acknowledged_token uuid,
  ADD COLUMN quarantined_at timestamptz;
CREATE INDEX outbox_supervisor_available ON outbox (available_at, event_id)
  WHERE kind='supervisor.event' AND delivered_at IS NULL AND quarantined_at IS NULL;

ALTER TABLE learning_events ADD CONSTRAINT learning_events_scoped_id UNIQUE (id, enrollment_id, workspace_id);
ALTER TABLE supervisor_jobs ADD COLUMN workspace_id uuid;
UPDATE supervisor_jobs j SET workspace_id=e.workspace_id FROM enrollments e WHERE e.id=j.enrollment_id;
ALTER TABLE supervisor_jobs ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE supervisor_jobs
  ADD COLUMN runtime_snapshot jsonb,
  ADD COLUMN cancellation_requested boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT supervisor_jobs_scope UNIQUE (id, enrollment_id, workspace_id),
  ADD CONSTRAINT supervisor_jobs_enrollment_scope FOREIGN KEY (enrollment_id,workspace_id) REFERENCES enrollments(id,workspace_id),
  ADD CONSTRAINT supervisor_jobs_event_scope FOREIGN KEY (input_event_id,enrollment_id,workspace_id) REFERENCES learning_events(id,enrollment_id,workspace_id),
  ADD CONSTRAINT supervisor_jobs_runtime_identity CHECK (runtime_snapshot IS NULL OR (
    input_event_id IS NOT NULL AND
    runtime_snapshot #>> '{specification,key,jobId}' = id::text AND
    runtime_snapshot #>> '{specification,key,enrollmentId}' = enrollment_id::text AND
    runtime_snapshot #>> '{specification,key,workspaceId}' = workspace_id::text AND
    runtime_snapshot ->> 'state' = state));
CREATE UNIQUE INDEX supervisor_jobs_workflow_unique ON supervisor_jobs(workflow_id);
CREATE UNIQUE INDEX supervisor_jobs_event_role_unique ON supervisor_jobs(input_event_id,role) WHERE input_event_id IS NOT NULL;

CREATE TABLE supervisor_preparations (
  event_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  enrollment_id uuid NOT NULL,
  jobs jsonb NOT NULL CHECK (jsonb_typeof(jobs)='array' AND jsonb_array_length(jobs)<=16),
  disposition text NOT NULL CHECK (disposition IN ('prepared','inactive','policy_denied','agent_event')),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (event_id,enrollment_id,workspace_id) REFERENCES learning_events(id,enrollment_id,workspace_id)
);

CREATE TABLE supervisor_workspace_budgets (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id),
  limit_micro_usd bigint NOT NULL DEFAULT 0 CHECK (limit_micro_usd BETWEEN 0 AND 1000000000),
  limit_tokens bigint NOT NULL DEFAULT 0 CHECK (limit_tokens BETWEEN 0 AND 1000000000),
  used_micro_usd bigint NOT NULL DEFAULT 0 CHECK (used_micro_usd>=0),
  used_tokens bigint NOT NULL DEFAULT 0 CHECK (used_tokens>=0)
);
CREATE TABLE supervisor_enrollment_budgets (
  enrollment_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  limit_micro_usd bigint NOT NULL DEFAULT 0 CHECK (limit_micro_usd BETWEEN 0 AND 1000000000),
  limit_tokens bigint NOT NULL DEFAULT 0 CHECK (limit_tokens BETWEEN 0 AND 1000000000),
  used_micro_usd bigint NOT NULL DEFAULT 0 CHECK (used_micro_usd>=0),
  used_tokens bigint NOT NULL DEFAULT 0 CHECK (used_tokens>=0),
  FOREIGN KEY (enrollment_id,workspace_id) REFERENCES enrollments(id,workspace_id)
);
CREATE TABLE supervisor_job_spend (
  job_id uuid PRIMARY KEY,
  enrollment_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  micro_usd bigint NOT NULL DEFAULT 0 CHECK (micro_usd>=0),
  tokens bigint NOT NULL DEFAULT 0 CHECK (tokens>=0),
  FOREIGN KEY (job_id,enrollment_id,workspace_id) REFERENCES supervisor_jobs(id,enrollment_id,workspace_id)
);

CREATE TABLE supervisor_inputs (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL,
  enrollment_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  checkpoint_id text NOT NULL,
  fence jsonb NOT NULL,
  context jsonb NOT NULL,
  UNIQUE (job_id,checkpoint_id),
  UNIQUE (id,job_id,enrollment_id,workspace_id),
  FOREIGN KEY (job_id,enrollment_id,workspace_id) REFERENCES supervisor_jobs(id,enrollment_id,workspace_id)
);
CREATE TABLE supervisor_artifacts (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL,
  enrollment_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  operation_id text NOT NULL UNIQUE,
  owner_id uuid NOT NULL,
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  content jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id,job_id,enrollment_id,workspace_id),
  FOREIGN KEY (job_id,enrollment_id,workspace_id) REFERENCES supervisor_jobs(id,enrollment_id,workspace_id)
);
-- Only a trusted verifier/admin integration writes this registry, never the worker bridge or gateway.
CREATE TABLE supervisor_verifier_authorities (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 200),
  enabled boolean NOT NULL DEFAULT true,
  can_verify_companion boolean NOT NULL DEFAULT false,
  can_review_adaptation boolean NOT NULL DEFAULT false,
  UNIQUE (id,workspace_id)
);
CREATE TABLE supervisor_verifications (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL UNIQUE,
  enrollment_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  verifier_id uuid NOT NULL,
  fence jsonb NOT NULL,
  artifacts jsonb NOT NULL CHECK (jsonb_typeof(artifacts)='array'),
  verdict text NOT NULL CHECK (verdict IN ('verified','rejected')),
  application_kind text NOT NULL CHECK (application_kind IN ('companion_message','reviewed_adaptation')),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id,job_id,enrollment_id,workspace_id),
  FOREIGN KEY (job_id,enrollment_id,workspace_id) REFERENCES supervisor_jobs(id,enrollment_id,workspace_id),
  FOREIGN KEY (verifier_id,workspace_id) REFERENCES supervisor_verifier_authorities(id,workspace_id)
);
CREATE TABLE supervisor_adaptations (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL UNIQUE,
  enrollment_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  verification_id uuid NOT NULL,
  summary text NOT NULL CHECK (length(summary) BETWEEN 1 AND 16000),
  state text NOT NULL DEFAULT 'reviewed_proposal' CHECK (state='reviewed_proposal'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (job_id,enrollment_id,workspace_id) REFERENCES supervisor_jobs(id,enrollment_id,workspace_id),
  FOREIGN KEY (verification_id,job_id,enrollment_id,workspace_id) REFERENCES supervisor_verifications(id,job_id,enrollment_id,workspace_id)
);
CREATE TABLE supervisor_applications (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL UNIQUE,
  enrollment_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  verification_id uuid NOT NULL,
  application_kind text NOT NULL CHECK (application_kind IN ('companion_message','reviewed_adaptation')),
  target_id uuid NOT NULL,
  event_id uuid NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (job_id,enrollment_id,workspace_id) REFERENCES supervisor_jobs(id,enrollment_id,workspace_id),
  FOREIGN KEY (verification_id,job_id,enrollment_id,workspace_id) REFERENCES supervisor_verifications(id,job_id,enrollment_id,workspace_id),
  FOREIGN KEY (event_id,enrollment_id,workspace_id) REFERENCES learning_events(id,enrollment_id,workspace_id)
);
CREATE UNIQUE INDEX companion_messages_supervisor_once ON companion_messages(job_id) WHERE job_id IS NOT NULL AND role='assistant';
