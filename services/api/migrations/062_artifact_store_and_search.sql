-- Optional S3-compatible object storage for large artifacts, and Postgres full-text retrieval.
--
-- Object storage is off unless the operator configures it (artifact-store.ts). Postgres keeps the
-- authoritative record of every stored object: its digest, size, type, owner scope and lifecycle.
-- The object itself is opaque bytes addressed by a random key; every read is checked against the
-- digest kept here, so a changed or substituted object is refused instead of served.

CREATE TABLE artifact_objects (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  enrollment_id uuid,
  purpose text NOT NULL CHECK (purpose IN ('media_asset','supervisor_artifact')),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  byte_length bigint NOT NULL CHECK (byte_length BETWEEN 0 AND 33554432),
  media_type text NOT NULL CHECK (media_type IN ('video/mp4','video/webm','application/json')),
  backend text NOT NULL CHECK (backend = 's3'),
  bucket text NOT NULL CHECK (bucket ~ '^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$'),
  object_key text NOT NULL CHECK (length(object_key) BETWEEN 1 AND 512 AND object_key ~ '^[A-Za-z0-9/_.-]+$'),
  -- The store's entity tag at upload. Range reads send it as If-Match so a replaced object fails.
  etag text CHECK (etag IS NULL OR length(etag) BETWEEN 1 AND 200),
  -- staged: uploaded (or being uploaded) but not yet referenced; a sweep deletes stale ones.
  -- stored: referenced by exactly one owner row. delete_pending: its owner let go (erasure).
  state text NOT NULL CHECK (state IN ('staged','stored','delete_pending','deleted')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  stored_at timestamptz,
  delete_requested_at timestamptz,
  deleted_at timestamptz,
  delete_attempts integer NOT NULL DEFAULT 0 CHECK (delete_attempts >= 0),
  last_error text CHECK (last_error IS NULL OR last_error ~ '^[A-Z0-9_]{1,64}$'),
  UNIQUE (bucket, object_key),
  FOREIGN KEY (enrollment_id, workspace_id) REFERENCES enrollments(id, workspace_id),
  CHECK (state <> 'stored' OR stored_at IS NOT NULL),
  CHECK (state <> 'delete_pending' OR delete_requested_at IS NOT NULL),
  CHECK (state <> 'deleted' OR deleted_at IS NOT NULL)
);
CREATE INDEX artifact_objects_sweep ON artifact_objects(state, created_at) WHERE state IN ('staged','delete_pending');
CREATE INDEX artifact_objects_enrollment ON artifact_objects(enrollment_id) WHERE enrollment_id IS NOT NULL;

-- A generated clip is kept either inline (the default) or as one stored object.
ALTER TABLE media_assets ALTER COLUMN content DROP NOT NULL;
ALTER TABLE media_assets ADD COLUMN object_id uuid UNIQUE REFERENCES artifact_objects(id);
ALTER TABLE media_assets ADD CONSTRAINT media_assets_one_body CHECK ((content IS NULL) <> (object_id IS NULL));

-- A supervisor artifact is kept inline (the default) or, above the configured size, as one
-- stored object holding its canonical JSON (whose SHA-256 is the artifact digest).
ALTER TABLE supervisor_artifacts ALTER COLUMN content DROP NOT NULL;
ALTER TABLE supervisor_artifacts ADD COLUMN content_object_id uuid UNIQUE REFERENCES artifact_objects(id);
ALTER TABLE supervisor_artifacts ADD CONSTRAINT supervisor_artifacts_one_body CHECK ((content IS NULL) <> (content_object_id IS NULL));
-- The kind of a stored artifact, for views that list artifacts without reading their bodies.
ALTER TABLE supervisor_artifacts ADD COLUMN content_kind text CHECK (content_kind IS NULL OR content_kind ~ '^[a-z_]{1,40}$');
ALTER TABLE supervisor_artifacts ADD CONSTRAINT supervisor_artifacts_stored_kind CHECK (content_object_id IS NULL OR content_kind IS NOT NULL);

-- When an owner row lets go of its object (erasure deletes a clip or redacts an artifact), the
-- object is queued for deletion from the store. Triggers keep every erasure path covered.
CREATE FUNCTION artifact_object_release(released uuid) RETURNS void LANGUAGE sql AS $$
  UPDATE artifact_objects SET state='delete_pending',delete_requested_at=clock_timestamp()
   WHERE id=released AND state IN ('staged','stored');
$$;
CREATE FUNCTION media_asset_object_released() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN PERFORM artifact_object_release(OLD.object_id); RETURN OLD; END IF;
  IF OLD.object_id IS DISTINCT FROM NEW.object_id THEN PERFORM artifact_object_release(OLD.object_id); END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION supervisor_artifact_object_released() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN PERFORM artifact_object_release(OLD.content_object_id); RETURN OLD; END IF;
  IF OLD.content_object_id IS DISTINCT FROM NEW.content_object_id THEN PERFORM artifact_object_release(OLD.content_object_id); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER media_assets_object_released AFTER DELETE OR UPDATE OF object_id ON media_assets
  FOR EACH ROW WHEN (OLD.object_id IS NOT NULL) EXECUTE FUNCTION media_asset_object_released();
CREATE TRIGGER supervisor_artifacts_object_released AFTER DELETE OR UPDATE OF content_object_id ON supervisor_artifacts
  FOR EACH ROW WHEN (OLD.content_object_id IS NOT NULL) EXECUTE FUNCTION supervisor_artifact_object_released();

-- Full-text retrieval (no embeddings). The 'simple' configuration is language-neutral: courses
-- may be written in any language, so words are lower-cased but not stemmed; queries use prefix
-- matching instead (retrieval.ts).

-- Course text passages of each release: every text block of every episode, and every cited
-- source's title. Rebuilt when a draft's bundle changes; published bundles are immutable.
CREATE TABLE course_release_passages (
  course_release_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  passage_id text NOT NULL CHECK (length(passage_id) BETWEEN 1 AND 300),
  kind text NOT NULL CHECK (kind IN ('text_block','source')),
  chapter_id text,
  episode_id text,
  title text NOT NULL CHECK (length(title) <= 500),
  body text NOT NULL CHECK (length(body) <= 20000),
  source_refs text[] NOT NULL DEFAULT '{}',
  search tsvector GENERATED ALWAYS AS (setweight(to_tsvector('simple', title), 'A') || setweight(to_tsvector('simple', body), 'B')) STORED,
  PRIMARY KEY (course_release_id, passage_id),
  FOREIGN KEY (course_release_id, workspace_id) REFERENCES course_releases(id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX course_release_passages_search ON course_release_passages USING gin(search);

CREATE FUNCTION course_release_passages_for(release uuid) RETURNS void LANGUAGE sql AS $$
  DELETE FROM course_release_passages WHERE course_release_id=release;
  INSERT INTO course_release_passages(course_release_id,workspace_id,passage_id,kind,chapter_id,episode_id,title,body,source_refs)
  SELECT r.id,r.workspace_id,'block:'||left(block->>'id',200),'text_block',chapter->>'id',episode->>'id',
         left(coalesce(episode->>'title',''),500),left(block->>'markdown',20000),
         ARRAY(SELECT left(ref,200) FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(block->'sourceRefs')='array' THEN block->'sourceRefs' ELSE '[]'::jsonb END) ref LIMIT 50)
    FROM course_releases r
    CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(r.server_bundle->'chapters')='array' THEN r.server_bundle->'chapters' ELSE '[]'::jsonb END) chapter
    CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(chapter->'episodes')='array' THEN chapter->'episodes' ELSE '[]'::jsonb END) episode
    CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(episode->'blocks')='array' THEN episode->'blocks' ELSE '[]'::jsonb END) block
   WHERE r.id=release AND block->>'type'='text' AND jsonb_typeof(block->'markdown')='string' AND block->>'id' IS NOT NULL
  ON CONFLICT DO NOTHING;
  INSERT INTO course_release_passages(course_release_id,workspace_id,passage_id,kind,title,body,source_refs)
  SELECT r.id,r.workspace_id,'source:'||left(source->>'id',200),'source',left(coalesce(source->>'title',''),500),'',ARRAY[left(source->>'id',200)]
    FROM course_releases r
    CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(r.server_bundle->'sources')='array' THEN r.server_bundle->'sources' ELSE '[]'::jsonb END) source
   WHERE r.id=release AND source->>'id' IS NOT NULL
  ON CONFLICT DO NOTHING;
$$;
CREATE FUNCTION course_release_passages_rebuild() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM course_release_passages_for(NEW.id); RETURN NEW; END $$;
CREATE TRIGGER course_release_passages_insert AFTER INSERT ON course_releases
  FOR EACH ROW EXECUTE FUNCTION course_release_passages_rebuild();
CREATE TRIGGER course_release_passages_update AFTER UPDATE OF server_bundle ON course_releases
  FOR EACH ROW WHEN (OLD.server_bundle IS DISTINCT FROM NEW.server_bundle) EXECUTE FUNCTION course_release_passages_rebuild();
-- Index the releases that already exist.
SELECT course_release_passages_for(id) FROM course_releases;

-- The learner's own companion questions. Assistant turns are never searched (retrieval.ts).
ALTER TABLE companion_messages ADD COLUMN search tsvector
  GENERATED ALWAYS AS (CASE WHEN role='learner' THEN to_tsvector('simple', left(content, 4000)) END) STORED;
CREATE INDEX companion_messages_search ON companion_messages USING gin(search) WHERE role='learner';
