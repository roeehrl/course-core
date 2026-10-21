-- Media pipeline (O08-O10): storyboards staff review before generation, generated images, exact
-- clips rendered from verified scenes, composition of reviewed clips, and automated checks of
-- generated media against its script and a reference (F12). Every widened check still admits
-- each row that migration 035 admitted.

-- A storyboard: the shots of one teaching clip for one enrollment's episode. A model may draft
-- it; staff edit and approve it before any shot is generated, rendered or composed.
CREATE TABLE media_storyboards(
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  enrollment_id uuid NOT NULL,
  course_release_id uuid NOT NULL REFERENCES course_releases(id),
  episode_id text NOT NULL CHECK(episode_id ~ '^[a-z][a-z0-9._:-]{0,127}$'),
  title text NOT NULL CHECK(length(title) BETWEEN 3 AND 200),
  objective text NOT NULL CHECK(length(objective) BETWEEN 10 AND 2000),
  script text NOT NULL CHECK(length(script) BETWEEN 20 AND 8000),
  shots jsonb NOT NULL CHECK(jsonb_typeof(shots) = 'array' AND jsonb_array_length(shots) BETWEEN 1 AND 8),
  reference_visual_id text CHECK(reference_visual_id IS NULL OR reference_visual_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  drafted_by text NOT NULL CHECK(drafted_by IN('model','staff')),
  draft_model_id text CHECK(draft_model_id IS NULL OR length(draft_model_id) BETWEEN 1 AND 2048),
  -- A model draft is requested in one transaction and filled in after the call returns.
  draft_status text NOT NULL DEFAULT 'ready' CHECK(draft_status IN('pending','ready','failed')),
  state text NOT NULL CHECK(state IN('draft','approved','rejected')),
  revision integer NOT NULL DEFAULT 1 CHECK(revision BETWEEN 1 AND 1000),
  idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 128),
  request_digest text NOT NULL CHECK(request_digest ~ '^[a-f0-9]{64}$' OR request_digest = 'erased'),
  requested_by uuid NOT NULL REFERENCES app_users(id),
  reviewed_by uuid REFERENCES app_users(id),
  review_note text CHECK(review_note IS NULL OR length(review_note) BETWEEN 3 AND 2000),
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(workspace_id, idempotency_key),
  FOREIGN KEY(enrollment_id, workspace_id) REFERENCES enrollments(id, workspace_id),
  CHECK((state = 'draft') = (reviewed_by IS NULL) AND (reviewed_by IS NULL) = (reviewed_at IS NULL)),
  CHECK(state = 'draft' OR draft_status = 'ready'),
  CHECK((drafted_by = 'model') = (draft_model_id IS NOT NULL))
);
CREATE INDEX media_storyboards_release ON media_storyboards(course_release_id, created_at DESC);
CREATE INDEX media_storyboards_enrollment ON media_storyboards(enrollment_id);

-- Job kinds: a paid generated clip or image, an exact clip rendered from a verified scene, and a
-- composition of reviewed clips. Renders and compositions call no provider and cost nothing.
ALTER TABLE media_jobs DROP CONSTRAINT media_jobs_kind_check;
ALTER TABLE media_jobs ADD CONSTRAINT media_jobs_kind_check
  CHECK(kind IN('generated_short_video','generated_image','scene_clip','composed_video'));
ALTER TABLE media_jobs ALTER COLUMN provider_revision DROP NOT NULL;
ALTER TABLE media_jobs DROP CONSTRAINT media_jobs_check;
ALTER TABLE media_jobs ADD CONSTRAINT media_jobs_operation_recorded
  CHECK(kind <> 'generated_short_video' OR state NOT IN('polling','generated','under_review','approved','rejected','attached') OR provider_operation IS NOT NULL);
ALTER TABLE media_jobs DROP CONSTRAINT media_jobs_check1;
ALTER TABLE media_jobs ADD CONSTRAINT media_jobs_paid_charged
  CHECK(kind IN('scene_clip','composed_video') OR state IN('requested','failed','cancelled') OR charged_micro_usd > 0);
ALTER TABLE media_jobs ADD CONSTRAINT media_jobs_render_unpaid
  CHECK(kind NOT IN('scene_clip','composed_video') OR (charged_micro_usd = 0 AND provider_revision IS NULL));
ALTER TABLE media_jobs ADD CONSTRAINT media_jobs_paid_provider
  CHECK(kind IN('scene_clip','composed_video') OR provider_revision IS NOT NULL);
ALTER TABLE media_jobs
  ADD COLUMN storyboard_id uuid REFERENCES media_storyboards(id),
  ADD COLUMN shot_id text CHECK(shot_id IS NULL OR shot_id ~ '^[a-z][a-z0-9-]{0,31}$'),
  ADD COLUMN reference_visual_id text CHECK(reference_visual_id IS NULL OR reference_visual_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  -- Render, composition or image settings; never learner content.
  ADD COLUMN source jsonb CHECK(source IS NULL OR (jsonb_typeof(source) = 'object' AND octet_length(source::text) <= 4096)),
  ADD CONSTRAINT media_jobs_shot_of_storyboard CHECK(shot_id IS NULL OR storyboard_id IS NOT NULL);
-- Renders and compositions wait in `requested` until a worker picks them up.
CREATE INDEX media_jobs_due_renders ON media_jobs(next_attempt_at) WHERE state = 'requested' AND kind IN('scene_clip','composed_video');
CREATE INDEX media_jobs_storyboard ON media_jobs(storyboard_id) WHERE storyboard_id IS NOT NULL;

-- Images are assets too, with the same content addressing and size bound.
ALTER TABLE media_assets DROP CONSTRAINT media_assets_mime_type_check;
ALTER TABLE media_assets ADD CONSTRAINT media_assets_mime_type_check
  CHECK(mime_type IN('video/mp4','video/webm','image/png','image/jpeg','image/webp'));
-- How the asset was made: exact-clip frame digest and settings, or the composed parts' digests.
ALTER TABLE media_assets ADD COLUMN provenance jsonb
  CHECK(provenance IS NULL OR (jsonb_typeof(provenance) = 'object' AND octet_length(provenance::text) <= 4096));
ALTER TABLE artifact_objects DROP CONSTRAINT artifact_objects_media_type_check;
ALTER TABLE artifact_objects ADD CONSTRAINT artifact_objects_media_type_check
  CHECK(media_type IN('video/mp4','video/webm','image/png','image/jpeg','image/webp','application/json'));

-- An approved image needs alt text (the visual description) but no captions or transcript; video
-- still needs all three, which the service enforces by kind.
ALTER TABLE media_reviews DROP CONSTRAINT media_reviews_check;
ALTER TABLE media_reviews ADD CONSTRAINT media_reviews_text_alternative
  CHECK(decision = 'rejected' OR visual_description IS NOT NULL);

-- Automated checks of one asset's text alternative against its sources. Append-only; the
-- review of the same asset and text must not contradict them.
CREATE TABLE media_checks(
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES media_jobs(id),
  workspace_id uuid NOT NULL,
  asset_sha256 text NOT NULL CHECK(asset_sha256 ~ '^[a-f0-9]{64}$'),
  -- Digest of the checked text alternative (transcript, description, captions), so a check
  -- applies only to the exact text a review then records.
  input_digest text NOT NULL CHECK(input_digest ~ '^[a-f0-9]{64}$'),
  verifier text NOT NULL CHECK(verifier IN('rules','model')),
  verdict text NOT NULL CHECK(verdict IN('consistent','contradicted','unverified')),
  findings jsonb NOT NULL CHECK(jsonb_typeof(findings) = 'array' AND octet_length(findings::text) <= 65536),
  reference_visual_id text,
  model_id text CHECK(model_id IS NULL OR length(model_id) BETWEEN 1 AND 2048),
  checked_by uuid NOT NULL REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK((verifier = 'model') = (model_id IS NOT NULL))
);
CREATE INDEX media_checks_job ON media_checks(job_id, created_at DESC);
