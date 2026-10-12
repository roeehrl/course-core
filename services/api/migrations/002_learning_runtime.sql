CREATE TABLE login_codes (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES app_users(id),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);

CREATE TABLE command_receipts (
  enrollment_id uuid NOT NULL REFERENCES enrollments(id),
  idempotency_key text NOT NULL,
  request_digest text NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (enrollment_id, idempotency_key)
);

CREATE TABLE assessment_challenges (
  id uuid PRIMARY KEY,
  enrollment_id uuid NOT NULL REFERENCES enrollments(id),
  episode_id text NOT NULL,
  assessment_id text NOT NULL,
  course_digest text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('practice','independent','placement')),
  assistance text NOT NULL DEFAULT 'none' CHECK (assistance IN ('none','hint','solution')),
  independent_eligible boolean NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  attempt_id uuid UNIQUE REFERENCES attempts(id),
  UNIQUE (id, enrollment_id)
);
CREATE INDEX assessment_challenges_exposure ON assessment_challenges (enrollment_id, assessment_id);

CREATE TABLE episode_progress (
  enrollment_id uuid NOT NULL REFERENCES enrollments(id),
  episode_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('started','completed','placed')),
  completed_block_ids jsonb NOT NULL DEFAULT '[]',
  evidence_refs jsonb NOT NULL DEFAULT '[]',
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (enrollment_id, episode_id)
);

CREATE TABLE policy_states (
  enrollment_id uuid PRIMARY KEY REFERENCES enrollments(id),
  policy_revision integer NOT NULL,
  ledger_revision integer NOT NULL,
  snapshot jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE companion_messages (
  id uuid PRIMARY KEY,
  enrollment_id uuid NOT NULL REFERENCES enrollments(id),
  role text NOT NULL CHECK (role IN ('learner','assistant')),
  content text NOT NULL,
  context jsonb NOT NULL,
  job_id uuid REFERENCES supervisor_jobs(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
