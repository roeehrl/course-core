-- One optional placement run per enrollment. Declining is recorded, never
-- penalised. Exemptions are applied only when the learner accepts a start point.
CREATE TABLE placement_runs(
  id uuid PRIMARY KEY,enrollment_id uuid NOT NULL UNIQUE REFERENCES enrollments(id),
  state text NOT NULL CHECK(state IN('declined','in_progress','finished','accepted')),
  started_at timestamptz,finished_at timestamptz,accepted_at timestamptz,
  stop_reason text CHECK(stop_reason IS NULL OR stop_reason~'^[a-z_]{1,40}$'),
  proposal jsonb,start_episode_id text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
