# Host API transaction bridge, version 1

This directory implements orchestration, contracts, and clients. The Postgres implementation is now in `services/api/src/supervisor-bridge.ts`, with migration `services/api/migrations/004_supervisor_runtime.sql`. The parent owns route registration, provider composition, independent validators, and learner/admin UI. There is **no production in-memory fallback**. The supervisor unit-test host remains a fixture; the API integration suite uses real PostgreSQL.

## Transport and ownership

`HttpHostBridge` sends authenticated JSON POSTs to `<SUPERVISOR_HOST_URL>/v1/supervisor/bridge`. The URL is a base path, with a trailing slash added. No redirects, automatic transport retries, raw error bodies, or URL credentials are allowed. HTTPS is required except for loopback. Requests and responses are strict Zod schemas in `src/contracts.ts`; `HostBridge` is in `src/bridge.ts`.

The host authenticates a dedicated service principal, scopes it to authorized workspaces, and applies enrollment/job ownership checks on every method. A UUID or worker-supplied fence is not authorization. Do not expose this internal bridge, service credentials, operation ownership tokens, or verification receipts to learner clients. The host resolves `inputRef` and `artifactId` only within the referenced workspace/enrollment and immutable course release. Neither reference may be an executable module, path, arbitrary fetch URL, bearer token, or learner secret.

| Request `method` | Request fields beyond method | Response schema | Transaction requirements |
| --- | --- | --- | --- |
| `load` | `ref: RunRef` | `snapshotSchema` | Authorized consistent snapshot; validate all key fields and generation. |
| `transition` | `command: Command` | `transitionSchema` | Lock job plus enrollment, relevant policy/ledger and cancellation state; execute reducer; persist all state before returning. |
| `outbox.claim` | `ownerId`, `limit` (1–100), `leaseMs` (30–300 seconds) | `leasesSchema` | Claim available `supervisor.event` rows with `FOR UPDATE SKIP LOCKED`; increment delivery attempt and issue a fresh opaque lease token. |
| `outbox.prepare` | `eventId`, `leaseToken` | `{ jobs: RunRef[] }` | Validate current lease, resolve actual learning event and enrollment, create bounded specs/jobs once; repeat deliveries return the same refs in the same order. |
| `outbox.ack` | `eventId`, `leaseToken` | `{ accepted: boolean }` | CAS current unexpired lease; set delivered timestamp only for that lease. Already acknowledged same token may return true; obsolete token returns false. |
| `outbox.nack` | `eventId`, `leaseToken`, `code`, `delayMs`, `quarantine` | `{ accepted: boolean }` | CAS lease; set next availability or durable quarantine, clear claim. Never mark an unsuccessful delivery as delivered. |

Do not reuse the input learning event payload as a job specification. Current `events.ts` emits exactly `{ eventId, enrollmentId }`; `outbox.prepare` must join trusted server state and author a versioned specification. Ignore agent-generated completion events for automatic resupervision unless an explicitly bounded host policy calls for another job; avoid feedback loops. A valid event may prepare zero jobs when host policy explicitly records a no-op receipt. Corrupt envelopes must be quarantined by the host before claim; they must never be silently acknowledged.

## Required persistence and migration mapping

Existing `supervisor_jobs` states are preserved: `queued`, `running`, `waiting`, `verifying`, `ready`, `applied`, `failed`, `cancelled`, `budget_wait`. The more precise machine-readable `reason` lives in the snapshot; it is not free-form provider text. Configuration/capability/uncertainty waits and budget waits complete the current Temporal generation. They do not keep an unbounded polling workflow alive.

Migration 004 implements this contract. It adds `supervisor_jobs.workspace_id`, `runtime_snapshot` and `cancellation_requested`; `runtime_snapshot` stores the full strict `Snapshot` including operation IDs, ownership, attempts, reservations, outcomes and receipts. It also adds scoped foreign keys, preparation/application receipts, input/artifact/verification tables, two shared spend ledgers, job spend accounting, and outbox lease/quarantine columns. The invariants are:

- The complete `Snapshot`: immutable `JobSpec`, version, generation, reason, logical operations, reservations/outcomes, verification and application receipt identifiers. Existing `specification` can contain `JobSpec`; existing `result` can contain versioned state, or a new snapshot column can be used. Keep the SQL `state` synchronized atomically. `expected_revision` maps to `fence.enrollmentRevision`. Profile, policy, ledger revisions and course digest are also mandatory fences.
- Unique job preparation receipt per input event and policy-selected role/checkpoint plan; immutable mapping to its jobs. Uniqueness for workflow ID and job generation. Re-delivery, lost preparation acknowledgements and expired Temporal history must never recreate/reset a logical job.
- Unique operation `(job_id, checkpoint_id)` with stable ID `<job UUID>/<checkpoint key>`, attempt counter, owner token, reservation, outcome and output reference. Never include activity attempt number, workflow run ID, dispatcher lease, or generation in this operation ID.
- Atomic enrollment/workspace/course budget reservations in the host's authoritative ledger. The pure reducer enforces the per-job cap; concurrent jobs and newly prepared jobs require shared ledger limits in the same transaction. Reserve maximum tokens/cost **before** authorizing a call, release only on a certified non-start, settle known usage once, and retain the full reservation for uncertain/in-flight work. Shared ledger exhaustion returns `budget_wait/budget_exhausted` without a permit. Extensions require the existing server policy, explicit consent/grant receipts and ledger transaction rules; model output cannot authorize more budget or progression.
- Outbox lease tokens or equivalent fencing generations, plus a durable quarantine state. The initial `claimed_until` timestamp by itself does not implement the required lease CAS. Index available unclaimed/unquarantined supervisor events. Bound failed deliveries (default eight); an expired lease is reclaimable. Include quarantine in operational visibility.
- Application receipt unique per logical job, and event/outbox/authorized proposal application committed in the same transaction. Replay returns the original receipt with no duplicate event, companion message or course mutation. This receipt is separate from mastery/evidence receipts.

Use host database time for `HostContext.nowMs`. At admission cap deadline to at most 24 hours from creation and validate all integer/range limits; Temporal also has a 24-hour execution limit. Use a separate operational spend ledger revision for provider reservations; these must not advance the policy/evidence ledger revision in the immutable job fence. Likewise, do not advance enrollment content revision merely for job status updates. Actual learner/profile/policy/course changes must fence the job. Never rewrite a job's immutable specification to hide a revision mismatch.

The host also requires the enrollment owner's current workspace membership. `current()` locks the enrollment and then selects that user's membership `FOR SHARE`, so deletion and admission/application serialize; the current membership schema represents removal by deleting the row. Revocation transactions that also mutate enrollment state must use the same enrollment-then-membership lock order. Missing membership makes new preparation an `inactive` no-op and causes subsequent permit/application transitions to cancel with `inactive_enrollment`. Fresh gateway input/operation resolution and verification-receipt creation also reject removed members. Already-issued operation owners can still stage completed artifacts and settle/replay their usage receipts after removal, including retained unknown-cost ceilings; this does not authorize a new call, verification or publication. Service-scoped job reads remain available for bookkeeping. Login sessions are deliberately not consulted: signing out or revoking a session alone does not cancel authorized background supervision.

## Transaction pseudocode

For a `transition` command:

1. Authenticate service principal; validate `jobCommandSchema`; lock job and scoped authoritative rows in a consistent order. Validate job key, dispatch generation and snapshot version under the lock.
2. Construct `HostContext` from current rows: active enrollment, current fence, committed cancellation flag, DB time, and `availableBudget` (remaining shared provider tokens/cost under ledger lock). Never take these fields from the request or provider.
3. For `verify`, load trusted validation results for every exact output artifact ID/digest and this job/fence. Validate required provenance/source checks, rendering/content safety, policy bounds and course-specific constraints outside an application mutation; then recheck the receipt/fence under the transaction lock. A model cannot self-attest verification. Supply `HostContext.verification` only after server-side validation. Otherwise the reducer returns `verifying/verification_required`.
4. For `apply`, first check cancellation, deadline, fence, `ready` state and the bound verified receipt under the lock. If already applied, return the original snapshot. Use server authorization/policy to apply only the allowed proposal in the same transaction, create a unique application receipt, append its event/outbox rows, and supply `applicationReceiptId` to the reducer. Roll back all effects if any check or reducer validation fails. Application cannot set objective mastery, completion credit, evidence validity or extension consent from model output. Those remain the existing evidence and policy transaction paths.
5. Run `transition(snapshot, command, context)`, update shared budget accounting by the delta if applicable, persist the returned snapshot/SQL state and receipts, and commit. Return the **committed** transition.

`claim` has special delivery semantics: an `invoke` effect is a **single-use dispatch permit**. Never cache and replay an `invoke` response. Never retry an HTTP `claim` transparently. The durable record is changed to `in_flight` before the response; any repeated claim, including the same owner token, returns `provider_uncertain` and no permit. An activity lost between commit and provider call may therefore require reconciliation even if nothing was charged. This conservative loss of availability is intentional.

Only the original operation owner may settle it. A duplicate identical settlement is idempotent; a conflicting known settlement fails. A late known settlement can replace an uncertain outcome, including settling cost after cancellation, but cannot revive a terminal job or apply stale content. A newer dispatch generation rejects old-generation writes. Keep retained reservations until a trusted reconciliation path confirms the actual outcome; an old-generation receipt may be reconciled by an authorized host transaction against the **current** generation and original operation owner. Never release ambiguous cost on a timer.

## Cancellation, resumption and reconciliation

Persist the cancellation flag before calling Temporal `handle.cancel()`. A native cancel is also caught by the workflow, which makes a non-cancellable, bounded host cleanup activity. Cleanup normally completes the Temporal execution with a `cancelled` summary. A provider may continue remote work after an abort; retained reservation covers that uncertain outcome. Worker shutdown or a missing heartbeat can trigger an activity retry, but a durable in-flight operation blocks duplicate invocation.

To resume a nonterminal configuration/capability/verification wait, the host first confirms the preceding Temporal generation has closed (or cancels and observes it closed), validates the unchanged fence/deadline, increments generation under lock (hard cap 16), and emits a new outbox preparation receipt referencing the existing job. Preserve operations, attempt counts, reservations and all immutable specification fields. Do not resume `applied`, `failed`, `cancelled`, or a stale job. Budget/policy/profile/content changes normally require a newly authorized job at the current revisions, subject to the shared ledger. A durable `provider_uncertain` operation does not resubmit merely because generation advanced.

Reconcile uncertainty with provider operation lookup/receipts or authorized human review. This module intentionally does not guess provider idempotency support or perform billable retries to discover an outcome. The host can settle a confirmed original outcome using the same operation ID/owner; ambiguous work stays reserved. Host watchdog/reconciliation is required for hard workflow termination, workflow timeout, a persistently unavailable bridge, or operators deleting Temporal histories. No client can guarantee recording a final state while its authoritative storage is unavailable.

## Neutral provider gateway

`ProviderGateway` may be implemented in a trusted server composition layer around the separately owned providers package; this module does not import or edit that package. The CLI optionally uses an HTTP gateway:

- `GET <SUPERVISOR_PROVIDER_URL>/v1/capabilities` returns all four keys (`supervisor`, `companion`, `research`, `media`), each with exactly `{ status: 'ready' | 'configuration_missing' | 'capability_missing' }`. `ready` describes configured support, not a verified live call.
- `POST <SUPERVISOR_PROVIDER_URL>/v1/operations` accepts `providerRequestSchema` and an `Idempotency-Key` equal to the stable logical operation ID. It returns `outcomeSchema`: success with an opaque artifact reference/digest, numeric budget consumption and optional `usageBasis`; certified `not_started` with retryability; or `uncertain`. A gateway may certify `not_started` after sending only when the provider refused every attempt with a documented rejection status (see `definiteRejection` in the providers package); a retryable rate-limit refusal may add `retryAfterMs` (an integer of at most 600000), and the workflow waits at least that long before the next attempt. Timeouts, resets, 5xx and overload responses remain `uncertain`. A repeat with the same `Idempotency-Key` and an identical body replays the recorded outcome (`uncertain` while the original dispatch is still running) without a provider call or budget change, including after the job ended, so the owning activity can settle it; the same key with a different body is `409`. A first request for an ended job (cancelled, failed, applied, past its deadline, fenced out, inactive or policy-blocked) for which the gateway never recorded a dispatch is answered with a certified `not_started` with `retryable: false`: nothing was sent and nothing may be. The gateway records that answer as the operation's dispatch receipt under the same per-operation lock that admits a dispatch, and only when no receipt exists for the identity, so it cannot release the reservation of a dispatch that was admitted first (that request is answered from its own receipt: `uncertain` while running, then its final outcome). The receipt also stops any later admission of the operation by its owner, so the certificate stays true if the job's fence or membership briefly recovers. The activity settles the refusal and the ledger releases the reservation once; repeats replay the same receipt. The request must still match the job's stored operation, checkpoint, role and fence (`409 SUPERVISOR_OPERATION_MISMATCH` otherwise), and an operation the snapshot already records as succeeded is refused.
- Data erasure keeps a dispatch receipt's outcome (status, retryability, artifact ID/digest, usage and its basis: references and numbers only) and its usage/cost columns for settlement and spend audit, and removes the generated candidate. It also clears the job snapshot, so after erasure the bridge cannot settle any more. Before clearing it, erasure finishes every open reservation of the enrollment in the same transaction (taking each operation's gateway lock before the enrollment lock): an attempt the gateway never admitted is released and gets a certified `not_started` receipt (`failure_code` `ENROLLMENT_ERASED`, keyed to the exact request the activity sends), a certified refusal is released, a completed receipt is settled at its recorded usage, an admitted dispatch that has not yet passed the gateway's last fence is released and its receipt becomes the same certified refusal, and a call that may have been sent (in flight past that fence, or uncertain) is closed at its full reservation (ledger `uncertain`, settled). The gateway records that a dispatch may be sent (`sent_at`, migration 042) in the same transaction and under the same enrollment lock as its last fence check, so erasure never charges a call that was never sent and never releases one that may have been. A repeated or first gateway request then replays the receipt; a response that arrives after erasure is recorded without its generated candidate and moves no money. A receipt erased before this rule (outcome cleared) replays as `uncertain`, which keeps the reservation held.
- The trusted gateway enforces operation deduplication, budgets/timeouts and cancellation; performs no hidden SDK/provider retries; maps credentials server-side; resolves only authorized minimized input references; and stores candidate artifacts as unverified. Same-operation retries are permitted only after a definitive non-start with zero billable work. If the provider/gateway cannot guarantee this, return `uncertain`.
- An HTTP error (including 429), malformed body, thrown exception or timeout is uncertain. HTTP status alone never proves zero cost. Artifact existence and digest must be verified by the host. The gateway cannot approve its own generated content or return mastery/progression commands.

No source execution, tool-code evaluation, model-generated plugins, arbitrary remote imports, raw learner prompts, credentials or chain-of-thought logging are supported. Trusted gateway implementations remain responsible for not logging raw request/response content. Temporal histories contain only IDs, bounded specifications, usage, state, and validation receipts; production access control and retention still apply to those identifiers.

## Implemented API registration and server configuration

The parent registers the route explicitly; this module never reads environment credentials, starts a daemon or invokes a model:

```ts
import { registerSupervisorBridge } from './supervisor-bridge.js';

registerSupervisorBridge(app, db, {
  ...(process.env.SUPERVISOR_SERVICE_TOKEN
    ? { serviceToken: process.env.SUPERVISOR_SERVICE_TOKEN }
    : {}),
  workspaceIds: authorizedServiceWorkspaceIds,
  jobPolicy: {
    allowance: { microUsd: 100_000, tokens: 10_000 },
    durationMs: 300_000,
    timeoutMs: 60_000,
    maxAttempts: 3,
  },
  maxOutboxAttempts: 8,
});
```

The worker's `SUPERVISOR_HOST_TOKEN` must contain the same token. `serviceToken` absent/empty yields HTTP 503 `SUPERVISOR_UNCONFIGURED`; bearer mismatch yields 401. Authentication compares SHA-256 digests with `timingSafeEqual`; cookie/session authentication does not grant access. `workspaceIds` is an explicit service allowlist: absent/empty authorizes no workspaces. Parent gateway routes using the same token must enforce the same allowlist before calling storage hooks. Malformed bridge requests fail strict schemas; errors return fixed codes without DB/provider/credential details. No budgets, verifications, arbitrary snapshots, or job specs can be supplied through this HTTP route.

`SupervisorBridgeOptions.beforeVerify?: (ref: RunRef) => Promise<void>` is an optional **trusted server-composed callback**. Only RPC `transition` with `type:'verify'` invokes it. Registration first calls `bridge.load(ref)` to authorize all scoped keys/generation, then awaits the callback outside that read transaction, and finally calls the normal transactional `bridge.transition` to reread fences, deadlines, artifacts and stored verifier authority. Unauthorized/malformed requests never reach the callback. The callback receives only `ref`; no caller content or verdict flag is passed. It may run an independent validator and use `recordSupervisorVerification`, or return without a decision so the job remains `verification_required`. The absent default performs no validation or approval. Direct `HostBridge.transition` calls do not invoke this registration hook. Callback implementations must be idempotent and must define what their verification establishes: the initial companion format/scope/publication-boundary verifier does **not** certify factual truth or mastery; adaptations require stronger review and stay waiting until that review has a stored receipt.

`jobPolicy` contains server-selected upper bounds, not shared spend authorization. Positive per-job allowances are required; shared workspace and enrollment ledgers both start at zero. The trusted admin integration calls `configureSupervisorBudget(db, {workspaceId, enrollmentId?}, {microUsd, tokens})` after staff authorization to configure each ledger separately. It changes limits without resetting usage. Both limits and per-job limits must permit a reservation. Uncertainty retains maximum reserved usage; a staged artifact prevents a contradictory `not_started` settlement. Actual provider overruns are recorded as consumed cost and block later calls rather than being hidden by a SQL limit constraint. Provider bookkeeping never increments policy/evidence ledger revisions.

Preparation creates one `generate` checkpoint per job. `companion.requested` creates `role='companion'`; other eligible learning events create `role='supervisor'`. The mapping is server-owned, and unique `(input_event_id, role)` plus `supervisor_preparations` ensures stable replay. Research/media remain supported by the neutral engine but are not automatically admitted by this first host policy. Agent events, inactive enrollments and policy-denied admissions receive durable no-op preparation receipts. Companion events must contain exactly `{messageId, episodeId, blockId?, requestKind:'question'}` and reference a learner message belonging to the same enrollment. Preparation obtains the fence from freshly locked DB rows **after** the event; it does not copy a revision from an earlier context or event payload. Job deadlines also respect the authoritative policy scope deadline.

Companion preparation also links that existing learner message's `job_id` to the new job in the same transaction as the job, input and preparation receipt. The update requires the exact message/enrollment, `role='learner'`, and a null or already-matching job ID; a different job link aborts preparation. Duplicate preparation preserves the original link and job state. Thus the learner read path can join queued/waiting/configuration-missing/failed status before any assistant reply exists. Receipt-storage failure rolls the link back with the job.

## Gateway and verifier storage hooks

These exported functions are **trusted server composition hooks**, not public routes. Parent code authenticates and authorizes the caller before invoking them. In particular, provider code must not acquire verifier/admin authority merely because it can stage an artifact.

| Export | Input / return | Purpose |
| --- | --- | --- |
| `createPostgresSupervisorBridge(db, options)` | Returns the existing `HostBridge` interface | Transactional implementation for direct server use/testing. |
| `resolveSupervisorOperation(db, request)` | Validated `ProviderRequest` → `{ref, ownerId, operationStatus, outcome, input}` | Resolves generation/owner absent from the neutral wire request. Checks the complete stored checkpoint, role, fence, scope and current policy. It is **not** another provider dispatch permit. |
| `loadSupervisorInput(db, ref, inputRef)` | `RunRef`, input UUID → `{fence, context}` | Reads the scoped, fresh server-held reference context. |
| `storeSupervisorArtifact(db, ref, operationId, ownerId, content)` | Strict content union below → `{artifactId, digest}` | Immutable, idempotent artifact staging; computes the canonical JSON SHA-256 digest server-side. Same operation/content replays the original ID; conflicting content fails. |
| `recordSupervisorVerification(db, ref, verifierId, verdict)` | Authenticated trusted verifier identity; `'verified'` or `'rejected'` → receipt UUID | Records the result of an **independent authoritative validation/review**. Requires an enabled workspace-scoped verifier registry entry. Do not call this based on a model's pass flag or provider success alone. |
| `configureSupervisorBudget(db, scope, limits)` | Admin-authorized scope and cap | Changes limits, never consumed/reserved usage. No worker/gateway endpoint exposes this hook. |

`ProviderRequest` already includes `job`, `operationId`, `checkpoint`, `fence` and `role`, but not generation or dispatch owner. Use `resolveSupervisorOperation` to get `ref`/`ownerId` for artifact storage; do not invent either. An `uncertain` operation is for reconciliation only, a completed outcome is for replay, and a `not_started` operation is not a new invocation permit. A gateway must still implement durable submission deduplication keyed by logical operation ID/current authorized owner, disable hidden provider retries, and hold uncertainty after an ambiguous provider response. Merely resolving an `in_flight` row does not entitle multiple concurrent HTTP handlers to submit the same billable operation. The worker bridge does not make provider calls or implement the gateway's submission transport.

Gateway input shape (plain IDs and course/lesson references, no prompt text):

```ts
{
  fence: { enrollmentRevision, profileRevision, policyRevision, ledgerRevision, courseDigest },
  context: {
    kind: 'learning_event',
    eventId, eventType, courseReleaseId,
    episodeId: string | null,
    messageId?: string, // companion.requested only
    blockId?: string,
  }
}
```

The parent gateway resolves `messageId` using `companion_messages.id + enrollment_id + role='learner'`, and builds its minimized prompt from authorized DB/course records at these revisions. Do not log that prompt, raw learner data, credentials, or chain-of-thought. The input table's columns are `id`, `job_id`, `enrollment_id`, `workspace_id`, `checkpoint_id`, `fence`, `context`; scope is protected by a composite FK to the job. The gateway must not treat any stored course/learner/model text as executable code.

Artifact content is exactly one of:

```ts
{ kind: 'companion_message', text: string }       // companion job, 1–16000 chars
{ kind: 'proposed_adaptation', summary: string } // supervisor job, 1–16000 chars
```

No `mastery`, `passed`, score, grading mutation, tool script, raw provider response, or reasoning field is accepted. Text is inert data and must be rendered as text by consumers. The artifact table contains `id`, `job_id`, `enrollment_id`, `workspace_id`, `operation_id`, `owner_id`, `digest`, `content`, `created_at`; `operation_id` is unique. Staging alone does not create an assistant message, publish an adaptation or grant credit. The gateway returns the saved `{artifactId,digest}` plus budget consumption and its basis in the existing `Outcome`; the worker then performs its normal `settle` transition.

### Reported usage versus reserved ceilings

Successful outcomes accept this optional, strict metadata (both dimensions are required when present):

```ts
usageBasis?: {
  microUsd: 'reported' | 'reserved_ceiling';
  tokens: 'reported' | 'reserved_ceiling';
}
```

`usage` is numeric **budget consumption**, not an invoice. For a known result with unknown price (`UsageReceipt.cost === null`), set `usage.microUsd` to the operation's full reserved `microUsd` and mark `usageBasis.microUsd='reserved_ceiling'`. If tokens are unknown, do the same for tokens; if tokens are reported, preserve that count and mark tokens `'reported'`. Each dimension is independent. The reducer rejects a `reserved_ceiling` value that differs from that operation's persisted reservation, before changing any accounting, including on a late/cancelled settlement. Success does not release an unknown charge merely because an output exists. Full-ceiling consumption is retained through persistence, replay and application. An ambiguous operation outcome still uses `status:'uncertain'` and retains both reservations.

`reported` denotes a reported measurement, not independently verified billing. Never relabel a configured ceiling as actual billed cost. Gateway telemetry keeps the original provider usage separately, with `cost:null` and any unknown token count still unknown; do not overwrite that receipt with these conservative numeric ledger values. No telemetry or billing fields are added to the artifact payload. The optional field preserves legacy/synthetic fixtures and old history; omission means **unspecified legacy basis**, not proof of a reported price or permission to use zero for an unknown charge. New gateway outcomes should include the basis explicitly. A conflicting settlement cannot replace a completed ceiling with a cheaper number or relabel it; any later authoritative billing reconciliation needs a separate audited host path.

The trusted verifier registry `supervisor_verifier_authorities` holds `{id, workspace_id, label, enabled, can_verify_companion, can_review_adaptation}`. It is empty initially. An independently authenticated validator/reviewer uses `recordSupervisorVerification` only after completing required source/content/course checks. `supervisor_verifications` binds the verifier to the job, workspace, enrollment, current fence, exact artifact IDs/hashes, verdict and application kind. Verification and application reread the authority, revocation status and artifact hash under DB locks. Missing receipts remain `verifying/verification_required`; revocation or mismatches prevent application. This module does not itself implement content validation or automatically create verifier authority.

Verified companion application inserts one `companion_messages` assistant row. Verified adaptation application inserts one `supervisor_adaptations` row with state `reviewed_proposal`; it never rewrites course bundles, evidence, mastery, learner credit, extension grants or policy. Further activation remains a separate authorized transaction owned by the parent. `supervisor_applications` persists a unique logical-job receipt, target ID and event ID. The message/proposal, receipt, `supervisor.applied` event, corresponding non-recursive `outbox.kind='supervisor.applied'` row and snapshot commit together. The current dispatcher claims only `supervisor.event`; parent subscribers own delivery of `supervisor.applied`.

## Verification and remaining integration boundaries

`services/api/test/supervisor-bridge.integration.test.ts` requires `TEST_DATABASE_URL`, rejects application/remote/socket database URLs, creates a unique schema, applies real migrations, and drops that schema in teardown. Tests cover concurrent SKIP LOCKED claims, lease reclaim/CAS, repeated preparation/application, tenant/identity isolation, both shared-budget races, zero defaults, uncertainty accounting, current fences, post-event policy revision changes, verifier/hash checks, deadline lock waits and transaction failures after partial writes. No database mocks are used.

Route registration, gateway HTTP endpoints, gateway submission deduplication, provider credentials, actual validators/reviewers, budget administration, an authorized generation-resume/reconciliation API, operational supervision and deployment remain parent integrations. This implementation supplies no live-provider or deployment acceptance claim. Legacy jobs without `runtime_snapshot` are not guessed or automatically resumed; bridge load returns `SUPERVISOR_NOT_FOUND` for them until explicitly migrated/reconciled.
