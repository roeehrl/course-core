-- YouTube Data API search receipts, reviewed video segments, structured research
-- requests with deadlines/cancellation, and the supervisor's verified choice of one
-- reviewed resource per objective. None of these rows grant credit.

-- A staff search. Only the approved topic's public query is sent; results are
-- metadata-only leads (MediaCandidates with reviewStatus 'unreviewed').
CREATE TABLE research_searches(
  id uuid PRIMARY KEY,workspace_id uuid NOT NULL REFERENCES workspaces(id),
  course_release_id uuid NOT NULL REFERENCES course_releases(id),topic_id text NOT NULL,
  provider text NOT NULL CHECK(provider='youtube_data_api'),
  sent jsonb NOT NULL,query_digest text NOT NULL CHECK(query_digest~'^[a-f0-9]{64}$'),
  hits jsonb NOT NULL CHECK(jsonb_typeof(hits)='array' AND jsonb_array_length(hits)<=10),
  searched_by uuid NOT NULL REFERENCES app_users(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(id,workspace_id,course_release_id)
);
CREATE INDEX research_searches_release ON research_searches(course_release_id,created_at DESC);

-- Provider metadata copied from a stored search hit when staff add it as a source.
ALTER TABLE research_sources ADD COLUMN search_id uuid,
  ADD COLUMN duration_seconds integer CHECK(duration_seconds IS NULL OR duration_seconds BETWEEN 0 AND 86400),
  ADD COLUMN captions_status text CHECK(captions_status IS NULL OR captions_status IN('creator_captions','unknown')),
  ADD COLUMN embeddable boolean,
  ADD CONSTRAINT research_sources_search_fk FOREIGN KEY(search_id,workspace_id,course_release_id) REFERENCES research_searches(id,workspace_id,course_release_id);

-- A reviewer-watched part of a video. Never derived from metadata.
ALTER TABLE research_reviews ADD COLUMN segment_start_seconds integer,ADD COLUMN segment_end_seconds integer,
  ADD CONSTRAINT research_reviews_segment CHECK((segment_start_seconds IS NULL)=(segment_end_seconds IS NULL)
    AND (segment_start_seconds IS NULL OR (segment_start_seconds>=0 AND segment_end_seconds>segment_start_seconds AND segment_end_seconds<=86400)));

-- Structured, learner-free request fields (SDK ResearchRequest) bound by digest,
-- with the task's deadline and an explicit cancellation reason.
ALTER TABLE research_requests ADD COLUMN objective_id text,ADD COLUMN request jsonb,
  ADD COLUMN request_digest text CHECK(request_digest IS NULL OR request_digest~'^[a-f0-9]{64}$'),
  ADD COLUMN deadline_at timestamptz,ADD COLUMN cancelled_at timestamptz,
  ADD COLUMN cancel_reason text CHECK(cancel_reason IS NULL OR cancel_reason IN('learner','staff','deadline','topic_changed','erased')),
  ADD CONSTRAINT research_requests_cancel CHECK((state='cancelled')=(cancelled_at IS NOT NULL) AND (cancelled_at IS NULL)=(cancel_reason IS NULL)),
  ADD CONSTRAINT research_requests_structured CHECK((request IS NULL)=(request_digest IS NULL) AND (request IS NULL OR objective_id IS NOT NULL));

-- One verified, supervisor-chosen reviewed resource per learner objective. A newer
-- choice supersedes the old one; erasure or revocation ends it.
CREATE TABLE research_resource_choices(
  id uuid PRIMARY KEY,workspace_id uuid NOT NULL,enrollment_id uuid NOT NULL,
  objective_id text NOT NULL,episode_id text NOT NULL,attachment_id uuid NOT NULL REFERENCES research_attachments(id),
  review_id text NOT NULL,job_id uuid NOT NULL,permission_revision integer NOT NULL,candidate_digest text NOT NULL CHECK(candidate_digest~'^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),ended_at timestamptz,
  end_reason text CHECK(end_reason IS NULL OR end_reason IN('superseded','erased','consent_withdrawn')),
  CHECK((ended_at IS NULL)=(end_reason IS NULL)),
  FOREIGN KEY(enrollment_id,workspace_id) REFERENCES enrollments(id,workspace_id),
  FOREIGN KEY(job_id,enrollment_id,workspace_id) REFERENCES supervisor_jobs(id,enrollment_id,workspace_id)
);
CREATE UNIQUE INDEX research_resource_choices_live ON research_resource_choices(enrollment_id,objective_id) WHERE ended_at IS NULL;
CREATE UNIQUE INDEX research_resource_choices_job ON research_resource_choices(job_id,objective_id);
