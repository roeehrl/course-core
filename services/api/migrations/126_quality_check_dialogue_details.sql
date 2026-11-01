-- What each practice conversation of a finished quality check said, for the owners and
-- administrators who can see the check (provider-quality-checks.ts, agent-evals/details.ts):
-- what the conversation tests, what the model was given, its answer (at most about 4 KB) and each
-- rule's result with its evidence. The conversations are Core's public practice fixtures, not
-- learner data; their private test strings are removed before storing. No prompt or key.
-- Additive: checks finished before this migration have no rows and say the details were not recorded.
CREATE TABLE provider_quality_check_dialogues (
  check_id uuid NOT NULL REFERENCES provider_quality_checks(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  position integer NOT NULL CHECK (position BETWEEN 0 AND 199),
  role text NOT NULL CHECK (role ~ '^[a-z][a-z0-9_]{1,39}$'),
  dialogue_id text NOT NULL CHECK (length(dialogue_id) BETWEEN 1 AND 120),
  passed boolean NOT NULL,
  detail jsonb NOT NULL CHECK (jsonb_typeof(detail) = 'object' AND length(detail::text) <= 65536),
  PRIMARY KEY (check_id, position)
);
CREATE INDEX provider_quality_check_dialogues_workspace ON provider_quality_check_dialogues (workspace_id, check_id);
