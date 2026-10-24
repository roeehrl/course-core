# Private local pilot

This service-management revision is under qualification. Do not replace an
already running legacy pilot using this controller: legacy owner records fail
closed. Coordinate graceful shutdown with the known launcher, preserve its
Temporal task queue and saved application state, and qualify restart before
installing a persistent service. Native launchd lifecycle tests and migration
acceptance are still required for this revision.

To run Core on a Linux server instead, use the Docker setup in
[`deploy/docker`](../docker/README.md).

This launcher runs the API, learner/admin static exports, a durable local Temporal
development server and two bounded worker processes on loopback. It is a local
pilot deployment, not a production HA configuration. PostgreSQL must already be
available in a dedicated application database. Native mobile binaries are not used.

Build and verify the repository first. Install the pinned Temporal CLI with
`node deploy/local/temporal-cli.mjs install --to "$PWD/.local/bin/temporal"`: it
downloads the official release archive for this host, checks the archive and the
extracted binary against the SHA-256 digests pinned in `temporal-cli.mjs`
(currently 1.9.1 for macOS and Linux, arm64 and x64), and refuses on a mismatch.
A reset, timeout, DNS failure, HTTP 5xx or HTTP 429 with `Retry-After` is retried
up to four attempts in all, with the partial archive removed first; a 4xx or a
checksum mismatch fails at once.
`pilot.mjs start` and `upgrade.mjs` check `.local/bin/temporal` against the same
pins before starting or stopping anything (`temporal_cli_digest_unknown`). To run
another build, set `"temporalCliSha256"` in `config.json` to its exact digest
after verifying it yourself; that value replaces the pinned list, so it must be
removed or updated when the binary changes. `node deploy/local/temporal-cli.mjs
verify --file <path>` checks a binary without starting anything.
Create `.local/pilot/config.json` with owner-only access:

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

A course can instead bring its own hidden code cases (a data-only fixture registry) or a sandboxed
activity script in its package. The preview lists them under "Files the course brings", and an
owner or administrator approves exactly those files when installing. Activity scripts need nothing
on the host. Hidden code cases need the grading sandbox: set `"courseSuppliedCodeFixtures": true`
in the pilot configuration (it sets `COURSE_SUPPLIED_CODE_FIXTURES=on` for the API) and restart.

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
from loopback, which the API treats as a shared source: once the loopback budget
is used, each username still gets 2 more failures, so one device cannot lock the
others out, while brute force on one username stays capped at 10 per 15 minutes.
The pilot does not set `TRUSTED_PROXIES` (see the root README): with
`tailscale serve --tcp` there is no `X-Forwarded-For` to read, and trusting
loopback would let any client of that raw forwarder forge one.

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
- All proxied requests arrive from loopback with no client address (the `--tcp`
  forwarder sends no `X-Forwarded-For`), so the API cannot tell tailnet devices
  apart. Loopback is therefore a shared source: past 100 failures per 15 minutes
  each username gets only 2 more failures from it instead of the whole source being
  locked out, and the 10-per-username limit is unchanged. Agent keys that worked in
  the last 15 minutes keep working while another client sends bad keys.
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
  shows as one trace from dispatch to model call. When a coordinator continues as
  new, it passes its own header and those of jobs still queued to the next run (in
  a second header, `_course-pending-traces`), so those jobs keep the trace that
  prepared them. Temporal itself is not traced.
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
  Only `/v1/` service routes continue a caller's trace. A browser's `traceparent`
  (the admin and learner apps send a fresh one with every request) is never
  adopted as the parent and never decides sampling: the API span records it as a
  span link and sets `course.client.trace_linked`. Its `tracestate` and baggage are
  never read.
- Correlation attributes: a request that records an attempt carries
  `course.attempt.id` (a random UUID) and `course.artifact.hash` (the digest of the
  course release that graded it; never a digest of the learner's answer, which could
  be guessed). The transaction that stores a supervisor artifact carries that
  artifact's digest, inside the worker's trace.

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
row counts. The counts are taken before and after the dump; if they differ,
another client wrote to the database during the backup and `create` fails with
`database_changed_during_backup`, naming the tables.

`verify` is a restore drill: it re-hashes every file (extra, missing, changed or
group/world-readable files fail), restores the dump into a NEW randomly named
database on the same server, compares exact per-table row counts (by table
name, so the order PostgreSQL returns them in does not matter; a mismatch names
each table with its recorded and restored counts) and migrations, checks the
Temporal store with `sqlite3 PRAGMA integrity_check`, and drops the disposable
database. It never touches the live database. Restoring over a live installation
is a deliberate operator procedure: stop the pilot, restore into a new database,
point `databaseUrl` at it, restore `temporal.db` and the vault, then start.
Erasure performed after a backup is not applied to that backup; retain backups
only as long as your documented retention period requires. The pilot keeps every
artifact in Postgres. If you enable the optional object store
(`COURSE_ARTIFACT_STORE=s3`, see the root README), these backups do not contain
the stored objects: back up that bucket separately.

### Hourly online snapshots (1 hour RPO)

A stopped backup needs downtime, so it cannot run every hour. An **online snapshot**
can: it runs while the pilot serves learners and needs no password or prompt.

```sh
node deploy/local/backup.mjs snapshot --root "$ROOT" --state "$STATE" --output "$SNAPSHOTS" [--pg-bin …]
node deploy/local/backup.mjs prune --output "$SNAPSHOTS" --keep 48 --kind snapshot
```

- **PostgreSQL** is read from one exported snapshot. A `REPEATABLE READ` transaction
  is held open, and `pg_dump --snapshot`, the per-table row counts and the migration
  list all read that snapshot. The dump and its recorded counts therefore always
  agree, even while learners keep writing. No lock blocks writers.
- **Temporal** is copied with sqlite's online backup (`sqlite3 .backup`), which is
  consistent while the server writes. The copy is taken a few seconds after the
  database snapshot. Temporal holds workflow state only; learner records and the
  supervisor outbox live in PostgreSQL, so a restore loses no learner data.
- **Configuration, installation record and provider vault** are copied as in `create`.
  With `backupAgeRecipients` set, every file is encrypted to those public keys and the
  dump goes straight into `age`. No plaintext dump touches the disk.
- The connection uses `migrationDatabaseUrl` (or `databaseUrl`) through its socket,
  trust auth or `~/.pgpass`. A URL with a password is refused, as for `create`.

A snapshot directory is named `snapshot-…` and has the same manifest format as a
backup, marked `"consistency": "online_snapshot"`. `verify` restores it the same way
and `prune --kind snapshot` keeps it apart from stopped backups.

**Let the pilot take them.** Add a `snapshots` key to `config.json`:

```json
"snapshots": { "directory": "/path/to/private/snapshots", "intervalMinutes": 60, "keep": 48 }
```

- `directory` must be an absolute path. It is created owner-only.
- `intervalMinutes` must be from 15 to 60. 60 meets the 1 hour RPO.
- `keep` must be from 2 to 1000. 48 keeps two days of hourly snapshots.

While the pilot runs, it takes the first snapshot a minute after its services are
ready and then one every interval. It runs one snapshot at a time, each as its own
`backup.mjs` process with a 30 minute limit, and prunes after each success. The
services log records only `snapshot_created`, `snapshot_failed` or
`snapshot_prune_failed`. Stopping the pilot ends a snapshot that is still running,
and no partial directory is left behind. Keep a daily stopped `create` as well if
you want a copy whose Temporal store and database come from the same instant.

**Reports.** `create`, `snapshot` and `verify` each write one row to the
`platform_backup_reports` table (migration 100). The row holds the kind, the
outcome, a failure code, the start and finish times, row and table counts, the
total size and whether the copy was encrypted. It never holds a path or a
credential. Writing the row is best effort: a database without the table, or one
that cannot be reached, does not fail the backup, and the result says
`"reported": false`. The admin **Platform** page reads these rows. It shows the
latest snapshot, backup and restore drill and checks the recovery targets below.

### Encrypting backups with age (optional)

Backups are not encrypted by default. To encrypt them, install the
[age](https://age-encryption.org) CLI (`brew install age`, or `apt install age`
on Debian/Ubuntu), create a key pair **away from the pilot's state directory**,
and put only the public recipient in `config.json`:

```sh
age-keygen -o "$KEYS/pilot-backup.txt"     # private identity: keep it offline/elsewhere, mode 0600
age-keygen -y "$KEYS/pilot-backup.txt"     # prints the age1… public recipient
```

```json
{ "backupAgeRecipients": ["age1…"] }
```

`backupAgeRecipients` takes one to eight `age1…` X25519 public keys (for example
the operator's key and an offline recovery key). The launcher refuses an age
private key (`AGE-SECRET-KEY-…`) in configuration
(`backup_age_private_key_in_configuration`). With recipients set, `create`
first checks for `age` (or `--age-bin <directory>`) and stops with `age_missing`
before dumping anything if it is not installed. The database dump is streamed
from `pg_dump` straight into `age`, so no plaintext dump is written; every other
file is encrypted as it is copied. The backup then holds only `*.age` files and
`manifest.json` (schema version 2).

The manifest stays readable, so integrity checks and `prune` still work without
the key: it records each ciphertext's size and SHA-256 plus the size and SHA-256
of the plaintext. It does reveal the Core and PostgreSQL versions, applied
migration names, table names, per-table row counts, file sizes and the
recipients, but no row contents, configuration values or keys.

Restoring needs the identity file, passed at restore time (it must be an
owner-only regular file):

```sh
node deploy/local/backup.mjs verify  --root "$ROOT" --state "$STATE" --backup "$BACKUPS/backup-…" --age-identity "$KEYS/pilot-backup.txt"
node deploy/local/backup.mjs decrypt --backup "$BACKUPS/backup-…" --age-identity "$KEYS/pilot-backup.txt" --output "$RESTORE"
```

`verify` checks the ciphertext digests, decrypts into a temporary owner-only
directory inside the pilot state directory (which already holds the same data
unencrypted), checks every plaintext digest, runs the normal restore drill and
removes the decrypted copy. `decrypt` writes a plain, owner-only backup
(schema 1, with its own manifest) for the manual restore procedure above; it
verifies like any plain backup, and you should delete it once the restore is done.
A wrong identity fails with `age_decrypt_failed`; changed ciphertext fails with
`backup_file_changed`, or with `age_decrypt_failed` if the manifest digest was
rewritten too, because age authenticates the ciphertext. A missing identity
fails with `age_identity_required`, and the upgrade script needs
`--age-identity` too when recipients are configured (it checks before stopping
the pilot). Losing every identity makes the encrypted backups unrecoverable. Runtimes older than this option reject the
`backupAgeRecipients` key as unknown configuration, so remove it before starting
such a release (including the upgrade script's rollback to one). If
the drill is interrupted by a crash, delete any `.restore-drill-*` directory left
in the state directory.

```sh
node deploy/local/backup.mjs prune --output "$BACKUPS" --keep 7
```

`prune` keeps the newest N backups whose manifests still verify and deletes
older intact ones. Changed, unreadable, linked or unrecognised entries are left
in place and listed under `skipped` for an operator to inspect; at least one
backup is always kept. Run it after a successful `create` and `verify`.

## Availability, recovery targets and degraded modes

The pilot is one macOS host with one PostgreSQL server, one Temporal development
server and no standby. The targets below are what this design can honestly
support. They are operating targets for a single-host pilot, not a production SLA.
The admin **Platform** page monitors the RPO and RTO from the backup reports (see
"Reports" above).

| Target | Value for the local pilot | What it rests on |
| --- | --- | --- |
| Availability | 99.5% per calendar month (about 3.6 hours of unplanned downtime), counted only while the host is powered on and the operator is logged in. Planned backup and upgrade windows are excluded | launchd restarts after a failure (below); no redundancy for host, disk or PostgreSQL failures |
| RPO (data loss on restore) | 1 hour with hourly online snapshots (`snapshots.intervalMinutes` 60 or less). Without snapshots it is the time since the last backup that passed `verify`: 24 hours with a daily stopped backup | Online snapshots need no downtime. There is no WAL archiving, so data written since the newest snapshot is lost on restore |
| RTO (restore on the same host) | 1 hour | Restore of a small database takes seconds (below); the time goes into operator steps |
| RTO (replacement host) | 4 hours | Install the pinned release, Node 26, PostgreSQL 17 and the Temporal CLI, then restore |

**How the Platform page checks them.**

| Check | OK | Warning | Failing |
| --- | --- | --- | --- |
| RPO | The newest successful snapshot or backup finished at most 60 minutes ago | 61 to 120 minutes ago | Older than 120 minutes. "No data" when nothing was ever reported |
| RTO | The latest restore drill succeeded, took at most 60 minutes and is at most 7 days old | The drill is older than 7 days | The latest drill failed or took longer than 60 minutes |

Encryption is optional: the page notes whether the newest copy was encrypted and
how to turn it on, as information rather than a warning, and the admin
notification center raises only overdue backups, never unencrypted ones.

The drill's duration (decryption included) stands in for the restore time. Run
`verify` on a recent snapshot at least weekly so the RTO check stays current.

**Why not WAL archiving.** Continuous WAL archiving would give a smaller RPO, but
it needs PostgreSQL server settings (`archive_mode`, `archive_command`) and a
restart of a server the pilot does not own. Hourly snapshots meet the 1 hour
target with the database the operator already has. A stopped backup is still
the only copy whose Temporal store and database come from the same instant.

**Measured restore time.** On the development Mac, with other work running,
`pg_dump --format=custom` of a disposable 225 MB database (one million rows plus
an index) took 2.7 s and produced 50 MB, and `pg_restore` into a new database took
2.1 s. The repository's restore drill for a small database with age encryption
(`create` and `verify` together, including decryption) took about 2.5 s, most of it
starting the `age` command. Expect restore time to grow roughly linearly with the
dump size, and time your own drill (`verify` prints nothing about timing; wrap it in
`time`).

**Restore procedure (RTO steps).**

1. Stop the pilot (`node deploy/local/pilot.mjs stop`).
2. If the backup is encrypted, `backup.mjs decrypt … --age-identity …` it.
3. Run `verify` on it.
4. Create a new database and run `pg_restore --no-owner --no-privileges --exit-on-error` into it.
5. Point `databaseUrl` (and `migrationDatabaseUrl`) at the new database.
6. Copy `temporal.db`, the `provider-vault/` files and `installation.json` into the state directory, owner-only.
7. Start the pilot.

### Keep-alive and restart behaviour

- **The launcher stops the whole group when any part fails.** If Temporal, the API,
  the worker or the dispatcher exits or fails to spawn, `pilot.mjs` stops all the
  other children and exits with status 1. It never restarts a child itself, and it
  does not run half the services. A child that hangs without exiting is not
  detected: there is no health check after startup.
- **Run it under launchd to restart it after a failure.**
  `node deploy/local/service.mjs install|status|uninstall [--root … --state …]`
  writes a per-user LaunchAgent with `RunAtLoad`, `KeepAlive: {SuccessfulExit:
  false}`, `ThrottleInterval: 30` and `ExitTimeOut: 80`.
  - After a crash or failed start (exit status 1), launchd starts the launcher
    again, at most once every 30 seconds.
  - A clean `pilot.mjs stop` exits with status 0 and is not restarted.
  - The agent lives in the `gui/<uid>` domain, so the pilot starts when the
    operator logs in, not at boot before login, and it stops at logout.
  - Each start first clears a stale owner record left by a crash, but only when
    the old processes are gone and the ports are free (`recover` does the same by
    hand). Otherwise it refuses and leaves the record for review.
  - Without the service, a foreground `pilot.mjs start` that fails stays down.
- **What survives a restart.** PostgreSQL data and the Temporal store survive.
  - Learner events are written to an outbox in the same transaction as the
    learning event, so a restart loses no supervision work.
  - The dispatcher retries a failed workflow start with backoff (1 s doubling to
    1 hour) and quarantines it after 8 attempts. An administrator can re-queue a
    quarantined event once.
- **PostgreSQL is not managed by the pilot.** If it is down at start, migrations
  fail, the API exits and the launcher stops (launchd retries every 30 s).

### Degraded modes

| Condition | What learners and staff see | What recovers it |
| --- | --- | --- |
| **Model provider down, failing or not configured** | Lessons, checks, deterministic grading and progress work: they never call a provider. A companion message is saved and queued. The learner sees "Companion service unavailable · your question is saved" or "Waiting for service configuration · your message is saved", never a provider error. Supervision jobs stop in a waiting state | Provider HTTP calls retry with backoff and jitter, honouring `Retry-After` (3 attempts by default; a generation request is retried only after an explicit 429). A call whose outcome is uncertain is never resent; it is settled from gateway receipts by the dispatcher's reconciliation. Configure the provider or wait for it to return. There is no circuit breaker |
| **Temporal down** | The API never calls Temporal, so learning, grading and progress continue. Supervision (companion replies, follow-ups) waits in the outbox | When Temporal returns, the dispatcher claims due outbox rows and reconciles stalled jobs. If the Temporal process itself exits, the launcher stops the group and launchd restarts it |
| **Telemetry collector down** | Nothing. Spans and metrics are exported in the background and export failures never fail or delay a request | Telemetry in the meantime is dropped, not stored on disk |
| **Learner offline** | "You're offline": drafts stay on the device (local storage, falling back to session storage). An unconfirmed answer or command is kept with its original idempotency key and offered as "Send saved request now". A companion question asked offline is held as a draft. Nothing is recorded until the server confirms it | On reconnect, or when the page becomes visible again, the saved request is resent with the same idempotency key, so it is recorded at most once. There is no service worker: a learner who is offline cannot load the app at all |
| **PostgreSQL down** | API requests fail (`INTERNAL_ERROR`); the learner app keeps unconfirmed commands for retry as when offline. `/health` fails | Restart PostgreSQL. A restart of the API may also be needed (see the note below) |

The API registers no error handler on its PostgreSQL connection pool. If
PostgreSQL drops idle connections (for example when it restarts), the API process
may exit, which stops the pilot until launchd restarts it. This has not been
reproduced here.

## Least-privilege database role

Set `migrationDatabaseUrl` to an owner connection for the same database and make
`databaseUrl` name a separate login role without superuser, CREATEDB or
CREATEROLE. On start the API migrates and grants that role SELECT/INSERT/
UPDATE/DELETE on application tables (no TRUNCATE, schema CREATE or ownership),
re-granting after every migration, then refuses to serve if its own role could
change the schema. Only the API receives the owner URL. Backups and restore
drills use the owner connection when it is configured.

## Upgrading a pinned runtime

Install the new verified release into its own root (with its pinned Temporal CLI,
installed or copied byte-identical and checked as above), then:

```sh
node "$NEW_ROOT/deploy/local/upgrade.mjs" --from "$OLD_ROOT" --to "$NEW_ROOT" --state "$STATE" --backups "$BACKUPS" [--age-identity "$KEYS/pilot-backup.txt"]
```

It stops the owned pilot, takes a consistent backup, proves the backup restores
into a disposable database, starts the new runtime on the same state and waits
for it to report running and healthy. Any failure after the pilot was stopped
(backup, restore drill, launch or health of the new runtime) stops whatever the
upgrade started and starts the previous runtime again. The command then exits 1
with one JSON line on stderr, for example:

```json
{"status":"blocked","code":"upgrade_failed_previous_runtime_restarted","reason":"restored_row_counts_differ","lastCompletedStep":"backed_up","backup":"/…/backup-…","tables":[{"table":"…","recorded":3,"restored":2}]}
```

`reason` is the code of the step that failed and `backup` is present once a
backup was written. Other codes: `upgrade_failed_previous_runtime_not_restarted`
(the failure came before the new runtime ran, so the database is untouched;
start the previous runtime by hand), `upgrade_failed_restore_from_backup` (the
new runtime ran and the previous one did not come back; the reported backup is
the recovery point if the new API already migrated the database),
`upgrade_failed_new_runtime_not_stopped`, and `upgrade_failed_pilot_left_stopped`
(the pilot was not running when the upgrade began, and stays stopped). Health is
process and API readiness, not learner, provider or deployment acceptance.
