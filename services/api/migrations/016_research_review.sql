-- Staff-approved public sources, immutable inspections, append-only reviews and
-- revocable, expiring optional attachments. None of these rows grant credit.
CREATE TABLE research_sources(
  id uuid PRIMARY KEY,workspace_id uuid NOT NULL REFERENCES workspaces(id),
  course_release_id uuid NOT NULL REFERENCES course_releases(id),topic_id text NOT NULL,
  kind text NOT NULL CHECK(kind IN('web','youtube')),url text NOT NULL CHECK(length(url)<=2048),
  host text NOT NULL,fallback_text text CHECK(fallback_text IS NULL OR length(fallback_text) BETWEEN 1 AND 10000),
  candidate_id uuid REFERENCES research_candidates(id),
  added_by uuid NOT NULL REFERENCES app_users(id),expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(course_release_id,topic_id,kind,url),UNIQUE(id,workspace_id,course_release_id)
);
CREATE TABLE research_inspections(
  id text PRIMARY KEY CHECK(id~'^[a-f0-9]{64}$'),source_id uuid NOT NULL,workspace_id uuid NOT NULL,course_release_id uuid NOT NULL,
  policy_revision integer NOT NULL,document jsonb NOT NULL,content_digest text NOT NULL CHECK(content_digest~'^[a-f0-9]{64}$'),
  inspected_by uuid NOT NULL REFERENCES app_users(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(id,workspace_id,course_release_id),
  FOREIGN KEY(source_id,workspace_id,course_release_id) REFERENCES research_sources(id,workspace_id,course_release_id)
);
CREATE INDEX research_inspections_source ON research_inspections(source_id,created_at DESC);
CREATE TABLE research_inspection_failures(
  id uuid PRIMARY KEY,source_id uuid NOT NULL,workspace_id uuid NOT NULL,course_release_id uuid NOT NULL,
  code text NOT NULL CHECK(code~'^[A-Z_]{1,64}$'),actor_id uuid NOT NULL REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(source_id,workspace_id,course_release_id) REFERENCES research_sources(id,workspace_id,course_release_id)
);
CREATE TABLE research_reviews(
  id text PRIMARY KEY CHECK(id~'^[a-f0-9]{64}$'),inspection_id text NOT NULL,workspace_id uuid NOT NULL,course_release_id uuid NOT NULL,
  decision text NOT NULL CHECK(decision IN('approved','rejected','needs_review')),document jsonb NOT NULL,
  reviewed_by uuid NOT NULL REFERENCES app_users(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(id,workspace_id,course_release_id),
  FOREIGN KEY(inspection_id,workspace_id,course_release_id) REFERENCES research_inspections(id,workspace_id,course_release_id)
);
CREATE TABLE research_attachments(
  id uuid PRIMARY KEY,review_id text NOT NULL,workspace_id uuid NOT NULL,course_release_id uuid NOT NULL,
  episode_id text NOT NULL,topic_id text NOT NULL,expires_at timestamptz NOT NULL,
  attached_by uuid NOT NULL REFERENCES app_users(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,revoked_by uuid REFERENCES app_users(id),revoke_reason text CHECK(revoke_reason IS NULL OR length(revoke_reason) BETWEEN 10 AND 1000),
  CHECK((revoked_at IS NULL)=(revoked_by IS NULL) AND (revoked_at IS NULL)=(revoke_reason IS NULL)),
  FOREIGN KEY(review_id,workspace_id,course_release_id) REFERENCES research_reviews(id,workspace_id,course_release_id)
);
-- At most one live attachment of the same reviewed source per episode.
CREATE UNIQUE INDEX research_attachments_live ON research_attachments(course_release_id,episode_id,review_id) WHERE revoked_at IS NULL;
CREATE INDEX research_attachments_episode ON research_attachments(course_release_id,episode_id) WHERE revoked_at IS NULL;
CREATE TABLE research_command_receipts(
  workspace_id uuid NOT NULL REFERENCES workspaces(id),idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 128),
  request_digest text NOT NULL,actor_id uuid NOT NULL REFERENCES app_users(id),response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(workspace_id,idempotency_key)
);
