# Combined supervised-flow acceptance

`supervised-flow.ts` qualifies the integrated learner/API/outbox/Temporal/gateway path. PostgreSQL, API HTTP sockets, the durable bridge, provider gateway, provider router, Temporal service/workers/activities, verifier and application transactions are real. Only the external model service is a deterministic loopback HTTP fake. Two acknowledgement losses are explicit fault injection after real durable work, not mocked database or activity results.

## Run

Prerequisites:

- Node 26 and installed API dependencies, including the Temporal TypeScript SDK 1.24.0 test/worker/client/activity packages.
- Built public SDK and local policy/providers/supervisor/sandbox dependencies required by the API. The supervisor root export must resolve to its built `dist` entry point; the qualification never falls back to sibling TypeScript workflow/activity sources.
- An explicit `TEST_DATABASE_URL` for a disposable **loopback PostgreSQL 17** database named `course_core_ci` or `course_core_test[_suffix]`. Application `DATABASE_URL` must be unset. Remote/socket URLs and connection-option overrides are rejected.
- The official Temporal SDK test-server download must work. No Docker, GPU, external provider credentials or production Temporal service are needed.

From `services/api`, with the test database environment already configured:

```sh
./node_modules/.bin/tsx qualification/supervised-flow.ts
```

Parent-owned npm/CI scripts can invoke that command. This gate does not edit package manifests, build other modules, create databases, install a daemon, or contact Google. Its only credential reader returns a synthetic canary to a trusted fake adapter; it never reads an actual provider key. Both configured and unconfigured gateway paths use the real API server registration.

The process creates a random schema inside the supplied database, applies the real migrations and checks migration replay. It starts the SDK-selected local Temporal server on random loopback ports with an in-memory Temporal database and no UI. It starts two real API listeners (configured fake provider and explicitly unconfigured) and a separate fake-provider HTTP listener, also on ephemeral loopback ports. A temporary directory holds the SDK test-server download and is deleted at teardown.

## Required scenarios

| Check | Combined assertions |
| --- | --- |
| Question to advisory reply | Real authentication/cookies/CSRF, course import/publication, learner enrollment, profile update and `POST /companion`; HTTP outbox claim/prepare/start/ack; actual built Temporal workflow and activities; HTTP gateway and generic provider router; external fake HTTP call; candidate persistence; separate advisory-boundary verifier; atomic assistant application; real learner `GET /companion` shows the linked job and reply. |
| Idempotence and recovery | Drop one successful Temporal start acknowledgement so real outbox delivery retries the same job/workflow ID. Drop one HTTP settlement response **after the API committed it**, stop the first worker, then create a fresh worker on the same task queue. The workflow completes from Temporal history and DB checkpoints with one provider submission, one candidate/application and one cost consumption. Rejecting a duplicate closed workflow start and replaying application preserve the original result. |
| Fresh profile fence | Hold the external fake response in flight, update profile through the actual learner API, then release the old result. The job is cancelled as stale, cost still settles conservatively, and no verification/application/assistant reply is produced from that stale output. |
| Missing configuration | A real unconfigured API gateway yields `waiting/configuration_missing`; learner reads expose that state, with no model call, candidate, assistant message or spend. |
| Zero budget | A configured fake gateway plus unconfigured shared ledgers yields `budget_wait/budget_exhausted`; no provider dispatch, fake answer or cost is created. |
| Scope isolation | Foreign-workspace and same-workspace other-learner history exists before the first generation. Unauthorized learner reads and a forged scoped gateway job are rejected. Each external fake request contains only its expected learner question/profile, never another enrollment's history, synthetic credentials or private answer-bank canaries. |
| Native history safety and replay | Fetch every workflow's native history, including background supervision jobs. Inspect string fields and decoded binary/base64 payload bytes for learner/profile, session/service/provider-secret, private-oracle and reply canaries. Replay every history with `Worker.runReplayHistory` using the same built bundle; replay must perform no new provider submissions. |

The canonical success/recovery/stale scenarios produce exactly three external fake calls altogether. Missing-configuration and zero-budget scenarios produce none. Workspace and enrollment ledgers are checked independently, as are durable `provider_dispatches` rows. Provider telemetry keeps `cost:null`; successful accounting retains the configured maximum with `usageBasis.microUsd='reserved_ceiling'` and reported token counts. That maximum is never described as an invoice or known billed cost.

The qualification checks for zero evidence, assessment attempts, extension grants and completed/placed episodes after each companion scenario. Its verifier establishes an advisory format/scope/publication boundary, **not factual correctness, grading, mastery or permission to activate a course adaptation**. The script calls the parent server's real verifier implementation; the external fake provider cannot approve itself.

## Pass, failure and cleanup

Each completed check emits a fixed, structured progress record. Only the final `status:'passed'` record and exit code zero establish combined acceptance. It reports scenario counts, external fake-call count, worker restart count, injected acknowledgement losses, replayed histories, decoded payload count, and cleanup completion. Dependency/server/database failures and unmet assertions fail the gate; nothing is skipped or converted to fake success.

Errors print only a fixed phase/checkpoint code and completed-check names. SDK worker/bundler logs are suppressed as in the existing Temporal integration suite; the local test server uses error-level logging. Raw HTTP bodies, prompts, learner text, credentials, usage receipts and exception stacks are not printed by this script. All canaries are synthetic and remain only in the disposable schema/process memory. Cleanup releases blocked fake responses, stops workers, closes HTTP listeners, tears down Temporal, closes pools, drops only the schema it created and removes temporary files. Cleanup failures are reported separately and fail acceptance even when another failure already occurred.

Useful failure codes:

- `built_supervisor_required` / `qualification_dependency_or_runtime_failure`: build or install the parent-owned prerequisites; no source fallback is attempted.
- `success_outbox_deferred` / `companion_job_not_prepared`: inspect the parent API's emitted companion event versus the host preparation contract. In particular, optional `blockId:null` and `downgradedChallengeIds` must be reconciled by the owning API code, not rewritten by this gate.
- `unexpected_workflow_result`: inspect the real host/gateway state locally; the gate does not dump payloads.
- `recovery_reinvoked_provider` / `budget_not_consumed_once`: duplicate submission or accounting regression.
- `native_history_contains_canary`: private text or a synthetic secret crossed the durable-history boundary.

A pass establishes this local combined system with a synthetic external provider. It does not establish Google access, paid inference, factual-answer quality, production deployment, browser rendering or crash recovery after an operating-system/process kill. Recovery here uses a fresh Temporal Worker after the prior worker stops at a lost settlement acknowledgement; both workers share the real temporary Temporal server and Postgres schema.

## Observed qualification

The combined gate passed after repairing the real event envelope and replacing JSON-string-order equality with semantic deep equality (PostgreSQL JSONB may reorder object keys). Seven checks passed with three external synthetic calls, one worker restart, one lost start acknowledgement, one lost settlement acknowledgement, nineteen replayed native histories and282 decoded payloads. Cleanup completed. No live provider or earned-credit claim is made.
