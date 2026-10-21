-- Results of the self-host backup tools (deploy/local/backup.mjs): online snapshots, stopped
-- backups and restore drills. The tool writes one row per run with the migration (owner)
-- connection; the admin platform-readiness page reads them to show backup status and to monitor
-- the recovery targets. Rows hold timings, sizes, counts and stable codes only: never a host path,
-- file name, credential or row content.
CREATE TABLE platform_backup_reports (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('snapshot', 'backup', 'restore_drill')),
  outcome text NOT NULL CHECK (outcome IN ('succeeded', 'failed')),
  code text CHECK (code ~ '^[a-z0-9_]{1,64}$'),
  started_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL,
  encrypted boolean NOT NULL DEFAULT false,
  core_version text CHECK (core_version ~ '^[0-9A-Za-z.+-]{1,40}$'),
  tables integer CHECK (tables >= 0),
  rows bigint CHECK (rows >= 0),
  bytes bigint CHECK (bytes >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (finished_at >= started_at),
  CHECK ((outcome = 'failed') = (code IS NOT NULL))
);
CREATE INDEX platform_backup_reports_recent ON platform_backup_reports (kind, outcome, finished_at DESC);
