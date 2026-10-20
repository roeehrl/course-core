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

## Installing courses from packages

Administration's **Install course** installs a course package (`.course.tgz`) by upload or from
a public GitHub release link (see the root README, “Installing a course”). The pilot passes no
`COURSE_PACKAGE_REMOTE_FETCH`, so the default `github` applies and the API may contact
`api.github.com`, `github.com` and GitHub's release-asset hosts when an operator inspects a link.
To allow uploads only, set `COURSE_PACKAGE_REMOTE_FETCH=off` in the API's environment. A
package's host requirements are only compared with the files listed in `codeFixtureFiles` and
`teachingVerifierFiles` (by SHA-256; the preview shows names and digests, never paths): add
missing fixtures or verifiers to the pilot configuration yourself and restart before installing.

Course updates can also read packages from host folders you allow. List them in the optional
`coursePackageDirectories` key (absolute, existing directories; at most 16), or edit it with

```sh
node deploy/local/pilot.mjs package-directories add /absolute/path/to/course-packages
node deploy/local/pilot.mjs package-directories list
node deploy/local/pilot.mjs package-directories remove /absolute/path/to/course-packages
```

(`--state <dir>` as for `origins`; restart the pilot afterwards). Administration then offers each
directory by name and confines every update source inside it. Automatic updates are off for every
course until an administrator turns them on; the API checks for due updates every five minutes
(`COURSE_UPDATE_TICK_MS`).

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

The API always listens on `127.0.0.1` only. To use the pilot from your other
devices on a Tailscale tailnet, let `tailscale serve` accept connections on this
machine's tailnet address and forward them to that loopback port; the API only has
to trust the origin the browser then uses. The browser talks to one origin, so no
CORS is involved and none is configured.

### By tailnet IP address (plain http)

1. On the pilot host, forward the tailnet port to the loopback port as raw TCP
   (use the port of your `publicOrigin` if it is not 4310):

   ```sh
   tailscale serve --bg --tcp=4310 tcp://127.0.0.1:4310
   ```

   `tailscale ip -4` (or `-6`) shows the machine's tailnet address, and
   `tailscale serve status` lists the forwarder on the machine's name and on its
   tailnet IPv4 and IPv6 addresses. Use `--tcp`, not `--http`: the `--http` web
   handler routes by `Host` header and answers only the machine's MagicDNS name, so a
   request to `http://<100.x.y.z>:4310` gets Tailscale's own "404 page not found".
   The TCP forwarder passes the connection through unchanged, so the pilot sees the
   browser's own `Host` and `Origin` (`http://<100.x.y.z>:4310`). It listens on
   the tailnet only, and with `--bg` it stays configured across restarts and
   reboots until you remove it with `tailscale serve --tcp=4310 off`.
2. Add that exact origin to the pilot configuration (`$STATE` is the state
   directory, by default `.local/pilot`):

   ```sh
   node deploy/local/pilot.mjs origins add --state "$STATE" http://<100.x.y.z>:4310
   node deploy/local/pilot.mjs origins list --state "$STATE"
   ```

3. Restart the pilot (`stop`, then `start`) and browse to `http://<100.x.y.z>:4310`
   from a device on the tailnet. Sign in with a password (or a one-time code).

Plain `http` is accepted for an additional origin only when the host is a literal
Tailscale address, IPv4 in `100.64.0.0/10` or IPv6 in `fd7a:115c:a1e0::/48` (in
brackets, e.g. `http://[fd7a:115c:a1e0::…]:4310`), with an explicit port. Tailnet
traffic is WireGuard-encrypted end to end, so this is not plaintext on the network.
It is still not a browser *secure context*: session cookies there are not
`Secure` (browsers would drop them) but stay `HttpOnly` and `SameSite=Strict`, and
passkeys are unavailable (the apps show only the password form). Every other
non-loopback `http` origin, such as a LAN address or a host name, is refused while
the insecure-address check is on, which is the default (see below).

### By tailnet HTTPS name (also allows passkeys)

1. In the tailnet admin console, enable **MagicDNS** and **HTTPS certificates**.
2. Publish the loopback port with HTTPS on the machine's tailnet name:

   ```sh
   tailscale serve --bg --https=443 http://127.0.0.1:4310
   ```

   (HTTPS on port 443 is also the default, so `--https=443` may be omitted.)
   Remove it later with `tailscale serve --https=443 off`.

   `tailscale serve status` shows the name, of the form
   `https://<machine>.<tailnet>.ts.net`.
3. Add it with `node deploy/local/pilot.mjs origins add --state "$STATE"
   https://<machine>.<tailnet>.ts.net`, restart the pilot and browse to that name.
   Cookies there are `Secure`, and passkeys can be added and used.

### Turning the insecure-address check off (LAN or host-name http origins)

By default the pilot and the API refuse a plain-`http` additional origin unless its
host is a literal Tailscale address. An operator who knowingly wants to reach the
pilot over plain `http` on another network, for example `http://192.168.1.5:4310`
through a LAN TCP forwarder, can turn this check off:

```sh
node deploy/local/pilot.mjs security insecure-origin-check status --state "$STATE"
node deploy/local/pilot.mjs security insecure-origin-check off --state "$STATE"
node deploy/local/pilot.mjs origins add --state "$STATE" http://192.168.1.5:4310
```

`security insecure-origin-check on|off|status` names the check's state: `on` (the
default) enforces it, `off` lets plain-`http` origins outside Tailscale be trusted.
Then restart the pilot. `insecure-origin-check off` writes `"allowInsecureOrigins": true`
to `config.json`, and the API is started with `ALLOW_INSECURE_ORIGINS=true` (it is
always passed, `false` by default). Like origins, the change takes effect only on the
next start. While it is off, the API writes an `origins.insecure_allowed` event to its
log at start, and the admin app shows every staff member a notice that cannot be
dismissed.

Understand the risks before turning it off:

- Nothing on a plain-`http` origin outside Tailscale is encrypted. Passwords, one-time
  codes and session cookies cross the network in the clear, so anyone on that network
  can read them and take over the session.
- Such a page is not a browser secure context: cookies there are not `Secure`, and
  passkeys are unavailable (they need `https` or `localhost`). Use a password there.
- Only the address check is relaxed. Each origin must still be listed exactly, with an
  explicit port and no path, credentials or wildcard, and the exact `Origin` check,
  CSRF tokens, `SameSite=Strict` cookies and authentication are unchanged.

Prefer the tailnet options above, which are encrypted. To turn the check back on,
first remove each plain-`http` origin outside Tailscale (`origins remove`; `status`
lists them), then run `security insecure-origin-check on`; the command refuses while any
remain, because the launcher would then refuse the configuration. Off removes the
`allowInsecureOrigins` key. `origins add` of such an origin is refused while the
check is on, and its error names the command that turns it off. Older launchers
reject a `config.json` containing `allowInsecureOrigins`, so turn the check back on
before rolling back to one.

The 0.1.46 form `security insecure-origins on|off|status` still works but is
deprecated and prints a note on stderr naming the new form. It names whether insecure
origins are allowed, so it is the reverse of the new form: `insecure-origins on` is
`insecure-origin-check off`, and `insecure-origins off` is `insecure-origin-check on`.

### Details and limits

- The origins command edits `config.json` atomically, keeping every other key and
  the file's mode. Origins must be written exactly as the browser sends them (no
  path, trailing slash or default port); at most 8. `origins remove` takes one out,
  and removing the last one removes the `additionalOrigins` key. The API receives
  the list as `ADDITIONAL_ORIGINS`; changes take effect only on the next start.
- The API never binds to the tailnet address itself: `tailscale serve` is the only
  listener there. Do **not** use `tailscale funnel`; it publishes the pilot to the
  public internet.
- `publicOrigin` stays the primary origin: the supervisor, health checks and the
  bootstrap command use it. Invitation and sign-in links created by an
  administrator use the trusted origin the administrator is using.
- Cookies are per host, so each origin has its own sign-in. Passkeys use the
  origin's host name as relying party ID, so a passkey added on the tailnet name
  works only there (and one added on `localhost` only there).
- Another reverse proxy or TCP forwarder on the tailnet works the same way if it
  forwards to the loopback port and keeps the browser's `Host` header (a raw TCP
  forwarder such as `tailscale serve --tcp` cannot change it).
- All proxied requests arrive from loopback, so tailnet devices share the
  per-address sign-in throttle (100 failures per 15 minutes) with the host; the
  per-username limit is unchanged.
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

Spans wait in a bounded queue and are sent in batches. The standard batch
variables set the bounds; a value outside its range fails `start` like any other
invalid setting:

| Variable | Default | Accepted |
| --- | --- | --- |
| `OTEL_BSP_MAX_QUEUE_SIZE` | 2048 spans | 1 to 16384 |
| `OTEL_BSP_MAX_EXPORT_BATCH_SIZE` | 512 spans | 1 to 4096, and not above the queue size |
| `OTEL_BSP_EXPORT_TIMEOUT` | 30000 ms | 1000 to 60000 |
| `OTEL_BSP_SCHEDULE_DELAY` | 5000 ms | 100 to 60000 |

The pilot launcher does not pass these, so the pilot uses the defaults; set them
in the service environment when running the services yourself.
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
  dispatcher's idle polls are not sampled. The dispatcher's workflow start is a
  `supervisor.workflow.start` span, and the start carries its trace context in a
  Temporal header (`_tracer-data`, the same header and format as
  `@temporalio/interceptors-opentelemetry`). The enrollment coordinator passes the
  header to the job it starts, and the job passes it to its activities, so a run
  shows as one trace from dispatch to model call. Jobs still queued when a
  coordinator continues as new lose the header and start their own trace. Temporal
  itself is not traced.
- Metrics: `http.server.request.duration`, `gen_ai.client.operation.duration`,
  `gen_ai.client.token.usage`, `course.provider.operations`,
  `course.provider.cost.estimate` (the application's reserved-ceiling allowance in
  micro-USD, not a provider invoice), `course.supervisor.run.outcomes`,
  `course.supervisor.checkpoint.outcomes`, `course.sandbox.job.duration`, and:
  - `course.supervisor.event.lag`: seconds from a learning event being recorded to
    the host preparing it for the supervisor, by role and disposition (`prepared`,
    `coalesced`, `policy_denied`, `refused` and so on). Only the first preparation of
    an event is recorded; a redelivery is not.
  - `course.supervisor.job.retries`: checkpoint attempts the host scheduled to run
    again, by role.
  - `course.supervisor.rejections`: work refused by policy (`policy_denied`) or by
    the host when preparing it (`preparation_refused`), and runs whose result was
    rejected by verification (`verification_rejected`) or the provider
    (`provider_rejected`), by role.
  - `course.appeals`: written-answer appeals and gate reviews, `opened` or
    `resolved` (with the outcome: `changed`, `upheld`, `exception_granted`).
    Counted after the change commits; an idempotent replay is not counted again.
  - `course.telemetry.spans.dropped`: spans that were never exported, because the
    queue was full (`queue_full`) or the receiver refused them or did not answer in
    time (`export_failed`).
- Never exported: prompts, model output, learner text or answers, names, user,
  enrollment, job or workspace IDs, URLs with IDs or queries, headers, cookies,
  client addresses, credentials, SQL, exception messages or stacks. Every span
  name, metric and attribute passes a fixed allowlist in which each value must
  match an enum or identifier pattern; anything else is dropped. Resources carry
  only `service.name` and `service.namespace` (no host or process detection).
  Browser-supplied `traceparent` headers are ignored; only `/v1/` service routes
  continue a caller's trace.

Learning events, supervisor jobs and provider dispatches record the ID of the trace
that wrote them in a `trace_id` column (migration 079), so a row can be found from a
trace and a trace from a row. It is filled only while tracing is on and the writing
span is valid and sampled; otherwise it is null and never generated. Events from
browser requests carry the API's own trace, not the browser's. `correlation_id` is
unchanged. A trace ID is a random identifier; it is kept through erasure.

If the receiver is down or slow, requests and supervisor runs do not wait for it
and their database records commit as usual. The queue never holds more than
`OTEL_BSP_MAX_QUEUE_SIZE` spans; further spans are dropped and counted in
`course.telemetry.spans.dropped`, and each service writes at most one line a minute
per reason to its error log, such as
`{"code":"telemetry_spans_dropped","reason":"queue_full","total":120}`. A row's
`trace_id` can therefore name a trace that never reached the receiver. Shutdown
waits at most about one export timeout for the receiver.

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

A self-hosted Langfuse is configured the same way with its own address and the
same `/api/public/otel` path, and needs a Langfuse release that has the
OpenTelemetry endpoint. The endpoint must be `https://`, or `http://` on a loopback
address when Langfuse runs on the pilot's machine (its web container listens on
port 3000 by default):

```json
"telemetry": {
  "otlpEndpoint": "http://127.0.0.1:3000/api/public/otel",
  "otlpHeaders": { "Authorization": "Basic <base64 of public:secret>" },
  "metrics": false
}
```

For Langfuse on another machine, put it behind HTTPS (for example a reverse proxy
or a tailnet HTTPS name); a plain `http://` address on the network is refused.
This has not been tested against a self-hosted Langfuse either.

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
