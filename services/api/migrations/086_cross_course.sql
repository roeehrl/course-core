-- Cross-course coordination (design §4, B01): staff-authored concept mappings between two course
-- releases, the learner's per-pair opt-in to share learner-model evidence between their own
-- enrollments, the suggestions a learner-level coordinator may propose from them, and the wake-ups
-- that open or stop that coordinator. See cross-course.ts and concept-mappings.ts.
--
-- Nothing here is assessment evidence. A suggestion never grants mastery, evidence or a gate: gates
-- read only the course's own assessments. Mappings are written only by people (owners or admins of
-- both courses); there is no model or agent path that creates or edits one.

-- One mapping per unordered pair of releases (stored with a_release_id < b_release_id).
CREATE TABLE concept_mappings (
  id uuid PRIMARY KEY,
  a_workspace_id uuid NOT NULL,
  a_release_id uuid NOT NULL,
  b_workspace_id uuid NOT NULL,
  b_release_id uuid NOT NULL,
  -- The current version (concept_mapping_versions.revision); 0 only inside the creating transaction.
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','retired')),
  created_by uuid NOT NULL REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (a_release_id, a_workspace_id) REFERENCES course_releases(id, workspace_id),
  FOREIGN KEY (b_release_id, b_workspace_id) REFERENCES course_releases(id, workspace_id),
  CHECK (a_release_id < b_release_id),
  UNIQUE (a_release_id, b_release_id)
);
CREATE INDEX concept_mappings_b ON concept_mappings (b_release_id);

-- Every saved version, kept forever: the mapping's audit trail. Each row names the person, the
-- role they held in each course's workspace when they saved it, what they did and the links.
-- Links hold course structure only (objective IDs and relations), never learner data.
CREATE TABLE concept_mapping_versions (
  mapping_id uuid NOT NULL REFERENCES concept_mappings(id),
  revision integer NOT NULL CHECK (revision > 0),
  action text NOT NULL CHECK (action IN ('created','revised','retired','restored')),
  links jsonb NOT NULL CHECK (jsonb_typeof(links) = 'array' AND jsonb_array_length(links) <= 200 AND octet_length(links::text) <= 65536),
  links_digest text NOT NULL CHECK (links_digest ~ '^[a-f0-9]{64}$'),
  -- Mappings are staff-authored by construction; a model-inferred mapping cannot be stored.
  author_kind text NOT NULL CHECK (author_kind = 'staff'),
  authored_by uuid NOT NULL REFERENCES app_users(id),
  a_role text NOT NULL CHECK (a_role IN ('owner','admin')),
  b_role text NOT NULL CHECK (b_role IN ('owner','admin')),
  note text NOT NULL DEFAULT '' CHECK (char_length(note) <= 500),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9:_-]{8,200}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (mapping_id, revision),
  UNIQUE (mapping_id, idempotency_key)
);
CREATE FUNCTION concept_mapping_versions_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'CONCEPT_MAPPING_HISTORY_IMMUTABLE' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER concept_mapping_versions_immutable BEFORE UPDATE OR DELETE ON concept_mapping_versions
  FOR EACH ROW EXECUTE FUNCTION concept_mapping_versions_immutable();
CREATE TRIGGER concept_mapping_versions_no_truncate BEFORE TRUNCATE ON concept_mapping_versions
  FOR EACH STATEMENT EXECUTE FUNCTION concept_mapping_versions_immutable();

-- One row per learner who ever opted in: the consent epoch the coordinator carries, and the lock
-- that serializes consent changes, erasure and planning passes for that learner.
CREATE TABLE cross_course_learners (
  user_id uuid PRIMARY KEY REFERENCES app_users(id),
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0)
);

-- The learner's opt-in for one pair of their own enrollments (a_enrollment_id < b_enrollment_id).
-- Absent or revoked means nothing is shared between the two in either direction.
CREATE TABLE cross_course_consents (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES app_users(id),
  a_enrollment_id uuid NOT NULL REFERENCES enrollments(id),
  b_enrollment_id uuid NOT NULL REFERENCES enrollments(id),
  state text NOT NULL CHECK (state IN ('granted','revoked')),
  revision integer NOT NULL CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (a_enrollment_id < b_enrollment_id),
  UNIQUE (a_enrollment_id, b_enrollment_id)
);
CREATE INDEX cross_course_consents_a ON cross_course_consents (a_enrollment_id) WHERE state = 'granted';
CREATE INDEX cross_course_consents_b ON cross_course_consents (b_enrollment_id) WHERE state = 'granted';
CREATE INDEX cross_course_consents_user ON cross_course_consents (user_id);

-- Each grant and revocation the learner made. Identifiers, states and times only. Rows are never
-- changed; they are deleted only by erasure of either enrollment (which removes the pair entirely).
CREATE TABLE cross_course_consent_changes (
  id uuid PRIMARY KEY,
  consent_id uuid NOT NULL REFERENCES cross_course_consents(id),
  revision integer NOT NULL CHECK (revision > 0),
  granted boolean NOT NULL,
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9:_-]{8,200}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (consent_id, revision),
  UNIQUE (consent_id, idempotency_key)
);
CREATE FUNCTION cross_course_consent_changes_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND coalesce(current_setting('course_core.erasure_enrollment', true), '') <> '' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'CROSS_COURSE_CONSENT_HISTORY_IMMUTABLE' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER cross_course_consent_changes_guard BEFORE UPDATE OR DELETE ON cross_course_consent_changes
  FOR EACH ROW EXECUTE FUNCTION cross_course_consent_changes_guard();

-- Learner-confirmable suggestions, shown only in the enrollment they are about (enrollment_id).
-- Each one was verified by the host against the opt-in, the mapping version and the learner's own
-- evidence when it was stored. Revocation of the pair and erasure of either enrollment delete them.
CREATE TABLE cross_course_suggestions (
  id uuid PRIMARY KEY,
  consent_id uuid NOT NULL REFERENCES cross_course_consents(id),
  enrollment_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  source_enrollment_id uuid NOT NULL REFERENCES enrollments(id),
  kind text NOT NULL CHECK (kind IN ('prerequisite_reminder','shown_elsewhere','pacing')),
  -- The objective in this enrollment's course the suggestion is about (null for pacing advice).
  objective_id text CHECK (objective_id IS NULL OR objective_id ~ '^[a-z][a-z0-9._:-]{0,127}$'),
  -- The mapped objectives in the other course (one for a link, up to 20 for pacing advice).
  source_objective_ids jsonb NOT NULL CHECK (jsonb_typeof(source_objective_ids) = 'array' AND jsonb_array_length(source_objective_ids) BETWEEN 1 AND 20),
  relation text CHECK (relation IS NULL OR relation IN ('equivalent','prerequisite_of','overlaps')),
  mapping_id uuid NOT NULL REFERENCES concept_mappings(id),
  mapping_revision integer NOT NULL CHECK (mapping_revision > 0),
  consent_revision integer NOT NULL CHECK (consent_revision > 0),
  dedupe_key text NOT NULL CHECK (dedupe_key ~ '^[a-f0-9]{64}$'),
  verification jsonb NOT NULL CHECK (jsonb_typeof(verification) = 'object' AND octet_length(verification::text) <= 4096),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','confirmed','dismissed')),
  decided_at timestamptz,
  decision_event_id uuid REFERENCES learning_events(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (enrollment_id, workspace_id) REFERENCES enrollments(id, workspace_id),
  CHECK ((state = 'pending') = (decided_at IS NULL)),
  CHECK (enrollment_id <> source_enrollment_id),
  CHECK ((kind = 'pacing') = (objective_id IS NULL)),
  -- A suggestion is proposed at most once per pair, even after the learner dismissed it.
  UNIQUE (consent_id, dedupe_key)
);
CREATE INDEX cross_course_suggestions_enrollment ON cross_course_suggestions (enrollment_id, state, created_at DESC);
CREATE INDEX cross_course_suggestions_source ON cross_course_suggestions (source_enrollment_id);
CREATE INDEX cross_course_suggestions_daily ON cross_course_suggestions (consent_id, created_at);

-- Wake-ups of a learner's coordinator, delivered by the supervisor dispatcher as Temporal signals.
-- At most one unclaimed wake-up per learner: later changes coalesce into it. The dispatcher reads
-- whether an opt-in is in force when it claims the row, so the row itself holds no decision.
CREATE TABLE cross_course_wakeups (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES app_users(id),
  reason text NOT NULL CHECK (reason IN ('consent_granted','consent_revoked','evidence_changed','enrollment_activity','erased')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_token uuid,
  claimed_until timestamptz,
  delivered_at timestamptz,
  abandoned_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX cross_course_wakeups_one_open ON cross_course_wakeups (user_id)
  WHERE delivered_at IS NULL AND abandoned_at IS NULL AND lease_token IS NULL;
CREATE INDEX cross_course_wakeups_due ON cross_course_wakeups (created_at) WHERE delivered_at IS NULL AND abandoned_at IS NULL;

-- New, invalidated or re-controlled evidence in an enrollment covered by an opt-in wakes the
-- learner's coordinator. Only the learner's identifier is queued; the host reads the rest later.
CREATE FUNCTION cross_course_note_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO cross_course_wakeups (id, user_id, reason)
    SELECT gen_random_uuid(), c.user_id, 'evidence_changed' FROM cross_course_consents c
     WHERE c.state = 'granted' AND (c.a_enrollment_id = NEW.enrollment_id OR c.b_enrollment_id = NEW.enrollment_id)
     LIMIT 1
  ON CONFLICT (user_id) WHERE delivered_at IS NULL AND abandoned_at IS NULL AND lease_token IS NULL DO NOTHING;
  RETURN NULL;
END $$;
CREATE TRIGGER cross_course_evidence_inserted AFTER INSERT ON evidence
  FOR EACH ROW EXECUTE FUNCTION cross_course_note_evidence();
CREATE TRIGGER cross_course_evidence_invalidated AFTER UPDATE OF invalidated_at ON evidence
  FOR EACH ROW WHEN (OLD.invalidated_at IS DISTINCT FROM NEW.invalidated_at) EXECUTE FUNCTION cross_course_note_evidence();
CREATE TRIGGER cross_course_evidence_controlled AFTER INSERT OR UPDATE OF ended_at ON learner_evidence_controls
  FOR EACH ROW EXECUTE FUNCTION cross_course_note_evidence();
