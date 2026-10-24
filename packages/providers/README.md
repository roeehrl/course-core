# Provider interfaces, Google and Anthropic adapters

Standalone server-side TypeScript ESM package for Node 24+. It defines provider-neutral
tutoring, structured assessment, research, image and video interfaces, an admin-configured
model registry, a Google Gemini REST implementation and an Anthropic Messages API
implementation for text roles. Zod is the only runtime
dependency; HTTP, abort signals and streams use Node's native APIs.

**Acceptance status: mocked HTTP contract tests only.** No configured credentials or
live-provider acceptance are assumed. Passing tests does not establish model availability,
account entitlement, actual costs, generated-media quality, or successful live requests.
Model output is a proposal or artifact, never authoritative mastery/progression evidence.

## Build and test

Run in this package directory:

```sh
npm ci --workspaces=false --ignore-scripts
npm test
npm run check
npm pack --dry-run --workspaces=false
```

`npm test` first builds, then runs native Node tests against the public package exports.
Tests inject a fake `fetch` returning real `Response`/`ReadableStream` objects; they make
no provider calls. Type declarations target Node 24. Compiled files go to ignored `dist/`.
There are no sibling-source imports or required root/workspace configuration changes.

## Admin configuration and credentials

The core imports only `@course-core/providers`: portable contracts, `ModelRegistry` and
`ProviderRouter`. This entry point has no Google adapter import anywhere in its dependency
graph. The composition layer imports `GoogleProvider` and explicit Google types from
`@course-core/providers/google`. Other trusted adapters implement the same capability ports.

Construct `ModelRegistry` from trusted, versioned admin configuration. Each entry names
an opaque local model ID, provider/account binding, opaque remote model ID, enabled
capabilities/tools, application limits and bounded JSON `providerConfig`. The portable
registry does not interpret transport, endpoint, version, native tool or cancellation
semantics. Native identifiers can contain slashes, spaces and vendor-specific syntax.
There are no hardcoded model
names, model-family heuristics, rate cards or automatic “best model” choices. Registry
declarations are configuration, not verified provider capability or availability claims.
Disabled/missing models, account mismatches and unsupported capabilities fail before HTTP.

Call `registry.registerAdapter(adapter)` explicitly before dispatch. The adapter supplies
`providerId`, capability `ports` and a synchronous `validateModel` hook. Registration
requires every declared model capability to have a callable port and validates that
adapter's models before installing any routes. Failed or duplicate registration cannot
replace a working route. Unregistered adapters fail with `ADAPTER_UNAVAILABLE`; there is
no Google fallback. Configuration snapshots and registered method bindings are preserved.
Opaque config/job state still must be bounded data-only JSON: executable values, getters,
cycles, nonfinite numbers, custom prototypes, unsafe property keys and excessive size or
depth are rejected. The adapter then validates its native schema. The neutral router also
revalidates structured assessment output against the requested contract.

Illustrative configuration shape; the remote identifiers below are placeholders:

```ts
import { ModelRegistry, ProviderRouter, type RegistryConfig } from '@course-core/providers';
import { GoogleProvider } from '@course-core/providers/google';

const adminConfig: RegistryConfig = {
  revision: 'admin-config-1',
  models: [
    {
      id: 'tutor', providerId: 'google-primary',
      remoteModel: 'replace-with-admin-selected-text-model',
      providerConfig: { transport: 'generate_content', apiVersion: 'v1beta', maxResponseBytes: 1000000 },
      enabled: true,
      capabilities: ['tutoring', 'structured_assessment'], tools: [],
      limits: { maxInputCharacters: 20000, maxOutputTokens: 1024 },
    },
    {
      id: 'video', providerId: 'google-primary',
      remoteModel: 'replace-with-admin-selected-video-model',
      enabled: true,
      capabilities: ['video'], tools: [],
      limits: { maxInputCharacters: 10000 },
      providerConfig: {
        transport: 'video_lro', apiVersion: 'v1beta', maxResponseBytes: 1000000,
        video: {
          durationSeconds: [4], aspectRatios: ['16:9'], resolutions: ['720p'],
          downloadHosts: ['generativelanguage.googleapis.com', 'storage.googleapis.com'],
        },
      },
    },
  ],
};

// credentialStore is supplied by the authenticated server application.
const registry = new ModelRegistry(adminConfig);
const google = new GoogleProvider({
  providerId: 'google-primary',
  registry,
  getApiKey: () => credentialStore.getGoogleKey(),
  settings: { attemptTimeoutMs: 30000, totalTimeoutMs: 60000, maxAttempts: 3,
    baseDelayMs: 500, maxDelayMs: 10000 },
  telemetry: event => safeMetrics.record(event),
});
registry.registerAdapter(google);
const provider = new ProviderRouter(registry); // the core-facing capability port
```

The example limits and allowed video parameters are application choices to verify against
the selected model; they are not promises of provider support. Google text generation
requires a configured `maxOutputTokens` ceiling; portable/video models can omit it.
Google's `requireGoogleModel` validates the native model slug, transport/version,
permitted tools, response byte bound and video settings on use, as well as during adapter
registration. Its native model slugs exclude `models/`. These restrictions do not apply to
other adapters. Changing the registry means constructing a new snapshot. Preserve an
enabled model/account mapping while its jobs need polling; a different registry revision
can resume a Google job if the model, native API version and provider binding remain identical.

`test/portable.test.mjs` registers a fake non-Google adapter with namespaced model IDs,
a custom JSON dialect, opaque queue-ticket video state, WebM output and an optional remote
cancellation implementation. It dispatches through `ProviderRouter` with no Google fields.
The TypeScript contract checks prove that core code uses only the portable ports/types.
The fake adapter is a contract fixture, not another live provider integration.

The key is supplied only by `getApiKey`, held in private server state and sent in the
`x-goog-api-key` header to the fixed Google API origin. This package never reads `.env`
or process credentials. It has a browser-denying export and a Node runtime guard. Neither
guard replaces the application's server/client bundle boundary: never put credentials in
client code, public configuration, prompts or serialized request objects. There is no
configurable HTTP base URL. Redirects are refused. The injectable `fetch` is a trusted
server/testing seam, not an end-user setting.

## Text, assessment and research

```ts
const request = {
  modelId: 'tutor',
  accounting: { accountingKey: 'generation-1', estimatedInputTokens: 100 },
  systemInstruction: 'Explain clearly and ask one useful follow-up.',
  messages: [{ role: 'user' as const, text: 'Explain this example.' }],
  maxOutputTokens: 512,
};
const result = await provider.tutor(request, { signal: abortController.signal });
```

Text history starts and ends with a user message and alternates `user`/`assistant`.
System instructions are separate. Unknown fields, empty history, non-text content and
oversized requests fail closed. Characters are JavaScript string code units, not token
estimates. Assessment schema size counts toward the input character bound.

**Thinking and cut-off replies.** A Google `generate_content` model may declare
`providerConfig.thinking`: `{ level: 'minimal' | 'low' | 'medium' | 'high' }` (Gemini 3 and
later, sent as `generationConfig.thinkingConfig.thinkingLevel`) or `{ budget: n }` (Gemini 2.5,
`thinkingBudget`; `-1` dynamic). Exactly one is allowed; absent, the model default applies.
Thought tokens count toward `maxOutputTokens` and are reported as `tokens.thoughts`, separately
from the visible `output`, and inside `total`. A response stopped at the output limit
(`MAX_TOKENS`, Claude `max_tokens`) is `INCOMPLETE_OUTPUT` with its usage kept on the error,
unless a tutoring request sets `allowCutShort: true`: then a reply with at least
`MIN_CUT_SHORT_CHARACTERS` (200) visible characters is returned as `{ text, cutShort: true }`.
Assessment and research output is never accepted when cut off.

`assess({...request, outputSchema})` uses a bounded, provider-neutral schema descriptor:

```ts
const assessment = await provider.assess({
  ...request,
  outputSchema: {
    type: 'object',
    properties: {
      score: { type: 'integer', minimum: 0, maximum: 3 },
      feedback: { type: 'string' },
      requiresReview: { type: 'boolean' },
    },
    required: ['score', 'feedback', 'requiresReview'],
  },
});
```

The descriptor supports object properties/required fields, bounded arrays, strings and
string enums, booleans, null, finite numbers and safe integers with optional minimum and
maximum. Arrays require explicit `minItems`/`maxItems`. Objects always reject extra keys.
It is deliberately not arbitrary JSON Schema: remote refs, executable validators,
prototype keys, excessive depth/size and unknown keywords are rejected. The package
derives Google's `generationConfig.responseFormat.text` JSON schema and validates the
returned JSON locally without coercion, Markdown stripping or silent repairs. Structural
validity does not establish rubric correctness, truthful feedback or an authorized grade.

For the Google adapter, `research(request)` requires the explicit `research` capability
and `web_search` tool in admin config. It sends Google's built-in `googleSearch` only for research. No custom
function execution, code execution, URL-context, automatic tool loop, or combined
structured-output/tool call is implemented or advertised by this adapter. `google.capabilities(modelId)` reports
only configured enabled capabilities. A model response containing unsupported content
parts/function calls is rejected instead of executed or silently accepted.

Research returns source URLs, citation links, search queries, provider search suggestions
and `grounding: 'grounded' | 'not_grounded'`. Missing grounding is not fabricated. Citation
indices are validated UTF-8 **byte offsets within the original part**, not JavaScript
string offsets. The `parts` array preserves visible original part indices, including gaps
where thought parts were removed. URLs, titles, text and `searchSuggestionsHtml` are
untrusted presentation data. The host must render attribution and suggestions according
to Google's requirements through a reviewed isolated/safe rendering path; this package
does not sanitize or execute provider HTML. Grounding metadata does not prove truth.

## Image and video jobs

Every image and video port also declares, without contacting the provider:

- `discoverCapabilities(modelId)`: the configured settings (video durations, aspect ratios and
  resolutions; image aspect ratios, sizes and types), the prompt limit, how remote work can be
  stopped, the unit the provider bills by, and how long the provider keeps a generated output
  (`retention.outputHours`: Veo keeps a video for 2 days, so a host must download it first;
  inline images are not kept). This is the configuration as declared, not a live check.
- `estimateCost(request, price)`: the billable units of one request (output seconds, images,
  requests) priced with an operator-entered `MediaPrice` through `priceMediaUnits`. There is no
  built-in rate card; a price that does not cover every unit gives `microUsd: null` and
  `reason: 'pricing_incomplete'`, which a host must treat as "do not admit".

`ModelRegistry.registerAdapter` refuses an image or video port that does not implement both.
`ProviderRouter.discoverCapabilities`, `estimateVideoCost` and `estimateImageCost` reach them by model.

Image models with `transport: 'image_interaction'` use the Interactions API
(`POST /{apiVersion}/interactions`), which current Google documentation names for image
generation; the Imagen models are shut down. The adapter sends the prompt as one text input,
`store: false` and an inline `response_format` (`aspect_ratio`, `image_size`, `mime_type`) chosen
from the model's declared `image.aspectRatios`, `image.imageSizes` and `image.mimeTypes`; an
undeclared value is refused before anything is sent. Only `model_output` steps are read; a
`failed` or `cancelled` interaction is `OPERATION_FAILED`, any other unfinished status is
`INVALID_RESPONSE`, and each image is bounded by `image.maxImageBytes`. Such a model must be
image-only with no tools.

The older path, a `generate_content` model with the `image` capability, is kept:
`startImage` implements a synchronous completed image-job result through `generateContent`
with `TEXT`/`IMAGE` modalities. It requires configured `image` capability. Visible inline
PNG/JPEG/WebP data is checked for canonical base64 and matching format signatures; this
is not a full media decoder, pixel-dimension check or content-safety audit. Parent media
ingestion must decode, constrain dimensions, scan and store validated assets. Thought
text/media/signatures are excluded from returned content. No file uploads, reference-image
editing or model-specific image tuning are currently exposed.

`startVideo` submits text-to-video through `predictLongRunning` and returns a serializable
job handle immediately when pending. The request's duration, aspect ratio and resolution
must be in the model's explicit admin allowlists. More complex parameter combinations
may still be rejected by Google; the package does not infer model-specific rules.

```ts
const submitted = await provider.startVideo({
  modelId: 'video', accounting: { accountingKey: 'video-1' },
  prompt: 'Animate a simple diagram.', durationSeconds: 4,
  aspectRatio: '16:9', resolution: '720p',
});
await durableJobs.save(submitted.output.job); // parent-owned durable boundary
const observation = await provider.pollVideo(submitted.output.job);
```

The portable `VideoJob` contains provider/model bindings, accounting, requested duration
and bounded opaque JSON `providerState`; it has no Google operation name or version fields.
The explicit `GoogleVideoJob` narrows that state to Google's native model/version/operation
reference. Core storage and orchestration must preserve this state without interpreting it.
Each adapter validates its own resumed handle. Job dispatch checks the provider binding.

Google's `pollVideo` performs one GET of the persisted operation name. `google.waitForVideo` is a bounded
local convenience with explicit `maxPolls` and `pollIntervalMs`, plus a total wait timeout
(default 60 seconds, maximum five minutes). Durable scheduling belongs to the parent.
On polling error/cancellation/timeout, `ProviderError.job` retains the handle and
`pollUsage` retains preceding poll observations. Resume polling the same handle; never
create a replacement job merely because polling was interrupted. `done: true` alone is
not success: a valid completed response and approved HTTPS media references are required.

Operation names cannot contain arbitrary hosts, queries, traversal or a different model
prefix. Returned video origins must match exact admin-configured `downloadHosts`.
Media URIs are returned, never fetched. Do not blindly forward the API key to storage
URLs or redirects in the parent's eventual downloader. Image-to-video, extensions,
reference frames, audio controls and remote cancellation are not implemented.

The portable video port has an optional `cancelVideo` method; no cancellation policy is
assumed. Inspect `registry.port(modelId, 'video').cancelVideo` before exposing a remote
cancellation control. Calling the router's cancellation method for an adapter without
that port fails with `CAPABILITY_MISMATCH`.

Google's additional `videoCancellation` property is `local_abort_only`, and it does not
implement `cancelVideo`. An abort stops local HTTP/polling and prevents
further local retries. It does not prove that remote generation stopped or that billing
stopped. The official Veo guide inspected for this adapter did not document a remote
cancellation contract, so the package does not invent one.

## Failures, retries and redaction

- Public calls accept `AbortSignal` and a bounded timeout. HTTP timeout includes credential
  resolution, attempts, body reads and backoff; each attempt has its own shorter bound.
  A fetch that ignores the signal still cannot keep the caller waiting indefinitely.
- Retry classification distinguishes authentication/permission/client errors, throttling,
  transient availability/network/timeouts, invalid output, provider blocking and local
  cancellation. Retries use finite attempts, exponential backoff and jitter. `Retry-After`
  dates/seconds are respected; a hint beyond the local delay/deadline is returned to the
  parent rather than shortened into an early retry.
- GET polls may retry transient failures. POSTs retry only explicit HTTP 429 throttling.
  A timeout, network loss, malformed response or 5xx after submitting a generation may
  leave a billable remote operation running: the package never automatically replays
  that uncertain POST. `classifyRetry` exposes this distinction. No provider idempotency
  guarantee is claimed; `accountingKey` is local correlation, not an upstream dedupe key.
- Only a documented refusal of the request itself is certified as "the model did not run":
  HTTP 400 (invalid request), 401 (authentication), 402 (billing), 403 (permission), 404
  (unknown model or endpoint), 413 (request too large) and 429 (rate limit). These attempts
  are recorded with outcome `rejected`, and `definiteRejection(error)` returns the final status,
  whether a later identical call may succeed (429 only) and any `Retry-After` hint, but only
  when every recorded attempt was such a refusal. Every other status after sending (408, 409,
  499, 5xx, Anthropic's 529, any undocumented 4xx), a timeout, a connection reset or a broken
  body is `unknown`. Sources: the Gemini API error reference and billing FAQ ("If your request
  fails with a 400 or 500 error, you won't be charged for the tokens used") and the Claude API
  error reference (`invalid_request_error`, `authentication_error`, `billing_error`,
  `permission_error`, `not_found_error`, `request_too_large`, `rate_limit_error`). Neither
  provider promises that a 5xx, overload or deadline did no billable work, so those stay
  unknown here even though Google's FAQ says failed 500s are not charged.
- Response byte size, JSON depth/nodes, types, completion state, counters and content parts
  are bounded/validated. Blocked, partial, malformed or tool-bearing responses do not
  become successful tutoring/assessment results. Unknown envelope metadata is ignored
  for protocol evolution; consumed content fields remain validated.
- Telemetry is an allowlist of adapter/operation, attempt number, phase, HTTP status,
  static error code, elapsed milliseconds and retry delay. It contains no keys, headers,
  prompts, outputs, model aliases, account IDs, URLs, search text or provider error bodies.
  `response` means an HTTP response was received; later output validation may still fail.
  Telemetry callbacks that throw/reject cannot replay or fail a paid call.
- `new ProviderRouter(registry, { observe })` reports each routed call to an optional
  observer: at start `{ operation, modelId }`, at the end outcome (`response`/`error`),
  static error code, provider ID, attempt count, summed input/output/total tokens (`null`
  when any attempt did not report one), access kind and elapsed milliseconds. It has no
  prompt, output, accounting key, credential or URL, and the package still imports no
  tracing SDK; the host maps it to OpenTelemetry. A throwing observer is ignored.
- `ProviderError` uses fixed messages without raw upstream body/status text, cause or
  abort reason. Its `toJSON()` is redacted. The explicitly accessed `usage` and `job`
  properties are private reconciliation context; do not treat arbitrary object inspection
  as the telemetry interface or log raw success results.

## Usage accounting and parent responsibilities

Every dispatched operation returns `UsageReceipt` or attaches it to `ProviderError`.
It preserves the caller's accounting key/estimate, requested character/token/video bounds,
each HTTP attempt's status/outcome, reported token counters and observed media count.
Missing counters are `null`, never zero. Input, output, cached input, thinking, tool input
and provider-reported total remain separate; they are not summed into an invented bill.
Image/video counts are observations. Requested video seconds are an estimate, not measured
output duration. Adapters always return `cost: null`: the package ships no rate card.
A parent that holds operator-entered prices can call `priceUsage(receipt, pricing)`
(validated by `modelPricingSchema`) to compute an integer micro-USD `ReceiptCost` from the
reported counters: cached input at its own price, thinking as output, tool prompts as
input, any unexplained reported total as output, one upward rounding per receipt, and no
price at all when an attempt's outcome or counters are unknown. Billing reconciliation
remains the parent's. Usage can remain known even when the generated output fails validation.

Treat these as accounting observations, not exactly-once financial receipts. A retried
generation may incur additional usage; an uncertain attempt remains unknown. Polling a
completed job twice observes the same media twice. Deduplicate artifacts and final usage
by the parent's durable job/attempt identities, while retaining all transport attempts.
Do not add requested video seconds again for each poll. Reserve budget before dispatch;
enforce authorization, scope, policy fences, evidence validation and transactional receipts
in the parent. This package owns no database, workflow, event stream or durable lock.

## Official protocol references

Researched on 2026-10-12. Implementation follows the requested Generate Content/Veo
contracts; Google's current site labels the Generate Content guide section as legacy
alongside the newer Interactions API. Image generation through Interactions was added on
2026-10-21 (see `image_interaction`); text roles still use Generate Content.

- [GenerateContent REST reference](https://ai.google.dev/api/generate-content): request/response envelope, completion reasons, usage counters and citation byte offsets.
- [Text generation](https://ai.google.dev/gemini-api/docs/generate-content/text-generation): message roles and system instructions.
- [Structured outputs](https://ai.google.dev/gemini-api/docs/generate-content/structured-output): current `responseFormat.text` JSON schema configuration.
- [Google Search grounding](https://ai.google.dev/gemini-api/docs/generate-content/google-search): `googleSearch`, grounding metadata and attribution requirements.
- [Image generation](https://ai.google.dev/gemini-api/docs/generate-content/image-generation): response modalities and inline image parts.
- [Interactions API reference](https://ai.google.dev/api/interactions-api) and [Image generation](https://ai.google.dev/gemini-api/docs/image-generation): `ImageResponseFormat`, `ImageContent`, `ModelOutputStep`, interaction status and usage counters (read 2026-10-21; the [Imagen page](https://ai.google.dev/gemini-api/docs/imagen) says Imagen is shut down).
- [Veo generation](https://ai.google.dev/gemini-api/docs/veo): `predictLongRunning`, GET operation polling and generated video references.
- [Troubleshooting](https://ai.google.dev/gemini-api/docs/troubleshooting): transient errors and bounded backoff guidance.

# Anthropic Messages API adapter

`@course-core/providers/anthropic` exports `AnthropicProvider`, a server-only adapter for
the tutoring, structured assessment and research capabilities. The Messages API has no
image or video generation, so a model declaring `image` or `video` is refused at
registration. **Acceptance status: scripted HTTP contract and integration tests only. No
live Anthropic call has been made or verified.**

**Protocol.** One non-streaming `POST https://api.anthropic.com/v1/messages` per call,
with the key in `x-api-key` and `anthropic-version: 2023-06-01`. Origin, path and headers
are code, never configuration; redirects are refused. Requests carry `model`,
`max_tokens`, an optional `system` string and alternating `user`/`assistant` text
messages ending with a user turn. No sampling parameters, prefill, `stream`, tools other
than server web search, or server-side `fallbacks` are sent: current models reject
non-default sampling values and prefill, and a server-side fallback would bill another
model than the one the operator priced. Streaming is not used because every role
has a bounded `max_tokens` (at most 16,000) and the other adapters are request/response.

**Model configuration** (`providerConfig`, strict): `transport: "messages"`,
`apiVersion: "2023-06-01"`, `maxResponseBytes` (at most 32 MiB), optional `effort`
(`low` to `max`, sent as `output_config.effort`), optional `thinking` (`adaptive` or
`disabled`; `disabled` only with effort `high` or below, and only for models whose
metadata reports it, such as Claude Haiku 5.5; Claude Opus 5.5 and Sonnet 5.5 reject it),
and for research `webSearch: { toolType: "web_search_20250305", maxUses }`. `remoteModel`
is a bare Messages API id such as `claude-haiku-5-5`, `claude-sonnet-5-5`,
`claude-opus-5-5` or `claude-fable-5-1`; it cannot be a path or URL.
`limits.maxOutputTokens` is required.

**Responses.** Only `stop_reason: "end_turn"` is a usable answer. `refusal` is `BLOCKED`;
`max_tokens`, `model_context_window_exceeded`, `pause_turn`, `tool_use`,
`stop_sequence` and any unknown reason are `INCOMPLETE_OUTPUT`, so a truncated JSON
answer is never parsed. Answer text is the concatenated `text` blocks; `thinking` and
`redacted_thinking` blocks are never returned. Structured assessment sends
`output_config.format: { type: "json_schema", schema }` using the accepted subset (types,
`enum`, `const`, `required`, `anyOf`, `items`, `minItems` 0 or 1, every object closed
with `additionalProperties: false`); numeric and size bounds the API does not accept are
enforced afterwards by the full local contract. Research maps `web_search_result_location`
citations to sources and whole-block byte ranges; uncited text is never marked grounded.

**Usage.** `input` is `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`
(the API reports them separately), `cachedInput` the cache reads, `cacheWriteInput` the
cache writes, `thoughts` `output_tokens_details.thinking_tokens` when reported (split out
of `output`), `total` input plus all output, and `serverToolRequests` the reported web
searches. `priceUsage` charges searches at the price version's
`microUsdPerServerToolRequest`; without it, or with any cache write (the adapter never
requests caching and no version records a cache-write rate), the receipt is unpriced
rather than undercharged. Claude Haiku 5.5 has a higher rate above 100K prompt tokens;
the guided input limits stay far below that, and the operator price is a single rate.

**Errors.** Status classification is shared with the Google adapter: 401
`AUTHENTICATION`, 403 `PERMISSION_DENIED`, 404 `NOT_FOUND`, 429 `THROTTLED` (rejected,
`retry-after` honoured within the transport bounds), other 4xx including 400, 402 and 413
`UPSTREAM_REJECTED`, and 500, 504 and 529 `overloaded_error` `UPSTREAM_UNAVAILABLE` with
an uncertain outcome, never replayed. A 429 whose body names
`enforced_spend_limit_reached` is a non-retryable `UPSTREAM_REJECTED`. At most 16 KiB of
an error body is read and only its `type`/`error_code` is inspected; nothing from it is
kept, logged or returned. Timeouts, response size and attempts use the same bounded
transport as Google; the API host sets one attempt per call and leaves retries to the
durable supervisor.

Protocol references: the Messages API reference
(<https://platform.claude.com/docs/en/api/messages>), errors
(<https://platform.claude.com/docs/en/api/errors>), structured outputs, web search tool
and the Models API (`GET /v1/models`, used only by the API host's metadata inspection).
# Subscription access

See [subscription adapter contracts and opt-in fallback](./SUBSCRIPTIONS.md) for
the generic server extension, admission boundary and configuration controls.
