CREATE TABLE supervisor_permissions (
  enrollment_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  adaptive_teaching boolean NOT NULL DEFAULT false,
  changed_by uuid NOT NULL REFERENCES app_users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (enrollment_id,workspace_id) REFERENCES enrollments(id,workspace_id)
);
CREATE TABLE supervisor_tool_calls (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL,
  enrollment_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  operation_id text NOT NULL,
  step integer NOT NULL CHECK (step BETWEEN 0 AND 7),
  tool text NOT NULL CHECK (length(tool) BETWEEN 1 AND 128),
  request_digest text NOT NULL CHECK (request_digest~'^[a-f0-9]{64}$'),
  arguments jsonb NOT NULL,
  outcome jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (operation_id,step),
  FOREIGN KEY (job_id,enrollment_id,workspace_id) REFERENCES supervisor_jobs(id,enrollment_id,workspace_id)
);
CREATE TABLE supervisor_plan_effects (
  job_id uuid PRIMARY KEY,
  enrollment_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  proposal_id uuid NOT NULL,
  plan_revision integer NOT NULL CHECK (plan_revision>0),
  permission_revision integer NOT NULL CHECK (permission_revision>0),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (job_id,enrollment_id,workspace_id) REFERENCES supervisor_jobs(id,enrollment_id,workspace_id),
  FOREIGN KEY (proposal_id,enrollment_id) REFERENCES adaptation_proposals(id,enrollment_id)
);
