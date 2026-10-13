-- Learner data erasure. Immutable learning history may be REDACTED (never
-- deleted) only inside an erasure transaction that names the same enrollment
-- through the transaction-local setting course_core.erasure_enrollment.
ALTER TABLE enrollments DROP CONSTRAINT enrollments_status_check;
ALTER TABLE enrollments ADD CONSTRAINT enrollments_status_check CHECK (status IN ('active','paused','closed','completed','erased'));
CREATE TABLE data_erasures(
  id uuid PRIMARY KEY,enrollment_id uuid NOT NULL UNIQUE,workspace_id uuid NOT NULL,
  requested_by uuid NOT NULL REFERENCES app_users(id),actor_kind text NOT NULL CHECK(actor_kind IN('learner','staff')),
  reason text NOT NULL CHECK(length(reason) BETWEEN 10 AND 1000),counts jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(enrollment_id,workspace_id) REFERENCES enrollments(id,workspace_id)
);
CREATE TABLE data_exports(
  id uuid PRIMARY KEY,enrollment_id uuid NOT NULL,workspace_id uuid NOT NULL,
  requested_by uuid NOT NULL REFERENCES app_users(id),actor_kind text NOT NULL CHECK(actor_kind IN('learner','staff')),
  digest text NOT NULL CHECK(digest~'^[a-f0-9]{64}$'),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(enrollment_id,workspace_id) REFERENCES enrollments(id,workspace_id)
);
CREATE FUNCTION erasure_permits(old_row jsonb) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('course_core.erasure_enrollment', true),'')<>''
    AND old_row->>'enrollment_id'=current_setting('course_core.erasure_enrollment', true)
$$;
CREATE OR REPLACE FUNCTION learner_model_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND erasure_permits(to_jsonb(OLD)) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'LEARNER_MODEL_HISTORY_IMMUTABLE' USING ERRCODE='23514';
END $$;
CREATE OR REPLACE FUNCTION adaptation_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND erasure_permits(to_jsonb(OLD)) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'immutable adaptation provenance' USING ERRCODE='23514';
END $$;
CREATE OR REPLACE FUNCTION adaptation_proposal_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'retain adaptation proposal' USING ERRCODE='23514'; END IF;
  IF erasure_permits(to_jsonb(OLD)) THEN RETURN NEW; END IF;
  IF OLD.status<>'verified' OR NEW.status<>'applied' OR NEW.applied_revision IS NULL
    OR (to_jsonb(NEW)-'status'-'applied_revision') IS DISTINCT FROM (to_jsonb(OLD)-'status'-'applied_revision')
  THEN RAISE EXCEPTION 'invalid adaptation proposal transition' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
