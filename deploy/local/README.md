# Private local pilot

This service-management revision is under qualification. Do not replace an
already running legacy pilot using this controller: legacy owner records fail
closed. Coordinate graceful shutdown with the known launcher, preserve its
Temporal task queue and saved application state, and qualify restart before
installing a persistent service. Native launchd lifecycle tests and migration
acceptance are still required for this revision.

This launcher runs the API, learner/admin static exports, a durable local Temporal
development server and two bounded worker processes on loopback. It is a local
pilot deployment, not a production HA configuration. PostgreSQL must already be
available in a dedicated application database. Native mobile binaries are not used.

Build and verify the repository first. Install a checksum-verified Temporal CLI
in `.local/bin/temporal`. Create `.local/pilot/config.json` with owner-only access:

```json
{
  "schemaVersion": 1,
  "publicOrigin": "http://127.0.0.1:4310",
  "databaseUrl": "postgresql:///course_core_dev?host=/tmp",
  "temporalPort": 7239,
  "temporalUiPort": 8239,
  "temporalTaskQueue": "course-core-pilot",
  "serviceToken": "",
  "workspaceIds": [],
  "codeFixtureFiles": []
}
```

Use the API bootstrap CLI against that database to create the owner/workspace and
set the owner's password. Add that workspace ID before enabling its supervisor.
`providerConfigFile` and `providerCredentials` are optional protected local
configuration; never commit them or place keys in the learner export. Provider
capability configuration and an API key are not live acceptance. Shared generation
budgets default to zero and require an authorized administrator configuration.

```sh
node deploy/local/pilot.mjs start
node deploy/local/pilot.mjs status
node deploy/local/pilot.mjs stop
```

## Sign-in settings and passwords

People sign in with a username and password (see the root README, "Sign-in and
sessions"). Two optional `config.json` keys are passed only to the API:

| Key | Effect | Default |
| --- | --- | --- |
| `sessionHours` | Session lifetime in hours (a JSON number; fractions allowed, more than 0 and at most 720 = 30 days). Becomes `SESSION_HOURS`. | `12` |
| `loginCodes` | `true` accepts and issues one-time sign-in codes (`AUTH_LOGIN_CODES=enabled`); `false` or absent keeps them off. | `false` |

Any other type or an out-of-range value makes `start` fail with
`invalid_session_lifetime` or `invalid_login_codes`. Restart the pilot after
changing them (`stop`, then `start`); sessions already issued keep their expiry.

Set or reset a password on the pilot host after the upgraded API has started once
(it applies migration 028 and re-grants the runtime role). Run it from the
installed runtime root with the pilot's `databaseUrl`; it prompts twice without
echo, or reads one line from standard input, and never accepts the password as
an argument or environment variable:

```sh
cd "$ROOT"
DATABASE_URL='<databaseUrl from config.json>' node services/api/dist/set-password-cli.js <workspace-slug> <subject> [--login <username>] [--temporary]
```

The username defaults to the account's existing username, else its subject
(lower-cased). Setting a password signs that account out everywhere. Members
invited from **People & roles** get server-generated temporary passwords from an
owner or admin instead. Failed sign-ins are throttled in PostgreSQL: 10 per
username and 100 per client address per 15 minutes. All pilot traffic arrives
from loopback, so a reverse proxy or tunnel in front of the pilot shares one
address budget.

Only one launcher owns the state directory. Its owner-only control socket stops
only its own child processes, in order. A failed service stops the group rather
than leaving a half-working pilot. An external service manager may restart the
launcher with backoff; PostgreSQL and Temporal state survive. Status means local
processes were launched and the API answered; it is not a claim of live model
quality, worker progress, provider cost verification or production readiness.

Private course bundles and fixture registries are imported through authenticated
API/host interfaces. They are never added to public web assets or this repository.

`temporalTaskQueue` must retain the queue used by existing persisted workflows.
An existing Temporal database without that explicit setting is rejected. Fresh
installations may omit it; the derived name is stable across restarts. Inspect
existing workflow metadata during a coordinated migration, rather than change a
queue merely because a process is restarted or a release moves directories.

Runtime defaults use two worker activities, a two-second dispatch interval, V8
heap caps of 512 MiB for API, 384 MiB for worker and 128 MiB for dispatcher, plus
a 384 MiB Go memory target and two Go scheduler threads for Temporal. These are
heap/runtime targets, not aggregate RSS limits. Native allocations and PostgreSQL
are additional; measure the actual pilot after migration. Optional `resources`
settings are bounded. Logs retain fixed operational metadata, discard raw child
output, and rotate at 1 MiB with three backups by default.

`node --test deploy/local/runtime.test.mjs` checks private file/socket ownership,
authenticated control, explicit queue migration, constrained environment/resource
settings and simulated launchd registration. Its real child-process start/stop/
restart case uses isolated service fixtures, not the user's running pilot or
a live provider. Actual native service and saved-course restart acceptance remain
separate deployment gates.

`adaptationAdapters` explicitly selects known host implementations. Allowed IDs
are `bounded-numeric-v1`, `authored-bank-v1` and `authored-code-bank-v1`; the
default is empty. Selection installs no release authorization. An owner/admin
must approve an exact digest-bound recovery registry for each immutable release.
Code recovery additionally requires an installed, ready evaluator matching the
course's version, integrity, web platform and assessment capability. Every reviewed
variant must refer to an existing fixture in that evaluator; recovery banks cannot
install code or hidden fixtures. The configuration is sent only to the API.

Exhausted reviewed banks and canonical-family limits remove that recovery offer.
An explicit request is also rejected transactionally before a new cost, plan or
challenge is committed. Numeric-domain exhaustion remains an authoritative bounded
generator result, not a promise that infinitely many fresh questions exist.

## Backups and restore drills

Stop the pilot first (`node deploy/local/pilot.mjs stop`) so PostgreSQL and the
Temporal store are captured at the same quiescent point; `create` refuses while
an owner record exists.

```sh
node deploy/local/backup.mjs create --root "$ROOT" --state "$STATE" --output "$BACKUPS" [--pg-bin /path/to/postgresql/bin]
node deploy/local/backup.mjs verify --root "$ROOT" --state "$STATE" --backup "$BACKUPS/backup-…"
```

A backup directory (owner-only, 0700/0600) holds a `pg_dump` custom-format
database dump, `config.json`, `temporal.db`, the installation record if present,
and the provider vault. **It therefore contains learner records, service tokens
and the key for sealed provider credentials.** Keep it on encrypted, private
storage (for example a FileVault-protected disk); never copy it into a
repository or share it. `manifest.json` records every file's size and SHA-256,
the Core version, PostgreSQL server version, applied migrations and per-table
row counts.

`verify` is a restore drill: it re-hashes every file (extra, missing, changed or
group/world-readable files fail), restores the dump into a NEW randomly named
database on the same server, compares row counts and migrations, checks the
Temporal store with `sqlite3 PRAGMA integrity_check`, and drops the disposable
database. It never touches the live database. Restoring over a live installation
is a deliberate operator procedure: stop the pilot, restore into a new database,
point `databaseUrl` at it, restore `temporal.db` and the vault, then start.
Erasure performed after a backup is not applied to that backup; retain backups
only as long as your documented retention period requires.

```sh
node deploy/local/backup.mjs prune --output "$BACKUPS" --keep 7
```

`prune` keeps the newest N backups whose manifests still verify and deletes
older intact ones. Changed, unreadable, linked or unrecognised entries are left
in place and listed under `skipped` for an operator to inspect; at least one
backup is always kept. Run it after a successful `create` and `verify`.

## Least-privilege database role

Set `migrationDatabaseUrl` to an owner connection for the same database and make
`databaseUrl` name a separate login role without superuser, CREATEDB or
CREATEROLE. On start the API migrates and grants that role SELECT/INSERT/
UPDATE/DELETE on application tables (no TRUNCATE, schema CREATE or ownership),
re-granting after every migration, then refuses to serve if its own role could
change the schema. Only the API receives the owner URL. Backups and restore
drills use the owner connection when it is configured.

## Upgrading a pinned runtime

Install the new verified release into its own root (with its checksum-verified
Temporal CLI), then:

```sh
node "$NEW_ROOT/deploy/local/upgrade.mjs" --from "$OLD_ROOT" --to "$NEW_ROOT" --state "$STATE" --backups "$BACKUPS"
```

It stops the owned pilot, takes a consistent backup, proves the backup restores
into a disposable database, starts the new runtime on the same state and waits
for it to report running and healthy. If the new runtime does not come up, it is
stopped and the previous runtime is started again; the reported backup is the
recovery point if the new API already migrated the database. Health is process
and API readiness, not learner, provider or deployment acceptance.
