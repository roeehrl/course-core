-- Educational evaluation studies (study.ts, study-routes.ts): a study of one course release with
-- named arms, the assessment items that form its pre-test, post-test, transfer and delayed sets,
-- learner consent separate from enrollment, and a seeded, balanced arm assignment that never
-- changes once made. Only identifiers, codes, counts and digests are stored here; the consent text
-- itself is staff-written study configuration, never learner text.
CREATE TABLE studies (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  course_release_id uuid NOT NULL,
  title text NOT NULL CHECK (length(title) BETWEEN 3 AND 120),
  -- Plain-language purpose shown to learners in the consent prompt.
  purpose text NOT NULL CHECK (length(purpose) BETWEEN 20 AND 2000),
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','recruiting','closed')),
  -- [{id,label,behaviour}]: behaviour is one of fixed, chat_only, supervisor (validated in study.ts).
  arms jsonb NOT NULL CHECK (jsonb_typeof(arms)='array' AND jsonb_array_length(arms) BETWEEN 2 AND 6),
  -- {pre,post,transfer,delayed}: assessment item ids of the release.
  instruments jsonb NOT NULL CHECK (jsonb_typeof(instruments)='object'),
  -- Arms with fewer included participants than this are suppressed in every export.
  min_cell_size integer NOT NULL DEFAULT 5 CHECK (min_cell_size BETWEEN 3 AND 100),
  -- Secret allocation seed (its digest is published with each export so an auditor holding the
  -- seed can recompute every assignment) and a separate per-study pseudonym salt. Neither leaves
  -- the server.
  allocation_seed bytea NOT NULL CHECK (octet_length(allocation_seed)=32),
  seed_digest text NOT NULL CHECK (seed_digest ~ '^[a-f0-9]{64}$'),
  pseudonym_salt bytea NOT NULL CHECK (octet_length(pseudonym_salt)=32),
  -- The next allocation index. Never reused, also after an erased participant's row is deleted.
  next_allocation integer NOT NULL DEFAULT 0 CHECK (next_allocation >= 0),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_by uuid NOT NULL REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  opened_at timestamptz,
  closed_at timestamptz,
  FOREIGN KEY (course_release_id, workspace_id) REFERENCES course_releases(id, workspace_id),
  UNIQUE (id, workspace_id),
  CHECK ((state='draft') = (opened_at IS NULL)),
  CHECK ((state='closed') = (closed_at IS NOT NULL))
);
-- At most one study in draft or recruiting per release, so at most one arm applies to an enrollment.
CREATE UNIQUE INDEX studies_one_open_per_release ON studies(course_release_id) WHERE state <> 'closed';

-- One enrollment in one study: its allocation index and arm (immutable) and its current consent.
CREATE TABLE study_participants (
  study_id uuid NOT NULL,
  enrollment_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  allocation_index integer NOT NULL CHECK (allocation_index >= 0),
  arm_id text NOT NULL CHECK (arm_id ~ '^[a-z][a-z0-9_]{0,39}$'),
  consent text NOT NULL CHECK (consent IN ('consented','withdrawn')),
  -- Digest of the consent text the learner agreed to (study.ts consentDigest).
  consent_digest text NOT NULL CHECK (consent_digest ~ '^[a-f0-9]{64}$'),
  consent_revision integer NOT NULL DEFAULT 1 CHECK (consent_revision >= 1),
  assigned_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  consented_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  withdrawn_at timestamptz,
  PRIMARY KEY (study_id, enrollment_id),
  UNIQUE (study_id, allocation_index),
  FOREIGN KEY (study_id, workspace_id) REFERENCES studies(id, workspace_id),
  FOREIGN KEY (enrollment_id, workspace_id) REFERENCES enrollments(id, workspace_id),
  CHECK ((consent='withdrawn') = (withdrawn_at IS NOT NULL))
);
CREATE INDEX study_participants_enrollment ON study_participants(enrollment_id);

-- Append-only consent history.
CREATE TABLE study_consent_changes (
  id uuid PRIMARY KEY,
  study_id uuid NOT NULL,
  enrollment_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('consented','withdrawn')),
  consent_revision integer NOT NULL CHECK (consent_revision >= 1),
  consent_digest text NOT NULL CHECK (consent_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (study_id, enrollment_id, consent_revision),
  FOREIGN KEY (study_id, workspace_id) REFERENCES studies(id, workspace_id),
  FOREIGN KEY (enrollment_id, workspace_id) REFERENCES enrollments(id, workspace_id)
);

-- Every research export: who, in which format, how many rows, and the file's digest. No content.
CREATE TABLE study_exports (
  id uuid PRIMARY KEY,
  study_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  requested_by uuid NOT NULL REFERENCES app_users(id),
  requester_role text NOT NULL CHECK (requester_role ~ '^[a-z_]{1,40}$'),
  format text NOT NULL CHECK (format IN ('csv','json')),
  included integer NOT NULL CHECK (included >= 0),
  suppressed_arms integer NOT NULL CHECK (suppressed_arms >= 0),
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (study_id, workspace_id) REFERENCES studies(id, workspace_id)
);

-- An assignment is never changed: only consent fields move. A row (and its consent history) is
-- deleted only by the erasure of its own enrollment (018 erasure_permits).
CREATE FUNCTION study_participant_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF erasure_permits(to_jsonb(OLD)) THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'STUDY_PARTICIPANT_RETAINED' USING ERRCODE='23514';
  END IF;
  IF NEW.study_id IS DISTINCT FROM OLD.study_id OR NEW.enrollment_id IS DISTINCT FROM OLD.enrollment_id
    OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.allocation_index IS DISTINCT FROM OLD.allocation_index
    OR NEW.arm_id IS DISTINCT FROM OLD.arm_id OR NEW.assigned_at IS DISTINCT FROM OLD.assigned_at THEN
    RAISE EXCEPTION 'STUDY_ASSIGNMENT_IMMUTABLE' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER study_participants_guard BEFORE UPDATE OR DELETE ON study_participants
  FOR EACH ROW EXECUTE FUNCTION study_participant_guard();
CREATE FUNCTION study_consent_history_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND erasure_permits(to_jsonb(OLD)) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'STUDY_CONSENT_HISTORY_IMMUTABLE' USING ERRCODE='23514';
END $$;
CREATE TRIGGER study_consent_changes_guard BEFORE UPDATE OR DELETE ON study_consent_changes
  FOR EACH ROW EXECUTE FUNCTION study_consent_history_guard();
-- The allocation seed, pseudonym salt and arms of a study never change after creation of its
-- first assignment; the definition is editable only while it is a draft (enforced in study.ts,
-- and here for the secrets).
CREATE FUNCTION study_secrets_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.allocation_seed IS DISTINCT FROM OLD.allocation_seed OR NEW.pseudonym_salt IS DISTINCT FROM OLD.pseudonym_salt
    OR NEW.seed_digest IS DISTINCT FROM OLD.seed_digest OR NEW.course_release_id IS DISTINCT FROM OLD.course_release_id
    OR NEW.next_allocation < OLD.next_allocation
    OR (OLD.state <> 'draft' AND (NEW.arms IS DISTINCT FROM OLD.arms OR NEW.instruments IS DISTINCT FROM OLD.instruments
      OR NEW.purpose IS DISTINCT FROM OLD.purpose OR NEW.min_cell_size IS DISTINCT FROM OLD.min_cell_size))
    OR (OLD.state = 'closed' AND NEW.state <> 'closed') THEN
    RAISE EXCEPTION 'STUDY_DEFINITION_IMMUTABLE' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER studies_secrets_guard BEFORE UPDATE ON studies FOR EACH ROW EXECUTE FUNCTION study_secrets_guard();
CREATE FUNCTION study_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'STUDY_RETAINED' USING ERRCODE='23514'; END $$;
CREATE TRIGGER studies_no_delete BEFORE DELETE ON studies FOR EACH ROW EXECUTE FUNCTION study_no_delete();
CREATE TRIGGER study_exports_no_change BEFORE UPDATE OR DELETE ON study_exports FOR EACH ROW EXECUTE FUNCTION study_no_delete();

-- An event a study arm does not offer (for example a companion question in the fixed arm, or
-- proactive supervision in the chat-only arm) is consumed without starting a job.
ALTER TABLE supervisor_preparations DROP CONSTRAINT supervisor_preparations_disposition_check,
  ADD CONSTRAINT supervisor_preparations_disposition_check
  CHECK (disposition IN ('prepared','inactive','policy_denied','agent_event','supervision_stopped','coalesced','oversized','refused','study_arm'));
