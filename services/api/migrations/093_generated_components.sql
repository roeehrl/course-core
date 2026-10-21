-- Generated interactive components (requirement E05). A component the supervisor writes is a small
-- Python model: built and tested in the isolated grader (the networkless, read-only Docker sandbox)
-- before delivery, then published here once, content-addressed and immutable, beside the text block
-- that is its accessible alternative. The learner's browser runs it only in Core's sandboxed runner
-- frame (opaque origin, no network); it never runs in the API process or the learner page's origin.
-- A component teaches; it is never evidence.
CREATE TABLE generated_components (
  enrollment_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  proposal_id uuid NOT NULL,
  episode_id text NOT NULL CHECK (char_length(episode_id) BETWEEN 1 AND 128),
  -- The text block (the component's accessible alternative) it is shown with.
  block_id text NOT NULL CHECK (char_length(block_id) BETWEEN 1 AND 200),
  -- SHA-256 of the component (source, controls, outputs and tests), and of the text block's artifact.
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  artifact_digest text NOT NULL CHECK (artifact_digest ~ '^[a-f0-9]{64}$'),
  -- Redacted to '{}' on erasure.
  body jsonb NOT NULL CHECK (jsonb_typeof(body) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (enrollment_id, block_id),
  FOREIGN KEY (proposal_id, enrollment_id) REFERENCES adaptation_proposals(id, enrollment_id),
  FOREIGN KEY (enrollment_id, workspace_id) REFERENCES enrollments(id, workspace_id)
);
CREATE INDEX generated_components_proposal ON generated_components(enrollment_id, proposal_id);
-- Published bytes never change; only an erasure of the same enrollment may redact them.
CREATE TRIGGER generated_components_immutable BEFORE UPDATE OR DELETE ON generated_components
  FOR EACH ROW EXECUTE FUNCTION adaptation_immutable();
