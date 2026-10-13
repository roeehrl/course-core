-- Application linkage, distinct from learner acceptance and earned evidence.
CREATE TABLE supervisor_model_effects (
  job_id uuid PRIMARY KEY,
  enrollment_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  proposal_id uuid NOT NULL,
  permission_revision integer NOT NULL CHECK (permission_revision > 0),
  selection_digest text NOT NULL CHECK (selection_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (job_id,enrollment_id,workspace_id) REFERENCES supervisor_jobs(id,enrollment_id,workspace_id),
  FOREIGN KEY (proposal_id,enrollment_id,workspace_id) REFERENCES learner_model_proposals(id,enrollment_id,workspace_id)
);
