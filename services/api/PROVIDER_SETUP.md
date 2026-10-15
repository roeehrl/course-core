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
room for that full allowance, which is charged at admission and never refunded (the
provider may still bill a cancelled or uncertain operation).

Jobs are durable rows (`media_jobs`, migration 035) driven by a leased worker pass
(`MEDIA_JOB_INTERVAL_MS`, default 15 s, only when the provider vault is configured).
A submission whose outcome is unknown becomes `uncertain`: the worker polls the stored
provider operation and never submits again; without an operation id it waits until the
job deadline and fails as `MEDIA_OUTCOME_UNKNOWN`. Completed clips are downloaded only
from the model's approved hosts, bounded in size, checked for an MP4/WebM container
and stored with a SHA-256. Nothing is learner-visible until staff approve it with
WebVTT captions, a transcript and a visual description, and then attach it to one
enrollment's episode; attachment re-checks the enrollment's current policy and
expires or can be revoked. Live Veo generation and download have not been verified.

## Remaining gates

- Configured-workspace Temporal recovery, rotation during a provider call, metadata membership revocation, protected key restore and duplicate boundary qualification now have local evidence. Native deployment and complete data lifecycle remain separate gates.
- Guided connection/model setup and non-generation metadata diagnostics are implemented for Google and trusted metadata/build ports. Live model verification, pricing and generation quality remain unverified.
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
