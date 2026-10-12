CREATE TABLE app_users (
  id uuid PRIMARY KEY,
  subject text NOT NULL UNIQUE CHECK (length(subject) BETWEEN 1 AND 300),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workspaces (
  id uuid PRIMARY KEY,
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z][a-z0-9-]{0,99}$'),
  title text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  user_id uuid NOT NULL REFERENCES app_users(id),
  role text NOT NULL CHECK (role IN ('owner','admin','author','instructor','reviewer','learner','observer')),
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE auth_sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES app_users(id),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  csrf_hash text NOT NULL CHECK (csrf_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE course_releases (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  course_key text NOT NULL,
  version text NOT NULL,
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  server_bundle jsonb NOT NULL,
  learner_bundle jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('draft','published','archived')),
  visibility text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','public')),
  created_by uuid NOT NULL REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, course_key, version),
  UNIQUE (id, workspace_id)
);

CREATE TABLE enrollments (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  course_release_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES app_users(id),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','closed','completed')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  profile jsonb NOT NULL DEFAULT '{}',
  profile_revision integer NOT NULL DEFAULT 1 CHECK (profile_revision > 0),
  policy jsonb NOT NULL,
  policy_revision integer NOT NULL DEFAULT 1 CHECK (policy_revision > 0),
  current_episode_id text,
  started_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  FOREIGN KEY (course_release_id, workspace_id) REFERENCES course_releases(id, workspace_id),
  UNIQUE (course_release_id, user_id),
  UNIQUE (id, workspace_id)
);

CREATE TABLE learning_events (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id uuid NOT NULL UNIQUE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  enrollment_id uuid,
  actor_id uuid REFERENCES app_users(id),
  actor_kind text NOT NULL CHECK (actor_kind IN ('learner','staff','agent','system')),
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  correlation_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (enrollment_id, workspace_id) REFERENCES enrollments(id, workspace_id),
  UNIQUE (workspace_id, idempotency_key)
);
CREATE INDEX learning_events_enrollment_cursor ON learning_events (enrollment_id, sequence);

CREATE TABLE attempts (
  id uuid PRIMARY KEY,
  enrollment_id uuid NOT NULL REFERENCES enrollments(id),
  assessment_id text NOT NULL,
  course_digest text NOT NULL,
  family_id text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('practice','independent','placement')),
  assistance text NOT NULL CHECK (assistance IN ('none','hint','solution','unknown')),
  response jsonb NOT NULL,
  result jsonb NOT NULL,
  idempotency_key text NOT NULL,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (enrollment_id, idempotency_key),
  UNIQUE (id, enrollment_id)
);

CREATE TABLE evidence (
  id uuid PRIMARY KEY,
  enrollment_id uuid NOT NULL REFERENCES enrollments(id),
  attempt_id uuid NOT NULL,
  objective_id text NOT NULL,
  evaluator_ref text NOT NULL,
  result jsonb NOT NULL,
  independent boolean NOT NULL,
  invalidated_at timestamptz,
  invalidation_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (attempt_id, enrollment_id) REFERENCES attempts(id, enrollment_id),
  UNIQUE (attempt_id, objective_id, evaluator_ref)
);

CREATE TABLE outbox (
  event_id uuid PRIMARY KEY REFERENCES learning_events(id),
  kind text NOT NULL,
  payload jsonb NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  claimed_until timestamptz,
  delivered_at timestamptz,
  last_error_code text
);

CREATE TABLE supervisor_jobs (
  id uuid PRIMARY KEY,
  enrollment_id uuid NOT NULL REFERENCES enrollments(id),
  workflow_id text NOT NULL,
  role text NOT NULL,
  state text NOT NULL CHECK (state IN ('queued','running','waiting','verifying','ready','applied','failed','cancelled','budget_wait')),
  input_event_id uuid REFERENCES learning_events(id),
  expected_revision integer NOT NULL,
  specification jsonb NOT NULL,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
