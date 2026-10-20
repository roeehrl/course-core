# Bounded supervisor orchestration

An isolated provider-neutral supervisor service for Course Core. Includes a pure job state machine, strict runtime schemas, a host API transaction bridge/client, a Temporal workflow/activity adapter, a runnable worker CLI, and a finite outbox dispatcher. Roles are supervisor, companion, research and media. Provider output is an unverified artifact reference until the host verifies it and applies an authorized proposal; it cannot grant mastery or extensions.

## Module map

| Path | Purpose |
| --- | --- |
| `src/contracts.ts` | Strict job, revision fence, checkpoint, provider, outbox and RPC schemas/interfaces. |
| `src/state-machine.ts` | Pure transition reducer; stable operation IDs, reservations, attempt caps, revision/cancellation/deadline checks, verification and application receipts. |
| `src/activities.ts` | Independent orchestration functions; single-use provider permits and conservative uncertain outcomes. |
| `src/bridge.ts` | Host transaction interface and bounded authenticated HTTP client. |
| `src/providers.ts` | Neutral injectable provider interface, explicit missing configuration, optional HTTP gateway. |
| `src/temporal/` | Deterministic bounded workflows, sanitized activities, idempotent workflow starts. |
| `src/outbox.ts` | One bounded leased dispatch batch, retry backoff and quarantine. |
| `src/config.ts`, `src/cli.ts` | Explicit environment validation, worker and one-shot dispatcher entry points. |
| `BRIDGE.md` | Exact API integration, persistence, authorization and reconciliation obligations. |
| `test/` | Failure, replay, schema, HTTP boundary and actual local Temporal tests. |

The host API implements the documented bridge, PostgreSQL persistence, provider gateway and scoped companion verification. Combined qualification uses actual Temporal, PostgreSQL and HTTP with a synthetic external model, including lost acknowledgements and worker recovery. The local native pilot runs these services. This does not establish live provider acceptance. Non-companion proposals currently store summaries; verified lesson-changing tool orchestration remains a separate implementation gate.

## Install and verify

Run from this directory with Node 26:

```sh
npm ci --ignore-scripts
npm run check
npm run test:temporal
npm run config:check
```

`test:temporal` builds then uses the official SDK's `TestWorkflowEnvironment.createLocal()`. It downloads the SDK-selected official Temporal CLI into ignored `.local/temporal`, starts a temporary loopback server on random free ports with an in-memory database and no UI, and tears it down. It never connects to an existing server or API database. Tests use the real Temporal service/worker/client and history replay, with synthetic in-memory host and provider fixtures. These establish orchestration behavior, **not** live provider, production database or deployment acceptance. A server download/start failure fails the suite; it is not silently skipped.

## Configuration and explicit startup

Copy `.env.example` values into the process environment using your deployment's secret mechanism; the CLI does not read dotenv files. `check-config` only validates settings and never connects or starts a process. Missing required values produce a structured `configuration_missing` result and exit 2. An absent provider gateway is allowed and yields visible per-job `waiting/configuration_missing`, with no cost.

After the parent wires and validates the bridge, these are the explicit foreground entry points:

```sh
npm run build
npm run worker
npm run dispatch
```

`worker` connects to the configured Temporal namespace/task queue and runs a foreground worker. The worker and dispatcher retry their first Temporal connection (Temporal may still be starting) with doubling waits capped at 5 seconds until `SUPERVISOR_TEMPORAL_CONNECT_DEADLINE_MS` (default 120000, 1000 to 3600000), logging `temporal_connect_retry`; then they exit 1 with `{"code":"temporal_unavailable"}`. A stop signal during the wait exits at once (`temporal_connect_stopped`). `dispatch` claims one bounded outbox batch and exits; a deployment-owned scheduler can invoke it. No daemon, scheduler, infrastructure or deployment is installed automatically. SDK operational logs are reduced to fixed codes/levels. CLI errors omit exception text and configuration values. Dispatcher summaries contain counts only; quarantine/failed/lease-lost batches exit 1. Worker shutdown follows Temporal's signal handling.

Boundedness: at most 16 checkpoints, five certified non-start attempts per checkpoint, 120 seconds per provider invocation, three Temporal activity retries, 16 host-authorized generations, and a 24-hour workflow execution limit. All actual attempts and reservations are durable in the host; workflow retries do not reset them. Defaults are four concurrent worker activities and ten concurrent outbox row deliveries. A duplicate provider permit is never reissued, even if the previous response was lost before the provider was called. This can deliberately leave work waiting for reconciliation.

Successful outcomes may include `usageBasis: { microUsd: 'reported' | 'reserved_ceiling', tokens: 'reported' | 'reserved_ceiling' }`. Numeric usage records budget consumption; unknown price or token counts consume the full corresponding reservation and are explicitly marked `reserved_ceiling`, never described as billed cost. The reducer rejects mismatched ceiling amounts. Raw provider telemetry retains its unknown values separately. See `BRIDGE.md` for the exact gateway contract and legacy compatibility.

### Optional OpenTelemetry

`src/telemetry.ts` (exported as `@course-core/supervisor/telemetry`, also used by the API) is the one place that loads the pinned official `@opentelemetry/*` SDK packages. It stays off, loads no SDK module and sends nothing unless standard variables name an endpoint (`OTEL_EXPORTER_OTLP_ENDPOINT` or the per-signal `..._TRACES_ENDPOINT`/`..._METRICS_ENDPOINT`); `OTEL_SDK_DISABLED=true` and `OTEL_{TRACES,METRICS}_EXPORTER=none` turn it off. Endpoints must be HTTPS or loopback HTTP without credentials or query; only OTLP/HTTP JSON is supported. Invalid settings stop `worker`/`dispatch` with `invalid_telemetry_configuration` and the variable name, and `check-config` reports `telemetry: off | configured_unverified`. Activity spans and run/checkpoint outcome metrics carry only allowlisted codes (role, checkpoint key, effect, state, reason); worker HTTP calls carry W3C `traceparent`; idle dispatcher polls are unsampled. See `deploy/local/README.md` for the full list and the privacy rules.

## Temporal sources consulted

Implementation was checked against the current official TypeScript documentation and SDK 1.24.0 types on 2026-10-12:

- [Testing and history replay](https://docs.temporal.io/develop/typescript/best-practices/testing-suite): local workers and replay API.
- [Activity timeouts, retry policies and heartbeats](https://docs.temporal.io/develop/typescript/activities/timeouts): bounded retries and heartbeat-delivered cancellation.
- [Workflow cancellation](https://docs.temporal.io/develop/typescript/workflows/cancellation): cooperative cancellation and cleanup.
- [TestWorkflowEnvironment](https://typescript.temporal.io/api/classes/testing.TestWorkflowEnvironment) and [DevServerConfig](https://typescript.temporal.io/api/interfaces/testing.DevServerConfig): isolated local server lifecycle and ephemeral ports.
- [Workflow identity/reuse policies](https://typescript.temporal.io/api/namespaces/common): reject duplicate closed IDs and fail duplicate active starts. Persistent host checkpoints still protect against replay after Temporal retention expires.
