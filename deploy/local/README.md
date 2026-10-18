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

### Passkeys

Passkey sign-in (see the root README) needs no configuration key: it follows
`publicOrigin` (and each of `additionalOrigins`, see "Using the pilot from your
Tailscale tailnet"). WebAuthn refuses IP addresses as relying party IDs, so the
example `http://127.0.0.1:4310` keeps passkeys switched off and the apps show only the
password form. To offer passkeys, set `publicOrigin` to `http://localhost:4310`
and open the apps at exactly that address (the launcher accepts only loopback
`http` origins; a non-loopback deployment needs `https://<host name>` as the
API's `PUBLIC_ORIGIN`). The RP ID is the host name, so changing it later leaves
existing passkeys unusable; people then sign in with their password and add a new
one. Migration 029 adds `passkey_credentials` and `passkey_challenges`; the runtime
role is re-granted when the upgraded API starts. Passkey sign-in failures share the
password throttle above. Setting a temporary password with `--temporary` also
removes that account's passkeys.

Migration 030 adds the append-only `staff_learner_views` audit table for the
owner/admin "view as learner"; the runtime role is re-granted on startup like any
other table, and a trigger refuses updates and deletes for every role.

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

## Using the pilot from your Tailscale tailnet

The API always listens on `127.0.0.1` over plain HTTP. To use the pilot from your
other devices on a Tailscale tailnet, let `tailscale serve` terminate HTTPS on the
machine's tailnet name and forward to that loopback port. The browser then talks to
one HTTPS origin, so no CORS is involved; the API only has to trust that origin.

1. In the tailnet admin console, enable **MagicDNS** and **HTTPS certificates**.
2. On the pilot host, publish the loopback port on the tailnet only:

   ```sh
   tailscale serve --bg http://127.0.0.1:4310
   ```

   Use the port of your `publicOrigin` if it is not 4310.

   `tailscale serve status` shows the name, of the form
   `https://<machine>.<tailnet>.ts.net`.
3. Add that exact origin (no path or trailing slash) to the pilot configuration
   (`$STATE` is the state directory, by default `.local/pilot`):

   ```sh
   node deploy/local/pilot.mjs origins add --state "$STATE" https://<machine>.<tailnet>.ts.net
   node deploy/local/pilot.mjs origins list --state "$STATE"
   ```

   This edits `config.json` atomically, keeping every other key and the file's
   mode. Only `https://` origins are accepted (at most 8); `origins remove` takes one
   out again, and removing the last one removes the `additionalOrigins` key.
4. Restart the pilot (`stop`, then `start`); the API receives the list as
   `ADDITIONAL_ORIGINS`. Changes take effect only on the next start.
5. Browse to `https://<machine>.<tailnet>.ts.net` from a device on the tailnet and
   sign in as usual.

Details and limits:

- `http://<100.x.y.z>:4310` (the tailnet IP) is intentionally not served: the API
  still binds only to loopback, and plain HTTP is never trusted off loopback.
- Do **not** use `tailscale funnel`; it publishes the pilot to the public internet.
- `publicOrigin` stays the primary origin: the supervisor, health checks and the
  bootstrap command use it. Invitation and sign-in links created by an
  administrator use the trusted origin the administrator is using.
- Sign-in from the HTTPS origin gets `Secure` session cookies (`SameSite=Strict`);
  the loopback `http` origin keeps working without them. Cookies are per host, so
  each origin has its own sign-in.
- Passkeys use the origin's host name as relying party ID, so a passkey added on
  the tailnet name works only there (and one added on `localhost` only there).
  `http://127.0.0.1` never offers passkeys.
- All proxied requests arrive from loopback, so tailnet devices share the
  per-address sign-in throttle (100 failures per 15 minutes) with the host; the
  per-username limit is unchanged.
- Another HTTPS reverse proxy on a private network works the same way if it
  forwards to the loopback port and keeps the browser's `Host` header (as
  `tailscale serve` does). No CORS headers are sent or needed.
- Older launchers reject a `config.json` containing `additionalOrigins`, so remove
  every origin before rolling back to one (an upgrade never rewrites the file).

## OpenTelemetry (optional)

Tracing and metrics are off by default: with no `telemetry` key nothing is loaded,
no hook is installed and nothing is sent. To export to an OTLP/HTTP receiver, add:

```json
"telemetry": {
  "otlpEndpoint": "http://127.0.0.1:4318",
  "otlpHeaders": {},
  "metrics": true
}
```

| Key | Effect | Default |
| --- | --- | --- |
| `otlpEndpoint` | Base OTLP/HTTP URL; traces go to `<endpoint>/v1/traces`, metrics to `<endpoint>/v1/metrics`. `https://`, or `http://` only on a loopback host. No credentials, query or fragment in the URL. | absent (off) |
| `otlpHeaders` | Up to 16 request headers for the receiver, e.g. an authorization key. Owner-only like the rest of `config.json`; never logged. | `{}` |
| `metrics` | `false` exports traces only (for receivers without a metrics endpoint). | `true` |

Anything else fails `start` with `invalid_telemetry_configuration`. The launcher turns
the key into the standard variables `OTEL_EXPORTER_OTLP_ENDPOINT`,
`OTEL_EXPORTER_OTLP_PROTOCOL=http/json`, `OTEL_EXPORTER_OTLP_HEADERS` and, for
`metrics: false`, `OTEL_METRICS_EXPORTER=none`, for the API, worker and dispatcher
only (not Temporal). Outside the pilot launcher, set those variables directly; the
services also honour `OTEL_SDK_DISABLED=true`, `OTEL_TRACES_EXPORTER=none`,
`OTEL_SERVICE_NAME`, per-signal `..._TRACES_/..._METRICS_ENDPOINT` and
`OTEL_METRIC_EXPORT_INTERVAL` (default 60 s). Only OTLP/HTTP with JSON bodies is
bundled; gRPC, protobuf and console exporters are rejected rather than ignored.
Older launchers reject a `config.json` containing this key, so remove it before
rolling back.

What is exported (official `@opentelemetry/*` Apache-2.0 packages, exact pins):

- Spans: HTTP requests named by route template (`POST /api/enrollments/:enrollmentId/...`)
  with method and status; PostgreSQL transactions inside a traced request or run
  (commit/rollback only); supervisor dispatch and worker activities (role, checkpoint
  key, effect, state, reason codes); the provider gateway operation (role, outcome,
  token totals, cost estimate); each model call (model ID, provider ID, input/output
  tokens, attempts, error code); supervisor tool calls (tool name, round); sandbox
  grading (status, case and batch counts). Worker calls to the API carry W3C
  `traceparent`, so a run shows as one trace from activity to model call. The
  dispatcher's idle polls are not sampled. Temporal workflow start is not linked to
  the dispatch trace.
- Metrics: `http.server.request.duration`, `gen_ai.client.operation.duration`,
  `gen_ai.client.token.usage`, `course.provider.operations`,
  `course.provider.cost.estimate` (the application's reserved-ceiling allowance in
  micro-USD, not a provider invoice), `course.supervisor.run.outcomes`,
  `course.supervisor.checkpoint.outcomes`, `course.sandbox.job.duration`.
- Never exported: prompts, model output, learner text or answers, names, user,
  enrollment, job or workspace IDs, URLs with IDs or queries, headers, cookies,
  client addresses, credentials, SQL, exception messages or stacks. Every span
  name, metric and attribute passes a fixed allowlist in which each value must
  match an enum or identifier pattern; anything else is dropped. Resources carry
  only `service.name` and `service.namespace` (no host or process detection).
  Browser-supplied `traceparent` headers are ignored; only `/v1/` service routes
  continue a caller's trace.

The domain run inspector in the admin app remains the authoritative record of
provider calls and verification; OpenTelemetry is an operational view.

### Langfuse

Langfuse accepts OTLP/HTTP traces, so it is configured as an endpoint, with no
Langfuse SDK. Use its OTLP base path and a Basic authorization header built from
your project's public and secret key (`base64("<public>:<secret>")`), and disable
metrics, which Langfuse does not ingest:

```json
"telemetry": {
  "otlpEndpoint": "https://cloud.langfuse.com/api/public/otel",
  "otlpHeaders": { "Authorization": "Basic <base64 of public:secret>" },
  "metrics": false
}
```

Model-call spans use the OpenTelemetry GenAI attribute names (`gen_ai.request.model`,
`gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`), so they appear as
generations with token usage, but deliberately without prompt or completion text.
This mapping has not been verified against a live Langfuse project.

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
only as long as your documented retention period requires. The pilot keeps every
artifact in Postgres. If you enable the optional object store
(`COURSE_ARTIFACT_STORE=s3`, see the root README), these backups do not contain
the stored objects: back up that bucket separately.

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
