ALTER TABLE supervisor_verifier_authorities ADD COLUMN can_collect_research boolean NOT NULL DEFAULT false;
ALTER TABLE supervisor_verifications DROP CONSTRAINT supervisor_verifications_application_kind_check;
ALTER TABLE supervisor_verifications ADD CONSTRAINT supervisor_verifications_application_kind_check CHECK(application_kind IN('companion_message','reviewed_adaptation','research_candidate'));
ALTER TABLE supervisor_applications DROP CONSTRAINT supervisor_applications_application_kind_check;
ALTER TABLE supervisor_applications ADD CONSTRAINT supervisor_applications_application_kind_check CHECK(application_kind IN('companion_message','reviewed_adaptation','research_candidate'));
CREATE TABLE research_requests(
  id uuid PRIMARY KEY,workspace_id uuid NOT NULL,enrollment_id uuid NOT NULL,course_release_id uuid NOT NULL REFERENCES course_releases(id),
  parent_job_id uuid NOT NULL,topic_id text NOT NULL,episode_id text NOT NULL,
  permission_revision integer NOT NULL,query_digest text NOT NULL CHECK(query_digest~'^[a-f0-9]{64}$'),
  state text NOT NULL DEFAULT 'staged' CHECK(state IN('staged','dispatched','collected','cancelled')),
  activation_event_id uuid REFERENCES learning_events(id),research_job_id uuid UNIQUE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(parent_job_id,topic_id),UNIQUE(id,enrollment_id,workspace_id),
  FOREIGN KEY(parent_job_id,enrollment_id,workspace_id) REFERENCES supervisor_jobs(id,enrollment_id,workspace_id),
  FOREIGN KEY(research_job_id,enrollment_id,workspace_id) REFERENCES supervisor_jobs(id,enrollment_id,workspace_id)
);
CREATE TABLE research_candidates(
  id uuid PRIMARY KEY,request_id uuid NOT NULL UNIQUE,job_id uuid NOT NULL UNIQUE,enrollment_id uuid NOT NULL,workspace_id uuid NOT NULL,
  artifact_id uuid NOT NULL,digest text NOT NULL CHECK(digest~'^[a-f0-9]{64}$'),review_state text NOT NULL DEFAULT 'unreviewed' CHECK(review_state='unreviewed'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(request_id,enrollment_id,workspace_id) REFERENCES research_requests(id,enrollment_id,workspace_id),
  FOREIGN KEY(artifact_id,job_id,enrollment_id,workspace_id) REFERENCES supervisor_artifacts(id,job_id,enrollment_id,workspace_id)
);
