-- Optional AI drafts for human reviewers of written answers. A learner opts in
-- separately from adaptive teaching; a draft is never a grade or evidence, and
-- the reviewer still records their own findings with their own quotations.
CREATE TABLE rubric_assist_consents(
  enrollment_id uuid PRIMARY KEY REFERENCES enrollments(id),workspace_id uuid NOT NULL,
  granted boolean NOT NULL,revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE rubric_assist_requests(
  id uuid PRIMARY KEY,attempt_id uuid NOT NULL UNIQUE REFERENCES attempts(id),enrollment_id uuid NOT NULL REFERENCES enrollments(id),
  workspace_id uuid NOT NULL,requested_by uuid NOT NULL REFERENCES app_users(id),consent_revision integer NOT NULL,
  rubric_digest text NOT NULL CHECK(rubric_digest~'^[a-f0-9]{64}$'),response_digest text NOT NULL CHECK(response_digest~'^[a-f0-9]{64}$'),
  state text NOT NULL DEFAULT 'requested' CHECK(state IN('requested','suggested')),
  activation_event_id uuid REFERENCES learning_events(id),job_id uuid UNIQUE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(id,enrollment_id,workspace_id),
  FOREIGN KEY(job_id,enrollment_id,workspace_id) REFERENCES supervisor_jobs(id,enrollment_id,workspace_id)
);
CREATE TABLE rubric_suggestions(
  id uuid PRIMARY KEY,request_id uuid NOT NULL UNIQUE,job_id uuid NOT NULL UNIQUE,enrollment_id uuid NOT NULL,workspace_id uuid NOT NULL,
  artifact_id uuid NOT NULL,digest text NOT NULL CHECK(digest~'^[a-f0-9]{64}$'),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(request_id,enrollment_id,workspace_id) REFERENCES rubric_assist_requests(id,enrollment_id,workspace_id),
  FOREIGN KEY(artifact_id,job_id,enrollment_id,workspace_id) REFERENCES supervisor_artifacts(id,job_id,enrollment_id,workspace_id)
);
-- Which draft, if any, the reviewer had open when recording their own review.
ALTER TABLE rubric_reviews ADD COLUMN suggestion_id uuid REFERENCES rubric_suggestions(id);
ALTER TABLE supervisor_verifier_authorities ADD COLUMN can_suggest_rubric boolean NOT NULL DEFAULT false;
ALTER TABLE supervisor_verifications DROP CONSTRAINT supervisor_verifications_application_kind_check;
ALTER TABLE supervisor_verifications ADD CONSTRAINT supervisor_verifications_application_kind_check CHECK(application_kind IN('companion_message','reviewed_adaptation','research_candidate','rubric_suggestion'));
ALTER TABLE supervisor_applications DROP CONSTRAINT supervisor_applications_application_kind_check;
ALTER TABLE supervisor_applications ADD CONSTRAINT supervisor_applications_application_kind_check CHECK(application_kind IN('companion_message','reviewed_adaptation','research_candidate','rubric_suggestion'));
