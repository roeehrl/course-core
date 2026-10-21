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

## Keys: normalization, testing and failure reasons

A pasted key is stored without the whitespace, line breaks and zero-width
characters a copy can add around it. An empty key is refused with
`400 PROVIDER_CREDENTIAL_EMPTY`, and a key that still contains anything but
printable ASCII with `400 PROVIDER_CREDENTIAL_MALFORMED`; the refusal carries
only the code, never the key. The admin form applies the same rule as the key is
typed or pasted and names each refused character (position, look, and the plain
character it probably was) before anything is sent. Values stored by
earlier releases are read with the same trimming, so a key saved with a trailing
space works without being entered again.

`POST .../provider-setup/test-key` (owners and administrators) tests a typed key
before it is saved: `{kind, key}` runs the installed adapter's metadata listing
with a 10-second deadline and the same bounded reader as an inspection. No
generation is requested and no learner data is sent. The key is used for that
request only: it is not stored, returned, logged, put in a receipt or audited.
The workspace audit records `provider.key_tested` with the kind, the outcome and
the model count. Tests are limited per workspace (6 a minute, 30 an hour, 2 at
once; `429 PROVIDER_KEY_TEST_RATE_LIMITED`). The limit is kept per API process.

Key tests and inspections report one reason code: `PROVIDER_METADATA_` +
`CREDENTIAL_MISSING`, `CREDENTIAL_MALFORMED`, `KEY_INVALID`, `API_NOT_ENABLED`,
`KEY_RESTRICTED`, `PERMISSION_DENIED`, `RATE_LIMITED`, `REJECTED`,
`UPSTREAM_ERROR`, `NETWORK`, `TIMEOUT`, `INVALID`, `TOO_LARGE`, `UNSUPPORTED`
or `UNAVAILABLE`. They come from the HTTP status and the provider's structured
error reason (Google `ErrorInfo.reason`, Anthropic `error.type`); provider error
text is never passed on. The admin screen shows an action for each code.

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

## AI services page: connections, drafts and approval by draft

The admin "AI services" page uses these routes (all under
`/api/admin/workspaces/:workspaceId/provider-setup`, owners and administrators):

- `GET /connections`, `POST /connections` `{kind, key, name?, skipTest?}`,
  `PUT /connections/:id/key`, `POST /connections/:id/test`, `DELETE /connections/:id`.
  The server names the adapter id and the key slot (`COURSE_PROVIDER_<random>_API_KEY`);
  nobody types a slot name. A key is tested with the provider's model listing before it is
  stored (`422` with the metadata reason code when refused); `skipTest` exists only for
  hosts that cannot reach the provider. Only the last four characters of a key of at least
  16 characters are kept as display metadata (`keyEnding`, else `null`); the key itself is
  never returned, logged, audited or put in a draft. Adding a connection or replacing a key
  creates a new version without stopping running jobs (they keep the version they started
  with). Removing a connection a job uses is refused with
  `409 PROVIDER_CONNECTION_IN_USE {roles}`.
- `GET /connections/:id/models`: the stored key's model list (cached for ten minutes per key)
  with each job's method and a suggested model (`src/provider-suggestions.ts`, naming rules
  only, never prices).
- `POST /drafts` `{baseRevision, assignments: {job: {connectionId, remoteModel} | null}}` and
  `POST /drafts/json` `{baseRevision, configuration, jobPolicy}` store the workspace's single
  open draft (migration 088); `GET /drafts/current`, `DELETE /drafts/current`. A draft
  reports, per job, whether it waits for a quality check and whether it is priced. Models of
  the draft can be priced (`POST …/provider-pricing`) before activation.
- `POST /drafts/:id/activate` `{expectedRevision, idempotencyKey, confirmCancelRunning}` runs
  the same save path as `POST /provider-setup`: secret checks, token bounds and the eval gate
  (`409 PROVIDER_EVAL_REQUIRED`). It refuses with `409 PROVIDER_JOBS_RUNNING {count}` while
  jobs would be stopped and the operator has not confirmed.
- `POST …/provider-evals/overrides` also accepts `{draftId, role, reason}`: the owner approves
  the exact revision of that job in the open draft and the server resolves its digest.
- `PUT /service-keys/youtube` `{key | null}` stores the YouTube search key.

### Quality check from the page

`GET /quality-check` reports what a check of the open draft would run: the jobs waiting for a
check, the number of practice conversations, the estimate (conversations × 3000 input and
600 output tokens × the saved price), the amount set aside while it runs (the draft's
per-request allowance for each conversation), `blocked` with the reason it cannot start, and
the latest check. `POST /quality-check` `{idempotencyKey, draftId}` (owners and administrators,
same session, origin and CSRF rules as every admin write) starts it and returns at once; `GET
/quality-check/:id` reports progress (`completed` of `total`) and the result.

- Refusals, in this order: `404 PROVIDER_DRAFT_NOT_FOUND`, `409 STALE_PROVIDER_REVISION`,
  `409 PROVIDER_QUALITY_CHECK_NOT_NEEDED`, `409 PROVIDER_QUALITY_CHECK_KEY_MISSING {roles}`,
  `409 PROVIDER_QUALITY_CHECK_PRICES_MISSING {roles}` (always required, whatever the
  unpriced-work rule), `409 PROVIDER_QUALITY_CHECK_LIMIT_MISSING` (no workspace spending
  limit), `409 PROVIDER_QUALITY_CHECK_BUDGET_REACHED {neededMicroUsd, availableMicroUsd}`,
  `409 PROVIDER_QUALITY_CHECK_RUNNING` (one at a time per workspace) and
  `429 PROVIDER_QUALITY_CHECK_RATE_LIMITED` (six starts per hour). A repeated key returns the
  same check; the same key for another draft is `409 IDEMPOTENCY_CONFLICT`.
- Each conversation reserves the per-request allowance against the workspace budget and has
  its own `provider_spend_ledger` row (`source='quality_check'`, no enrollment; migration 089).
  After its call the row settles at the reported usage and saved price, is released when the
  provider certainly refused the call, and stays charged when the outcome is unknown.
- The run uses the server's eval runner (`agent-evals/runner.ts`) with the workspace's own key
  and the draft's models, under a ten-minute deadline. A finished run is recorded through the
  same path as an uploaded report (`provider_eval_results`, regraded by Core); a pass lets the
  draft be turned on. A key, quota or network failure stops the run and records nothing (the
  reason uses the key-test codes). A run past its deadline, or one a stopped server left behind,
  ends as an error and keeps unsettled calls charged.
- Audit: `provider.quality_check.started` and `provider.quality_check.finished` (ids, jobs,
  counts, amounts and outcome codes; never answers, prompts or keys).

The CLI and `POST …/provider-evals/results` remain available for developers.

## Paid-work budgets

Budgets default to zero. Both workspace and enrollment ledgers must have room
before a call. A learner whose own limit was never set uses the workspace's default limit
for each learner (`POST /budgets` with `scope: "default_enrollment"`; migration 088); with no
default it is zero. `limits.tokens` may be omitted: money is then the binding limit and the
token limit is the maximum. Positive budget changes require explicit paid-work approval and
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

Jobs are durable rows (`media_jobs`, migration 035). There is no polling interval: each job
stores its own next due time (a submission, a poll after its interval or `Retry-After`, a
render, a lapsed lease) and each attachment its expiry, and a scheduler
(`media-scheduler.ts`) sleeps until the earliest of them, runs one bounded leased pass and
looks again. A transaction that creates work notifies the `course_media_jobs` channel on
commit, which wakes every scheduler in every process at once. Nothing is kept in memory,
so after a restart the first pass resumes from the stored times. The longest sleep is
`MEDIA_SCHEDULER_MAX_SLEEP_MS` (default 300 s), a backstop for a lost notification. The
scheduler runs when the provider vault or the clip tools are configured.
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

### Media pipeline: capabilities, storyboards, images, exact clips and checks

**Provider contract.** Every image and video adapter declares `discoverCapabilities`
(settings, prompt limit, cancellation, billing unit and how long the provider keeps an
output) and `estimateCost` (billable units priced with the operator price; there is no
built-in rate card). Admission uses the adapter's estimate; the media page shows the
declared retention. A provider that deletes outputs (Veo: after 2 days) also bounds the
job deadline to that time less an hour.

**Storyboards** (`media_storyboards`, migration 102). Staff write a teaching script once;
the shots are either drafted by a model (the supervisor's model when it is ready, else the
reviewer's) or written by staff. Each shot is a generated clip of a declared length or an
exact clip of a verified course visual. A reviewer approves the storyboard before any shot
can be requested; a request names its storyboard and shot and must be of the shot's kind.
Once every shot has an approved clip, "Join the approved clips" composes them, in shot
order, into one clip that is reviewed again as a whole.

**Generated images.** With the media role bound to an image model, or an image model bound
beside its video model, staff request an image from a prompt. It is admitted, reserved and settled like a clip (priced per image or per
request), comes back in the submission's own response (an unknown outcome stays held and is
never resent), is stored content-addressed, and is approved with alt text (the visual
description) instead of captions and a transcript.

**An image model and a video model together.** The media role is one model, image or video.
A video binding may also carry `imageModel` (`{modelId, maxInputCharacters, maxOutputTokens,
image?}`), a second, image-only model: clips use the video model, images the image model. On
the AI services page, choosing a short-video model for "Images and video" offers "Model for
images too" (same connection). The media page shows both models, and "Check cost" estimates
with the model the request will use (`POST …/media-jobs/estimate` takes an optional `kind`).
The image model is priced like any other model (Providers > Model prices lists it under the
media job), and it is part of the media role's evaluated revision: changing it needs a new
quality check or an owner's approval. A configuration without `imageModel` behaves exactly as
before.

**Guided Google setup** creates image models on the Interactions API (`transport:
"image_interaction"`, `packages/providers/README.md`) with one aspect ratio and size (16:9 and
1K unless chosen), returned inline and not stored by Google. Image models saved earlier on
`generate_content` keep working until they are set up again.

**Exact clips** are rendered on the server from a verified course visual of the release,
frame by frame, by an `rsvg-convert`-compatible rasterizer and `ffmpeg` (`clip-export.ts`).
They call no provider and cost nothing. Set both tools by absolute path:

    CLIP_RASTERIZER_PATH=/usr/bin/rsvg-convert CLIP_FFMPEG_PATH=/usr/bin/ffmpeg

Without them exact clips and compositions are refused with `MEDIA_CLIP_TOOLCHAIN_MISSING`
and the media page says what to set. The tools run without a shell, receive only `PATH`,
are time- and size-bounded, run one at a time per process and work in a private temporary
directory. `npm run test:clip-export` qualifies the real tools (MP4 and WebM, frame counts,
byte-identical repeats, composition).

**Automated checks (F12).** Before approval, what the reviewer says the media shows and says
(transcript, captions, visual description or alt text) is compared with its script, its
storyboard shot and, when one is linked, a verified course visual (`media-verifier.ts`).
The rules check always runs: a quantity the sources state ("the minimum is 3") stated with
another value is a contradiction. "Check before saving" runs it on demand and can also ask
the reviewer's model (paid work, reserved and settled like any call); a model's claimed
contradiction counts only when the sentence it quotes is really in the sources. Approval
is refused (`MEDIA_FACTUAL_CHECK_FAILED`, with the findings) when either finds a
contradiction for that exact asset and text; such media must be rejected. These checks read
the reviewer's description, not the pixels: they catch a contradiction the reviewer
records, and they do not watch the video.

**Frame check.** When `ffmpeg` and `ffprobe` are set (`CLIP_FFMPEG_PATH`, and
`CLIP_FFPROBE_PATH` or an `ffprobe` beside ffmpeg), "Check before saving" also inspects the file
itself (`media-pixels.ts`): its duration, frame size and two sampled frames per second
scaled to a 32x18 grey grid, compared with what the job asked for. It reports a length off by
more than 0.5 s and 20%, a different aspect ratio or resolution, at least half the sampled
frames blank, and, without blocking, a video that never visibly moves or a composed video
with fewer visible cuts than storyboard shots. Findings are codes and numbers, stored as a
`pixels` check (migration 110) once per asset and request. It informs the reviewer and does
not refuse approval; it checks technical properties, never whether the media shows the right
thing. `npm run test:clip-export` also runs it with the real tools. Exact clips are drawn on
white, as the learner's page shows the visual (a transparent frame would encode as black).

## Model pricing and cost reconciliation

Prices are operator data. Nothing is charged by a built-in vendor price list: an owner or
administrator enters (or confirms), per configured model, an input and output price per million
tokens (optionally a cached-input price), a per-request price and, for generated
media, a price per output second, with an effective time and a source note
(Providers > Model prices). Money is integer micro-USD throughout; only USD is
accepted because the paid-work budgets are kept in micro-USD. Versions are
append-only (`provider_model_prices`, migration 039): the version in force is the
newest one whose effective time has passed. A new version cannot take effect
before the one it replaces, and a withdrawal makes the model unpriced again.

**Suggested prices.** `src/price-table.ts` is a dated table of standard text prices for known
Google and Anthropic models, copied from the providers' official pricing pages (with announced
changes and long-prompt tiers). The pricing view returns it per model as `suggested`; the admin
page prefills the price fields from it and says where the numbers came from, and nothing is in
force until an owner or administrator saves it. Saving the table's prices unchanged also saves
an announced change as a later price version. Review the table whenever a provider changes its
prices.

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

## Thinking models, output limits and cut-off replies

Gemini 2.5 and later, and current Claude models, think before they answer, and the thinking
counts toward the output limit (`maxOutputTokens`, `max_tokens`). A limit reached while the
model is still thinking leaves a cut-off or empty answer that is billed anyway. Google's advice
is to lower the thinking level rather than shrink the limit
(https://ai.google.dev/gemini-api/docs/generate-content/thinking).

**Gemini.** A `generate_content` model may set `providerConfig.thinking`, sent as
`generationConfig.thinkingConfig`: `{ "level": "minimal" | "low" | "medium" | "high" }` for
Gemini 3 and later (`thinkingLevel`), or `{ "budget": n }` for Gemini 2.5 (`thinkingBudget`,
`-1` dynamic, `0` off on Flash). The API refuses both at once, so the schema allows exactly one.
The guided draft sets, per role, a thinking level and an output limit with room for both:

| Role | Gemini 3+/4 level | Gemini 2.5 budget | Output limit |
| --- | --- | --- | --- |
| companion | `low` | 512 | 4,096 |
| supervisor, reviewer, research | `medium` | dynamic | 8,192 |

A level a model is documented to refuse is not sent (for example `medium` on Gemini 3 Pro,
`minimal` on Gemini 3.8 Flash); the model default applies. Models outside the thinking families
keep the earlier 1,000-token limit and no thinking setting.

**Setups saved by the earlier guide** (before thinking settings existed) get these defaults when the
configuration is read, and again before a new version or draft is stored
(`src/provider-defaults.ts`). Only what the guide itself produced changes: a Gemini thinking model
bound to one text role and without a thinking setting gets the role's level, and a limit still at
the guide's 1,000 tokens is raised on the model and the role when the role's token bound still
fits the job token allowance. When it does not fit (for example a four-round supervisor under a
500,000-token allowance), the limit stays and the role thinks at the `low` level instead. Stored
versions are never rewritten.

**Anthropic.** Current Claude models think adaptively; a fixed `budget_tokens` is deprecated or
refused there, so depth is set with `effort` (`low` in the guided draft). The draft gives a
companion 4,096 output tokens and other roles 8,192, or 2,048 where thinking is turned off.

**Cut-off replies.** A companion reply that stops at the output limit (Gemini `MAX_TOKENS`,
Claude `max_tokens`) is delivered when it already has at least 200 visible characters, with a
"reply was cut short" notice for the learner (`cutShort` on the answer). Tutoring text is
advisory, so a long but unfinished explanation is safe to show marked. A shorter one, any
structured output (supervisor, reviewer) and research are refused as `INCOMPLETE_OUTPUT`. A retry
with a lower thinking level was considered and not used: on the pilot's model the companion
already runs at the lowest supported level (`low`; `minimal` is refused on Gemini 3.8 Flash), and
a retry is a second billed call inside one reservation.

**A refused reply is settled, never left uncertain.** When the provider answered in full (HTTP
response read, every attempt reporting a token total) and only the adapter's output checks refused
the reply (`INCOMPLETE_OUTPUT`, `INVALID_RESPONSE`, `BLOCKED`), the gateway records a refusal
artifact (`output_refusal` with `provider_output_incomplete`, `provider_output_invalid` or
`provider_output_blocked`; a `rubric_refusal` for the reviewer), never the text. The call is
charged at the reported usage times the price version, the rest of the reservation is released,
and the verifier rejects the artifact, so the job ends `failed` with `verification_rejected` and
the learner can ask again. Research keeps the earlier rule: it has no refusal record, so such a
reply stays `provider_uncertain`. A timeout, reset or cut-off body after sending is still
uncertain.

Receipts an older gateway left `uncertain` in exactly this case (failure code
`INCOMPLETE_OUTPUT`, `INVALID_RESPONSE` or `BLOCKED`, usage reported for every attempt, companion
or supervisor job still waiting on that operation) are repaired by the reconcile pass the
dispatcher already runs: priced at the version in force when the call started (the reservation
when unpriced), settled, and the job resumed to end rejected. No operator action is needed. A row
without a reported total for every attempt is left for staff, never guessed.

## Reservations sized from the role

A supervisor job reserves, per checkpoint, the job allowance (`jobPolicy.allowance`), which is
far above one companion turn. For the companion, supervisor and reviewer, when the bound model
has token prices in force, the reservation is sized from the role instead
(`src/role-reservation.ts`):

```
rounds × ((maxInputCharacters + 1,024) × input price + maxOutputTokens × output price) × 1.25
```

never above the job allowance, with the role's own token bound as the token reservation. For the
pilot's companion (12,000 characters, 4,096 output tokens, $0.75 / $3.75 per million) that is
about $0.031 instead of $0.10. Unused reservation is released when the call settles. Research
(per-search billing) and media keep the job allowance, as does any role without token prices.

## Companion reply style

The companion asks for concise, plain replies by default: a direct answer in a few sentences or
a short list using the lesson's example, headings and LaTeX only when the question needs them,
at most one follow-up. `roles.companion.replyStyle: "detailed"` keeps the earlier, longer style
(`"concise"` or absent is the default).

The style is part of the companion prompt, so it is part of the role's revision
(`AGENT_EVALS.md`). After upgrading, the companion role (and any Gemini role the load-time
defaults changed) has a new revision. There is no runtime gate: the role keeps running, and saving
the setup again without changing the role needs no new evidence, because both sides of the
comparison are read with the same defaults. The quality-check page shows the role as needing a
check until the owner runs one (a live call, with the owner's key) or approves the new revision.
**For the pilot:** run the companion quality check after upgrading, or record an owner approval
for the new companion revision; until then it runs as before the upgrade, grandfathered.

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
thinking tokens count toward `max_tokens` (see "Thinking models, output limits and cut-off
replies" above). Paid work stays refused until the operator
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
