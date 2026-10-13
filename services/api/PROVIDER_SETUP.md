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
not infer support from a model name. Discovery and connection verification remain
additional UI/acceptance work; the current configuration is explicitly unverified.

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

## Remaining gates

- Actual configured-workspace Temporal recovery, rotation during a provider call,
  membership revocation, backup/key recovery, and concurrent boundary qualification.
- Guided provider/model setup and actual metadata inspection rather than requiring
  all creators to edit advanced JSON; secure non-generation connection diagnostics.
- Operator tool/context/version timeline and explicit live test/spend confirmation.
- Required whole CI, exact release consumers, native deployment, and user-configured
  Google tutoring/video acceptance. No paid calls until that secure configuration
  and allowance are provided.
