# API startup diagnostics

The API starts in named steps (`services/api/src/startup.ts`). When a step fails, the process
writes **exactly one** JSON line to stderr and exits with status 1:

```json
{"startup":"failed","step":"sandbox_image_inspect","code":"image_missing","hint":"The pinned sandbox image is not on this machine. Pull it (npm run sandbox:pull) or set COURSE_SANDBOX_IMAGE to an image you have."}
```

- `step` names what failed (table below).
- `code` is a fixed identifier: a reason chosen by the step, an API error code, a PostgreSQL
  SQLSTATE (`28P01`, `3D000`, …) or a socket code (`ECONNREFUSED`, `EADDRINUSE`, …). It is never
  an error message, so a connection string, password, path or provider answer cannot appear.
- `hint` is fixed text that says what to do.
- `detail` appears only for `configuration`, with the API's own message naming the setting
  (for example `"Invalid PORT."`); it is left out if it would contain a URL.

| Step | What it does | Typical codes |
| --- | --- | --- |
| `configuration` | Reads and checks the environment (origins, port, sign-in settings, telemetry, `SANDBOX_STARTUP_TIMEOUT_MS`) | `INVALID_CONFIGURATION`, `ERR_INVALID_URL` |
| `db_connect` | Opens the database (`DATABASE_URL`, and `MIGRATION_DATABASE_URL` when set) | `ECONNREFUSED`, `ENOTFOUND`, `28P01`, `3D000`, `57P03` |
| `migrations` | Applies migrations in one transaction and, with a migration user, grants and checks runtime rights | `42501`, `MIGRATION_CHANGED`, `RUNTIME_PRIVILEGES` |
| `provider_configuration` | Reads `PROVIDER_CONFIG_FILE` | `INVALID_CONFIGURATION`, `INVALID_CONFIG` |
| `docker_info` | `docker info`: the daemon answers and offers the required isolation | `docker_not_installed`, `docker_unavailable`, `docker_timeout`, `required_isolation_unavailable` |
| `sandbox_image_inspect` | `docker image inspect`: the pinned image is present for this architecture | `image_missing`, `image_inspect_timeout`, `native_image_architecture_required` |
| `verifier_qualification` | Loads code fixtures and qualifies each teaching verifier in the sandbox | `TEACHING_VERIFIER_QUALIFICATION_FAILED`, `TEACHING_VERIFIER_QUALIFICATION_TIMEOUT`, `TEACHING_VERIFIER_SANDBOX_UNAVAILABLE`, `ENOENT` |
| `object_store` | Checks the artifact object store (`COURSE_ARTIFACT_STORE`) | `OBJECT_STORE_UNAVAILABLE` |
| `server_setup` | Builds the HTTP server and routes | — |
| `port_bind` | Listens on `API_HOST:PORT` | `EADDRINUSE`, `EACCES`, `EADDRNOTAVAIL` |

The API does not connect to Temporal; the supervisor worker and dispatcher do. They report a
Temporal that never accepted a connection in the same shape, with `"step":"temporal"` and
`"code":"temporal_unavailable"` (after retrying until `SUPERVISOR_TEMPORAL_CONNECT_DEADLINE_MS`).

## A slow Docker and teaching-verifier qualification

Teaching verifiers (`TEACHING_VERIFIER_FILES`) must pass their own qualification cases in the
grading sandbox before the API serves anything; that is never skipped. Docker can be slow right
after a boot or under load, so startup now waits for it within a bound instead of failing on the
first try:

- `docker info` and `docker image inspect` are retried while Docker is merely not answering yet
  (`docker_unavailable`, `docker_timeout`, `image_inspect_timeout`), with waits from 1 s to 5 s,
  until `SANDBOX_STARTUP_TIMEOUT_MS` (default 120000, allowed 5000–900000).
- Qualification is retried while the sandbox is busy or unavailable, or a case timed out, until
  the same deadline. A verifier whose cases ran and did not all pass fails at once.
- When the deadline passes, startup fails with the last reason. Nothing is installed
  unqualified.

Without teaching verifiers (code fixtures or `COURSE_SUPPLIED_CODE_FIXTURES` only), the API
starts at once and code grading is unavailable until Docker is ready, as before; the Docker
problem is written as one line with `"startup":"degraded"` and the same fields.

## A successful start

With `LOG_LEVEL=debug`, a successful start writes one more line to stderr with each step's
duration in milliseconds:

```json
{"startup":"ready","level":"debug","totalMs":412,"steps":{"configuration":3,"db_connect":21,"migrations":118,"provider_configuration":0,"server_setup":240,"port_bind":2}}
```

At any other level nothing is added; `Course API listening on …` on stdout is unchanged.
