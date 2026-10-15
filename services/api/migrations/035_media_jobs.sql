-- Durable generated-media jobs. Paid work is admitted against the existing
-- supervisor workspace/enrollment budgets; nothing here is learner evidence.
CREATE TABLE media_jobs(
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  enrollment_id uuid NOT NULL,
  course_release_id uuid NOT NULL REFERENCES course_releases(id),
  episode_id text NOT NULL CHECK(episode_id ~ '^[a-z][a-z0-9._:-]{0,127}$'),
  kind text NOT NULL CHECK(kind IN('generated_short_video')),
  title text NOT NULL CHECK(length(title) BETWEEN 3 AND 200),
  objective text NOT NULL CHECK(length(objective) BETWEEN 10 AND 2000),
  script text NOT NULL CHECK(length(script) BETWEEN 20 AND 8000),
  provider_revision integer NOT NULL,
  model_id text NOT NULL CHECK(length(model_id) BETWEEN 1 AND 2048),
  settings jsonb NOT NULL,
  pricing jsonb,
  estimate_micro_usd bigint CHECK(estimate_micro_usd IS NULL OR estimate_micro_usd >= 0),
  charged_micro_usd bigint NOT NULL DEFAULT 0 CHECK(charged_micro_usd >= 0),
  state text NOT NULL CHECK(state IN('requested','admitted','submitted','polling','generated','under_review',
    'approved','rejected','attached','expired','failed','cancelled','uncertain')),
  failure_code text CHECK(failure_code IS NULL OR failure_code ~ '^[A-Z_]{1,64}$'),
  idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 128),
  request_digest text NOT NULL CHECK(request_digest ~ '^[a-f0-9]{64}$'),
  -- Provider operation handle (opaque adapter state) used for reconciliation; never resubmitted.
  provider_operation jsonb,
  provider_operation_id text CHECK(provider_operation_id IS NULL OR length(provider_operation_id) BETWEEN 1 AND 512),
  submit_attempts integer NOT NULL DEFAULT 0 CHECK(submit_attempts BETWEEN 0 AND 3),
  poll_attempts integer NOT NULL DEFAULT 0 CHECK(poll_attempts >= 0),
  submit_started_at timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deadline_at timestamptz NOT NULL,
  lease_token uuid,
  lease_until timestamptz,
  remote_may_continue boolean NOT NULL DEFAULT false,
  requested_by uuid NOT NULL REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(workspace_id, idempotency_key),
  UNIQUE(id, workspace_id),
  FOREIGN KEY(enrollment_id, workspace_id) REFERENCES enrollments(id, workspace_id),
  FOREIGN KEY(workspace_id, provider_revision) REFERENCES workspace_provider_versions(workspace_id, revision),
  CHECK(state NOT IN('polling','generated','under_review','approved','rejected','attached') OR provider_operation IS NOT NULL),
  CHECK(state IN('requested','failed','cancelled') OR charged_micro_usd > 0)
);
CREATE INDEX media_jobs_due ON media_jobs(next_attempt_at)
  WHERE state IN('admitted','submitted','polling','uncertain','generated');
CREATE INDEX media_jobs_release ON media_jobs(course_release_id, created_at DESC);
CREATE TABLE media_job_events(
  id bigserial PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES media_jobs(id),
  from_state text,
  to_state text NOT NULL,
  code text CHECK(code IS NULL OR code ~ '^[A-Z_]{1,64}$'),
  actor_id uuid REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX media_job_events_job ON media_job_events(job_id, id);
-- Content-addressed, size-bounded generated asset. One per job.
CREATE TABLE media_assets(
  job_id uuid PRIMARY KEY REFERENCES media_jobs(id),
  workspace_id uuid NOT NULL,
  sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
  mime_type text NOT NULL CHECK(mime_type IN('video/mp4','video/webm')),
  byte_length integer NOT NULL CHECK(byte_length BETWEEN 1 AND 33554432),
  content bytea NOT NULL CHECK(octet_length(content) = byte_length),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
-- Append-only staff review bound to the exact asset hash. Approval requires a text alternative.
CREATE TABLE media_reviews(
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES media_jobs(id),
  workspace_id uuid NOT NULL,
  decision text NOT NULL CHECK(decision IN('approved','rejected')),
  asset_sha256 text NOT NULL CHECK(asset_sha256 ~ '^[a-f0-9]{64}$'),
  captions_vtt text CHECK(captions_vtt IS NULL OR length(captions_vtt) BETWEEN 8 AND 100000),
  transcript text CHECK(transcript IS NULL OR length(transcript) BETWEEN 20 AND 20000),
  visual_description text CHECK(visual_description IS NULL OR length(visual_description) BETWEEN 20 AND 5000),
  findings jsonb NOT NULL,
  rationale text NOT NULL CHECK(length(rationale) BETWEEN 20 AND 2000),
  reviewed_by uuid NOT NULL REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK(decision = 'rejected' OR (captions_vtt IS NOT NULL AND transcript IS NOT NULL AND visual_description IS NOT NULL))
);
CREATE UNIQUE INDEX media_reviews_once ON media_reviews(job_id);
-- Optional, expiring, revocable help for one enrollment's episode. Never credit.
CREATE TABLE media_attachments(
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES media_jobs(id),
  review_id uuid NOT NULL REFERENCES media_reviews(id),
  workspace_id uuid NOT NULL,
  enrollment_id uuid NOT NULL,
  episode_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  attached_by uuid NOT NULL REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  revoked_by uuid REFERENCES app_users(id),
  revoke_reason text CHECK(revoke_reason IS NULL OR length(revoke_reason) BETWEEN 10 AND 1000),
  CHECK((revoked_at IS NULL) = (revoked_by IS NULL) AND (revoked_at IS NULL) = (revoke_reason IS NULL)),
  FOREIGN KEY(enrollment_id, workspace_id) REFERENCES enrollments(id, workspace_id)
);
CREATE UNIQUE INDEX media_attachments_once ON media_attachments(job_id);
CREATE INDEX media_attachments_episode ON media_attachments(enrollment_id, episode_id) WHERE revoked_at IS NULL;
CREATE TABLE media_command_receipts(
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 128),
  request_digest text NOT NULL CHECK(request_digest ~ '^[a-f0-9]{64}$'),
  actor_id uuid NOT NULL REFERENCES app_users(id),
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id, idempotency_key)
);
