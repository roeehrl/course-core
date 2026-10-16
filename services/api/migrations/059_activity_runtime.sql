-- Activity runtime (SDK 0.5 activities). An instance holds one learner's state for one activity
-- block on one course version. Observations are what the activity reported through the
-- capability broker; they are never evidence. Activity evidence exists only as the result of a
-- registered evaluator applied to an observation.
CREATE TABLE activity_instances(
  id uuid PRIMARY KEY,
  enrollment_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  course_digest text NOT NULL,
  episode_id text NOT NULL,
  block_id text NOT NULL,
  activity_id text NOT NULL,
  activity_version text NOT NULL,
  target text NOT NULL CHECK (target IN ('web_desktop','web_mobile','ios_phone','ipados_tablet','android_phone','android_tablet')),
  renderer_id text NOT NULL,
  execution text NOT NULL CHECK (execution IN ('declarative','sandboxed_web')),
  state_version integer NOT NULL CHECK (state_version >= 1),
  state jsonb NOT NULL CHECK (jsonb_typeof(state) = 'object'),
  state_revision integer NOT NULL DEFAULT 1 CHECK (state_revision >= 1),
  -- When the block's completion requirement was met (an evaluator pass, or an accepted
  -- observation for an activity without an evaluator). Never a grade.
  satisfied_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (enrollment_id, course_digest, episode_id, block_id),
  UNIQUE (id, enrollment_id),
  FOREIGN KEY (enrollment_id, workspace_id) REFERENCES enrollments(id, workspace_id)
);

CREATE TABLE activity_observations(
  id uuid PRIMARY KEY,
  instance_id uuid NOT NULL,
  enrollment_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9:_-]{8,200}$'),
  request_digest text NOT NULL,
  observation jsonb NOT NULL,
  byte_length integer NOT NULL CHECK (byte_length BETWEEN 1 AND 16384),
  -- not_evaluated (no evaluator declared), passed, not_passed or unavailable (the evaluator failed).
  evaluation jsonb NOT NULL CHECK (evaluation ? 'status'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (instance_id, idempotency_key),
  UNIQUE (id, enrollment_id),
  FOREIGN KEY (instance_id, enrollment_id) REFERENCES activity_instances(id, enrollment_id)
);
CREATE INDEX activity_observations_recent ON activity_observations(instance_id, created_at);

CREATE TABLE activity_evidence(
  id uuid PRIMARY KEY,
  enrollment_id uuid NOT NULL,
  instance_id uuid NOT NULL,
  observation_id uuid NOT NULL,
  objective_id text NOT NULL,
  -- The registered evaluator (definition or extension id @ installed version) that produced it.
  evaluator_ref text NOT NULL,
  result jsonb NOT NULL,
  invalidated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (observation_id, objective_id),
  FOREIGN KEY (observation_id, enrollment_id) REFERENCES activity_observations(id, enrollment_id),
  FOREIGN KEY (instance_id, enrollment_id) REFERENCES activity_instances(id, enrollment_id)
);
CREATE INDEX activity_evidence_enrollment ON activity_evidence(enrollment_id, instance_id);
