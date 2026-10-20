# Workspace provider setup

This implementation is under qualification. Local synthetic-provider and browser
results do not establish live Google acceptance or deployment.

The operator surface separates public model/role configuration, encrypted
credentials, per-job admission limits, and workspace/enrollment paid-work budgets.
Saving configuration grants no budget and performs no model call. Google and
trusted server-registered adapters use the same neutral capability ports. A
configuration cannot load code, choose arbitrary environment variables, or claim
that configured capabilities have been verified live.

## Credential boundary

Only workspace owners/administrators can access setup. Cookie authentication,
origin validation, CSRF and parameterized scoped queries govern all mutations.
Credential fields have no readback endpoint. Public configuration rejects secret
field names and known credential values; native adapters validate their own public
protocol configuration. Requests, raw errors and credential values are not logged.
The browser retains secret drafts and uncertain request payloads only in the
mounted panel; account/workspace changes discard them. Retrying an uncertain
write reuses its original request identity rather than creating another change.

The local vault uses a host-created, owner-only 32-byte key and authenticated
AES-256-GCM ciphertext with workspace, revision and binding identity as additional
authenticated data. Every encryption uses a fresh 12-byte nonce. Its directory is
0700; its regular, single-link key file is 0600. Symlinks, corrupt keys and unsafe
permissions fail closed. The key is separate from database rows and must be
preserved by an authorized deployment backup/restore. No key or credentials are
part of public release assets. A production distributed deployment must provide
shared managed key custody; the local implementation is not an HA key service.

This server-side boundary follows [Google's API-key guidance](https://ai.google.dev/gemini-api/docs/api-key).
Model discovery should use actual [model metadata](https://ai.google.dev/api/models),
not infer support from a model name. Guided setup now uses bounded, scoped metadata inspection and reviewed role drafts. Metadata is explicitly separate from live generation verification.

## Configuration and admission

Each workspace has immutable configuration versions and an authenticated current
revision. Provider credentials are re-sealed with the new revision's identity.
Jobs bind the exact version and per-job allowance during actual outbox preparation;
configuration changes mark unfinished jobs for cancellation. Already sent calls
retain their receipt and cost settlement, and completed gateway receipts remain
retrievable after a replacement. Scope-specific capability lookup avoids treating
another workspace's configured provider as this workspace's service.

Binding serializes with configuration writes. Admission rechecks wall clock after
that wait. Current settings, role readiness and budget metadata are projected for
the selected workspace, using the existing SQL transaction where available.
Conservative token bounds include every configured tool round; an undersized job
allowance is rejected before a configuration can be activated. This does not
silently enlarge a shared paid-work budget.

Mutations have HMAC-protected canonical request digests and durable receipts.
Concurrent equivalent retries produce one version. Different requests under one
ID conflict. Receipts identify the operator and operation without retaining raw
credentials. Source interface `CredentialVault` supports trusted alternative host
implementations; public course data cannot supply a vault or adapter factory.

### Agent eval gate

A new or changed revision of an evaluated role (today: the companion and the
supervisor's plan strategy) activates only with a passing agent evaluation of that
exact revision, or an owner's recorded override; otherwise saving is refused with
`409 PROVIDER_EVAL_REQUIRED` and nothing changes. Versions saved before migration
083 stay active and show as not evaluated. See [AGENT_EVALS.md](AGENT_EVALS.md).

## Paid-work budgets

Budgets default to zero. Both workspace and enrollment ledgers must have room
before a call. Positive budget changes require explicit paid-work approval and
compare-and-swap revisions. Changes preserve existing usage/reservations and
cannot lower limits beneath them. These are application accounting allowances,
not a provider invoice or guaranteed external billing cap. Configuration and
budget changes do not alter learning deadlines, assessments, mastery or work caps.

The local launcher supplies `PROVIDER_VAULT_DIRECTORY` only to the API. Workers
use authenticated HTTP capability/operation interfaces; they receive no vault
key or provider credential. No live provider key or paid allowance has been set
by implementation tests.

## Generated media jobs

A `media` role with `mediaKind: "video"` may carry an operator-reviewed rate card,
`pricing: { microUsdPerOutputSecond, source, reviewedAt }`. The estimate is the
configured clip duration times that rate. Without a rate card a media job is refused
before anything is created or charged. Admission also needs the estimate to fit the
per-job allowance (`jobPolicy.allowance.microUsd`) and both paid-work budgets to have
room for that full allowance, which is charged at admission. An operator price version
for the video model (per output second and/or per request, see below) takes precedence
over the rate card. With a price version, a clip that completes is charged its
estimate and the rest of the allowance is released once; with only the rate card the
full allowance stays charged. A job whose provider call certainly never ran gives the
whole allowance back (ledger `not_started`, no actual cost): cancelled or past its
deadline before submission, refused before the request left the host, or refused by
the provider with a documented rejection status on every attempt (400, 401, 402, 403,
404, 413, or 429 once its bounded retries are used up; the rule is `definiteRejection`
in `@course-core/providers`, shared with the provider gateway). A job cancelled while
its submission was in flight is released only if that submission then comes back as
such a refusal. Everything that may have run keeps the full allowance: an unknown
outcome, a timeout, 408, 409, 5xx, 529, an undocumented or unrecorded refusal, a
refusal after a retry hit a server error, a worker crash after recording the
submission, and any failure or cancellation once the provider accepted the job (the
provider may still bill it).
The ledger row of such a job does not stay `reserved` (in flight) once the job ends.
It is closed: `uncertain` and settled at its reservation when the provider may have run
and billed it (a provider-reported failure, an invalid answer, the poll limit, the
deadline, or a cancellation after submission), or `unpriced` and settled when the
provider reported the render complete but the clip was unusable (not a video, or over
the size limit). Both keep the full allowance charged, and a closed row is never
settled or released again (the same closed state erasure uses). An `uncertain` row
stays open (no `settled_at`) only while a result can still arrive: a job polling an
uncertain submission, or a job cancelled while its submission was in flight until
that submission returns. The spend view's `held` counts open rows only.

Jobs are durable rows (`media_jobs`, migration 035) driven by a leased worker pass
(`MEDIA_JOB_INTERVAL_MS`, default 15 s, only when the provider vault is configured).
Each provider step starts with a fresh lease (default 300 s). Because a poll step can
make two provider calls in a row (status, then download), the service refuses to start
unless the lease is at least twice the provider call timeout (default 120 s) plus a
30 s margin; otherwise another worker could take a job whose call is still running.
A rate-limited submission is retried as the same job, no sooner than the provider's
`Retry-After` (capped at 10 minutes), at most three attempts in all. A submission
whose outcome is unknown becomes `uncertain`: the worker polls the stored
provider operation and never submits again; without an operation id it waits until the
job deadline and fails as `MEDIA_OUTCOME_UNKNOWN`. Completed clips are downloaded only
from the model's approved hosts, bounded in size, checked for an MP4/WebM container
and stored with a SHA-256. Nothing is learner-visible until staff approve it with
WebVTT captions, a transcript and a visual description, and then attach it to one
enrollment's episode; attachment re-checks the enrollment's current policy and
expires or can be revoked. Live Veo generation and download have not been verified.

## Model pricing and cost reconciliation

Prices are operator data. There is no built-in vendor price list: an owner or
administrator enters, per configured model, an input and output price per million
tokens (optionally a cached-input price), a per-request price and, for generated
media, a price per output second, with an effective time and a source note
(Providers > Model prices). Money is integer micro-USD throughout; only USD is
accepted because the paid-work budgets are kept in micro-USD. Versions are
append-only (`provider_model_prices`, migration 039): the version in force is the
newest one whose effective time has passed. A new version cannot take effect
before the one it replaces, and a withdrawal makes the model unpriced again.

The gateway prices a call from the usage the provider reported, using the version
in force at admission, and records that version on the dispatch and on the receipt
(`UsageReceipt.cost`). Cached input tokens use the cached price (or the input price
when none is set); thinking tokens count as output; tool-use prompt tokens count as
input; a reported total above those parts is charged at the output price. Token
cost is rounded up once per call to a whole micro-USD. A rejected attempt is free.
If any attempt's outcome or token count is unknown, the receipt stays unpriced.

**Server tool requests.** A price version may also carry a per-request price for
provider-run server tools (Providers > Model prices, "Price per web search";
`micro_usd_per_server_tool_request`, migration 041). The Anthropic Messages API reports
research web searches separately from tokens and bills each one. A call that reported
searches is priced only when that price is set; otherwise it stays unpriced and keeps its
full reservation, and the price list flags the research model. A reported prompt-cache
write also leaves a call unpriced (no version records a cache-write rate; the built-in
adapters never request caching).

**Unpriced models.** By default a workspace refuses paid work for a role whose
model has no price in force: capability checks report the role as
`configuration_missing`, so a run waits before anything is reserved, and the gateway
refuses again (`PROVIDER_PRICING_REQUIRED`, certain non-start) before reading
context or contacting a provider. Refusal is the default because the budgets are
meant to track a prepaid balance with a monthly cap: an unpriced call can only be
charged its full per-job allowance, which overstates spend and hides how close the
real balance is. An operator can explicitly allow unpriced work; each such call then
keeps the full allowance as its charge and is never refunded.

**Reconciliation.** Admission still reserves the full per-job allowance against the
workspace and enrollment budgets (the safety ceiling). When a priced call completes,
its settlement charges the actual cost and returns the remainder, in the same
transaction and lock order as the reservation (job, then workspace budget, then
enrollment budget). Settlement is idempotent: a retried or concurrent settlement of
the same outcome changes nothing. Calls that are in flight, uncertain or unpriced
keep the full reservation until a definite outcome settles them; a certain
non-start releases it all. Erasing a learner's data finishes that learner's open
reservations: never-run work is released, and a call that may have run is closed at
its full reservation (state `uncertain`, settled). Such a row still counts as charged
spend and as uncertain, but no longer as held, and nothing settles it again. `provider_spend_ledger` mirrors every reservation and
settlement, and Providers > Paid-work spend shows reserved, charged, actual and
released amounts by day or month (UTC), role and enrollment.

Telemetry adds `course.provider.cost.reserved`, `course.provider.cost.actual` and
`course.provider.cost.released` counters, emitted only after the
transaction that wrote the ledger commits (media jobs included), and a `course.cost.pricing` attribute
(`priced`, `unpriced`, `refused`) through the existing allowlist. These figures are
application accounting from provider-reported usage; they are not a provider
invoice and have not been compared with a live bill. All of them, and the gateway's
`course.provider.operations` and `course.provider.cost.estimate`, are queued with
`onCommit` inside `afterCommitTransaction` (`src/after-commit.ts`): a rolled-back
reservation, settlement, erasure or receipt write reports nothing, and a retried or
duplicate settlement is counted once.

## Anthropic connections

Choose "Anthropic" as the installed provider and paste a Console API key. The key goes
only into the encrypted server vault (adapter kind `anthropic`, a generated
`COURSE_PROVIDER_…_API_KEY` credential name) and is never returned. Metadata inspection
reads `GET https://api.anthropic.com/v1/models` with the key in `x-api-key`; it makes no
generation call. Its capability flags decide which models each role offers: companion
needs the Messages API, supervisor and reviewer need structured outputs, research needs
server web search. Media is never offered: the Messages API cannot generate images or
video, and the media role keeps its current connection (for example a Google one), so
mixed providers are supported.

The guided draft sets effort `low`, disables thinking only where the model reports that
it can be disabled (Claude Haiku 5.5), and otherwise leaves more output room because
thinking tokens count toward `max_tokens`. Paid work stays refused until the operator
enters prices for each bound model; for research, also enter the per-web-search price.
Live behavior, real costs and teaching quality are unverified: the adapter and the
supervisor/companion paths are tested only against a scripted Anthropic-compatible
endpoint on loopback.

## Remaining gates

- Configured-workspace Temporal recovery, rotation during a provider call, metadata membership revocation, protected key restore and duplicate boundary qualification now have local evidence. Native deployment and complete data lifecycle remain separate gates.
- Guided connection/model setup and non-generation metadata diagnostics are implemented for Google, Anthropic (text roles) and trusted metadata/build ports. Live model verification, real-bill agreement of computed costs and generation quality remain unverified.
- Operator tool/context/version timeline and explicit live test/spend confirmation.
- Required whole CI, exact release consumers, native deployment, and user-configured
  Google tutoring/video acceptance. No paid calls until that secure configuration
  and allowance are provided.

## Observed metadata and guided setup qualification

Discovery performs only fixed-origin Google model-list GET requests, with keys in
headers and bounded response/page/time/concurrency limits. Results and previews
are scoped to the current workspace version and inspecting operator. Interrupted
requests become failed receipts; retrying an expired ID does not resubmit. Key
rotation or membership removal discards an in-flight result. Provider text is
untrusted data and never executes code or establishes specialized capability.

Role drafts retain existing assignments unless explicitly changed, leave space
for protocol overhead in model context limits, and expose every configured round's
token reservation. Choosing a draft changes no cost allowance or shared budget.
Adding a connection cannot silently activate an unsaved model/admission draft;
saving a budget preserves those separate drafts. Advanced JSON remains available.

The combined local PG/HTTP/Temporal gate has ten scenarios, including an
operator-configured encrypted key and a distinct 615,001-token admission policy,
committed application acknowledgement loss, worker replacement, and rotation
during the first model response. Rotation prevents the next round, publishes no
lesson/mastery, preserves observed usage and retains uncertain reservations.
External model/metadata services are synthetic; no live Google claim is made.
