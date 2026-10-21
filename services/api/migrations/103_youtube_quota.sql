-- YouTube Data API quota (O05). Every call costs quota units, even a refused one, and the project's
-- allocation resets at midnight Pacific time; search.list is also limited to a number of calls a day.
-- Course Core reserves the units of each call here before sending it, so a workspace stops locally
-- before Google refuses it, and records a day Google reported as used up.
CREATE TABLE youtube_quota_settings(
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id),
  daily_units integer NOT NULL CHECK(daily_units BETWEEN 1 AND 100000000),
  daily_searches integer NOT NULL CHECK(daily_searches BETWEEN 1 AND 1000000),
  updated_by uuid NOT NULL REFERENCES app_users(id),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE youtube_quota_usage(
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  -- The quota day: the calendar date in America/Los_Angeles.
  quota_day date NOT NULL,
  units integer NOT NULL DEFAULT 0 CHECK(units >= 0),
  searches integer NOT NULL DEFAULT 0 CHECK(searches >= 0),
  -- Google answered quotaExceeded: nothing more is sent until the day ends.
  exhausted_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id, quota_day)
);
