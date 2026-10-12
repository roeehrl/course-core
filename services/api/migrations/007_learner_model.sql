-- Learner statements and reviewed suggestions are not assessment evidence.
CREATE TABLE learner_model_profiles (
  enrollment_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  profile jsonb NOT NULL DEFAULT '{"preferences":{},"priorKnowledge":[],"thoughts":""}',
  FOREIGN KEY (enrollment_id,workspace_id) REFERENCES enrollments(id,workspace_id),
  CHECK (jsonb_typeof(profile)='object' AND octet_length(profile::text)<=65536)
);

CREATE TABLE learner_model_proposals (
  id uuid PRIMARY KEY,
  enrollment_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  actor_id uuid NOT NULL REFERENCES app_users(id),
  service_id text NOT NULL CHECK (length(service_id) BETWEEN 1 AND 100),
  course_digest text NOT NULL CHECK (course_digest ~ '^[a-f0-9]{64}$'),
  suggestion jsonb NOT NULL CHECK (jsonb_typeof(suggestion)='object' AND octet_length(suggestion::text)<=2048),
  event_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id,enrollment_id,workspace_id),
  FOREIGN KEY (enrollment_id,workspace_id) REFERENCES enrollments(id,workspace_id),
  FOREIGN KEY (event_id,enrollment_id,workspace_id) REFERENCES learning_events(id,enrollment_id,workspace_id)
);
CREATE INDEX learner_model_proposals_scope ON learner_model_proposals(enrollment_id,workspace_id,created_at DESC,id DESC);

CREATE TABLE learner_model_sources (
  proposal_id uuid NOT NULL,
  enrollment_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  event_id uuid NOT NULL,
  event_sequence bigint NOT NULL,
  event_type text NOT NULL,
  event_digest text NOT NULL CHECK (event_digest ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY (proposal_id,event_id),
  FOREIGN KEY (proposal_id,enrollment_id,workspace_id) REFERENCES learner_model_proposals(id,enrollment_id,workspace_id),
  FOREIGN KEY (event_id,enrollment_id,workspace_id) REFERENCES learning_events(id,enrollment_id,workspace_id)
);

CREATE TABLE learner_model_changes (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id uuid NOT NULL UNIQUE,
  enrollment_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  model_revision integer NOT NULL CHECK (model_revision>0),
  enrollment_revision integer NOT NULL CHECK (enrollment_revision>0),
  actor_id uuid NOT NULL REFERENCES app_users(id),
  actor_kind text NOT NULL CHECK (actor_kind IN ('learner','agent')),
  action text NOT NULL CHECK (action IN ('profile.edited','proposal.created','proposal.accepted','proposal.corrected','proposal.disputed')),
  proposal_id uuid,
  event_id uuid NOT NULL,
  data jsonb NOT NULL CHECK (jsonb_typeof(data)='object' AND octet_length(data::text)<=65536),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (enrollment_id,model_revision),
  FOREIGN KEY (enrollment_id,workspace_id) REFERENCES enrollments(id,workspace_id),
  FOREIGN KEY (proposal_id,enrollment_id,workspace_id) REFERENCES learner_model_proposals(id,enrollment_id,workspace_id),
  FOREIGN KEY (event_id,enrollment_id,workspace_id) REFERENCES learning_events(id,enrollment_id,workspace_id),
  CHECK ((action='profile.edited' AND proposal_id IS NULL AND actor_kind='learner') OR
    (action='proposal.created' AND proposal_id IS NOT NULL AND actor_kind='agent') OR
    (action IN ('proposal.accepted','proposal.corrected','proposal.disputed') AND proposal_id IS NOT NULL AND actor_kind='learner'))
);
CREATE INDEX learner_model_changes_scope ON learner_model_changes(enrollment_id,workspace_id,sequence DESC);
CREATE INDEX learner_model_decisions ON learner_model_changes(proposal_id,sequence DESC) WHERE action<>'proposal.created';
CREATE INDEX learner_model_active_evidence ON evidence(enrollment_id,objective_id,attempt_id)
  WHERE independent AND invalidated_at IS NULL;
CREATE INDEX learner_model_history_cursor ON learning_events(enrollment_id,workspace_id,sequence DESC)
  WHERE event_type IN ('companion.requested','assessment.submitted');

CREATE FUNCTION learner_model_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'LEARNER_MODEL_HISTORY_IMMUTABLE' USING ERRCODE='23514';
END $$;
CREATE TRIGGER learner_model_proposals_immutable BEFORE UPDATE OR DELETE ON learner_model_proposals
  FOR EACH ROW EXECUTE FUNCTION learner_model_immutable();
CREATE TRIGGER learner_model_sources_immutable BEFORE UPDATE OR DELETE ON learner_model_sources
  FOR EACH ROW EXECUTE FUNCTION learner_model_immutable();
CREATE TRIGGER learner_model_changes_immutable BEFORE UPDATE OR DELETE ON learner_model_changes
  FOR EACH ROW EXECUTE FUNCTION learner_model_immutable();
