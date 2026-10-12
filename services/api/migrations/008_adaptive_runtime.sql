-- Author approvals and verifier attestations are server records, never browser claims.
CREATE TABLE adaptation_registry_versions (
  course_release_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  base_digest text NOT NULL CHECK (base_digest ~ '^[a-f0-9]{64}$'),
  configuration jsonb NOT NULL CHECK (jsonb_typeof(configuration)='object' AND octet_length(configuration::text)<=1048576),
  configuration_digest text NOT NULL CHECK (configuration_digest ~ '^[a-f0-9]{64}$'),
  approved_by uuid NOT NULL REFERENCES app_users(id),
  approved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (course_release_id,revision),
  UNIQUE (course_release_id,workspace_id,revision),
  FOREIGN KEY (course_release_id,workspace_id) REFERENCES course_releases(id,workspace_id)
);
CREATE TABLE adaptation_registries (
  course_release_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  revision integer NOT NULL,
  status text NOT NULL CHECK (status IN ('active','revoked')),
  FOREIGN KEY (course_release_id,workspace_id,revision) REFERENCES adaptation_registry_versions(course_release_id,workspace_id,revision)
);
CREATE TABLE adaptation_states (
  enrollment_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  base_digest text NOT NULL CHECK (base_digest ~ '^[a-f0-9]{64}$'),
  ledger_revision integer NOT NULL CHECK (ledger_revision >= 0),
  plan_revision integer NOT NULL CHECK (plan_revision >= 0),
  plan_digest text NOT NULL CHECK (plan_digest ~ '^[a-f0-9]{64}$'),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot)='object'),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (enrollment_id,workspace_id) REFERENCES enrollments(id,workspace_id)
);
CREATE TABLE adaptation_proposals (
  id uuid PRIMARY KEY,
  enrollment_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  course_release_id uuid NOT NULL,
  registry_revision integer NOT NULL,
  proposal_key text NOT NULL,
  base_digest text NOT NULL CHECK (base_digest ~ '^[a-f0-9]{64}$'),
  proposal_digest text NOT NULL CHECK (proposal_digest ~ '^[a-f0-9]{64}$'),
  expected_plan_revision integer NOT NULL CHECK (expected_plan_revision >= 0),
  verified_policy_revision integer NOT NULL CHECK (verified_policy_revision > 0),
  body jsonb NOT NULL CHECK (jsonb_typeof(body)='object' AND octet_length(body::text)<=2097152),
  assignments jsonb NOT NULL CHECK (jsonb_typeof(assignments)='array'),
  evidence_fence jsonb NOT NULL,
  authority_ref text NOT NULL,
  status text NOT NULL DEFAULT 'verified' CHECK (status IN ('verified','applied')),
  created_by uuid NOT NULL REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  applied_revision integer,
  CHECK ((status='applied') = (applied_revision IS NOT NULL)),
  UNIQUE (enrollment_id,proposal_key),
  UNIQUE (id,enrollment_id),
  FOREIGN KEY (enrollment_id,workspace_id) REFERENCES enrollments(id,workspace_id),
  FOREIGN KEY (course_release_id,workspace_id,registry_revision) REFERENCES adaptation_registry_versions(course_release_id,workspace_id,revision)
);
CREATE TABLE adaptation_artifacts (
  enrollment_id uuid NOT NULL REFERENCES enrollments(id),
  artifact_id text NOT NULL,
  proposal_id uuid NOT NULL,
  artifact_digest text NOT NULL CHECK (artifact_digest ~ '^[a-f0-9]{64}$'),
  body jsonb NOT NULL CHECK (jsonb_typeof(body)='object'),
  PRIMARY KEY (enrollment_id,artifact_id),
  UNIQUE (enrollment_id,artifact_digest),
  FOREIGN KEY (proposal_id,enrollment_id) REFERENCES adaptation_proposals(id,enrollment_id)
);
CREATE TABLE adaptation_proofs (
  enrollment_id uuid NOT NULL REFERENCES enrollments(id),
  receipt_ref text NOT NULL,
  proposal_id uuid NOT NULL,
  artifact_id text NOT NULL,
  registry_revision integer NOT NULL,
  adapter_id text NOT NULL,
  adapter_digest text NOT NULL CHECK (adapter_digest ~ '^[a-f0-9]{64}$'),
  trusted_record jsonb NOT NULL CHECK (jsonb_typeof(trusted_record)='object'),
  verification_evidence jsonb NOT NULL CHECK (jsonb_typeof(verification_evidence)='array'),
  PRIMARY KEY (enrollment_id,receipt_ref),
  FOREIGN KEY (proposal_id,enrollment_id) REFERENCES adaptation_proposals(id,enrollment_id),
  FOREIGN KEY (enrollment_id,artifact_id) REFERENCES adaptation_artifacts(enrollment_id,artifact_id)
);
CREATE TABLE adaptation_authorizations (
  enrollment_id uuid NOT NULL REFERENCES enrollments(id),
  receipt_ref text NOT NULL,
  proposal_id uuid NOT NULL,
  trusted_record jsonb NOT NULL CHECK (jsonb_typeof(trusted_record)='object'),
  PRIMARY KEY (enrollment_id,receipt_ref),
  FOREIGN KEY (proposal_id,enrollment_id) REFERENCES adaptation_proposals(id,enrollment_id)
);
CREATE TABLE adaptation_applications (
  enrollment_id uuid NOT NULL REFERENCES enrollments(id),
  proposal_id uuid NOT NULL,
  plan_revision integer NOT NULL CHECK (plan_revision > 0),
  plan_digest text NOT NULL CHECK (plan_digest ~ '^[a-f0-9]{64}$'),
  policy_ledger_revision integer NOT NULL,
  event_id uuid NOT NULL REFERENCES learning_events(id),
  commit_before timestamptz NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (enrollment_id,proposal_id),
  UNIQUE (enrollment_id,plan_revision),
  FOREIGN KEY (proposal_id,enrollment_id) REFERENCES adaptation_proposals(id,enrollment_id)
);
ALTER TABLE assessment_challenges ADD COLUMN adaptation_artifact_digest text;
ALTER TABLE assessment_challenges ADD COLUMN adaptation_plan_revision integer;
ALTER TABLE assessment_challenges ADD COLUMN canonical_assessment_id text;
ALTER TABLE assessment_challenges ADD CONSTRAINT adaptation_challenge_binding
  CHECK ((adaptation_artifact_digest IS NULL AND adaptation_plan_revision IS NULL AND canonical_assessment_id IS NULL)
    OR (adaptation_artifact_digest IS NOT NULL AND adaptation_plan_revision > 0 AND canonical_assessment_id IS NOT NULL));
ALTER TABLE assessment_challenges ADD FOREIGN KEY (enrollment_id,adaptation_artifact_digest)
  REFERENCES adaptation_artifacts(enrollment_id,artifact_digest);

CREATE FUNCTION adaptation_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'immutable adaptation provenance' USING ERRCODE='23514';
END $$;
CREATE TRIGGER adaptation_registry_versions_immutable BEFORE UPDATE OR DELETE ON adaptation_registry_versions FOR EACH ROW EXECUTE FUNCTION adaptation_immutable();
CREATE TRIGGER adaptation_artifacts_immutable BEFORE UPDATE OR DELETE ON adaptation_artifacts FOR EACH ROW EXECUTE FUNCTION adaptation_immutable();
CREATE TRIGGER adaptation_proofs_immutable BEFORE UPDATE OR DELETE ON adaptation_proofs FOR EACH ROW EXECUTE FUNCTION adaptation_immutable();
CREATE TRIGGER adaptation_authorizations_immutable BEFORE UPDATE OR DELETE ON adaptation_authorizations FOR EACH ROW EXECUTE FUNCTION adaptation_immutable();
CREATE TRIGGER adaptation_applications_immutable BEFORE UPDATE OR DELETE ON adaptation_applications FOR EACH ROW EXECUTE FUNCTION adaptation_immutable();
CREATE FUNCTION adaptation_proposal_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'retain adaptation proposal' USING ERRCODE='23514'; END IF;
  IF OLD.status<>'verified' OR NEW.status<>'applied' OR NEW.applied_revision IS NULL
    OR (to_jsonb(NEW)-'status'-'applied_revision') IS DISTINCT FROM (to_jsonb(OLD)-'status'-'applied_revision')
  THEN RAISE EXCEPTION 'invalid adaptation proposal transition' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER adaptation_proposals_immutable BEFORE UPDATE OR DELETE ON adaptation_proposals FOR EACH ROW EXECUTE FUNCTION adaptation_proposal_transition();
-- now() is transaction-start time. Recheck the actual clock in the deferred COMMIT
-- phase so a late trigger/lock wait after application cannot publish past the cap.
CREATE FUNCTION adaptation_commit_deadline() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF clock_timestamp() >= NEW.commit_before THEN
    RAISE EXCEPTION 'ADAPTATION_COMMIT_DEADLINE' USING ERRCODE='23514',CONSTRAINT='adaptation_commit_deadline';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER adaptation_commit_deadline AFTER INSERT ON adaptation_applications
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION adaptation_commit_deadline();
