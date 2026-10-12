-- Course identity and mutable administrative metadata are separate from immutable releases.
CREATE TABLE admin_course_catalog (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  course_key text NOT NULL,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  description text NOT NULL DEFAULT '',
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, course_key),
  UNIQUE (id, workspace_id)
);
CREATE TABLE admin_release_reviews (
  release_id uuid PRIMARY KEY REFERENCES course_releases(id),
  catalog_id uuid NOT NULL REFERENCES admin_course_catalog(id),
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','pending_review','approved')),
  notes text NOT NULL DEFAULT '',
  reviewed_digest text,
  reviewed_by uuid REFERENCES app_users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE admin_command_receipts (
  catalog_id uuid NOT NULL REFERENCES admin_course_catalog(id),
  idempotency_key text NOT NULL,
  request_digest text NOT NULL,
  actor_id uuid NOT NULL REFERENCES app_users(id),
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (catalog_id, idempotency_key)
);
CREATE TABLE admin_evidence_reviews (
  id uuid PRIMARY KEY,
  evidence_id uuid NOT NULL REFERENCES evidence(id),
  enrollment_id uuid NOT NULL REFERENCES enrollments(id),
  actor_id uuid NOT NULL REFERENCES app_users(id),
  decision text NOT NULL CHECK (decision IN ('accept','reject')),
  note text NOT NULL CHECK (length(note) BETWEEN 1 AND 600),
  event_id uuid NOT NULL REFERENCES learning_events(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX admin_evidence_reviews_latest ON admin_evidence_reviews(evidence_id, created_at DESC);
CREATE TABLE admin_provider_requests (
  id uuid PRIMARY KEY,
  catalog_id uuid NOT NULL REFERENCES admin_course_catalog(id),
  provider_id text NOT NULL,
  connection_label text NOT NULL,
  environment text NOT NULL,
  requested_by uuid NOT NULL REFERENCES app_users(id),
  state text NOT NULL DEFAULT 'pending_review' CHECK (state IN ('pending_review','resolved','rejected')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX admin_provider_request_active ON admin_provider_requests(catalog_id, provider_id) WHERE state='pending_review';
CREATE TABLE admin_policy_previews (
  id uuid PRIMARY KEY,
  enrollment_id uuid NOT NULL REFERENCES enrollments(id),
  actor_id uuid NOT NULL REFERENCES app_users(id),
  enrollment_revision integer NOT NULL,
  policy_revision integer NOT NULL,
  ledger_revision integer NOT NULL,
  preview_digest text NOT NULL,
  preview jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO admin_course_catalog(id,workspace_id,course_key,title,description)
SELECT gen_random_uuid(), workspace_id, course_key, learner_bundle->>'title', COALESCE(learner_bundle->>'summary','')
FROM (SELECT DISTINCT ON (workspace_id,course_key) * FROM course_releases ORDER BY workspace_id,course_key,created_at) r;
INSERT INTO admin_release_reviews(release_id,catalog_id)
SELECT r.id,c.id FROM course_releases r JOIN admin_course_catalog c USING(workspace_id,course_key);

CREATE FUNCTION admin_protect_published_release() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.status IN ('published','archived') THEN
      RAISE EXCEPTION 'PUBLISHED_RELEASE_IMMUTABLE' USING ERRCODE='23514';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status IN ('published','archived') AND
    (NEW.id IS DISTINCT FROM OLD.id OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR
     NEW.course_key IS DISTINCT FROM OLD.course_key OR NEW.version IS DISTINCT FROM OLD.version OR
     NEW.digest IS DISTINCT FROM OLD.digest OR NEW.server_bundle IS DISTINCT FROM OLD.server_bundle OR
     NEW.learner_bundle IS DISTINCT FROM OLD.learner_bundle OR NEW.created_by IS DISTINCT FROM OLD.created_by OR
     NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.status='draft') THEN
    RAISE EXCEPTION 'PUBLISHED_RELEASE_IMMUTABLE' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER admin_release_immutable BEFORE UPDATE OR DELETE ON course_releases
FOR EACH ROW EXECUTE FUNCTION admin_protect_published_release();
