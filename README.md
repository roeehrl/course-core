# Course Core

Public, course-agnostic infrastructure for bounded learning. The repository contains a deterministic policy package, provider adapters, a safe visual runtime, a PostgreSQL API, a Temporal supervisor/bridge worker, and responsive learner and administrator web applications. These components are under active integration. Passing a package check or a demo browser suite does not establish a complete live learning system.

Use **Node 26** and npm. Every component has its own manifest, lockfile, and dependency directory. The root has no dependencies, workspace configuration, or lockfile: its npm scripts orchestrate the standalone packages without rewriting their metadata.

| Component | Directory | Current boundary |
| --- | --- | --- |
| Policy | `packages/policy` | Pure policy and accounting operations; the API must enforce database transactions and authorization |
| Providers | `packages/providers` | Server-side provider contracts and Google REST adapters; contract fixtures do not establish live account/model availability |
| Sandbox | `packages/sandbox` | Bounded Python execution in Docker with host-side reference grading; real Docker qualification is a required separate CI gate |
| Visuals | `packages/visuals` | Bounded declarative scenes and responsive rendering; package and browser checks remain required |
| API | `services/api` | Server authority, durable evidence, migrations and concurrency checks against real PostgreSQL |
| Supervisor | `services/supervisor` | Temporal workflow and bridge-worker implementation; a live worker/deployment remains a separate gate |
| Learner | `apps/learner` | Expo/React Native primitives exported for responsive web; `/` connects to the API and `/demo` is the labeled public demo |
| Admin | `apps/admin` | React/Vite demo plus an explicit fetch-adapter boundary; demo state is not server authority |

The public contracts come from [Course SDK](https://github.com/roeehrl/course-sdk). The API must depend on an explicit versioned SDK release asset, with SHA-512 integrity recorded in its own lockfile. A sibling SDK checkout, a Git branch, a private course repository, or an unreleased local tarball is not a CI dependency. Local `@course-core/*` file dependencies must match the registered module name and its exact directory in this repository; the SDK remains a release URL.

## Getting started

From the repository root:

```sh
node --version                 # v26.x
npm run test:infra
npm run audit:public
```

Root infrastructure checks use only Node builtins. The source audit examines tracked and non-ignored untracked files plus all eight required component lockfiles. It performs no repository or provider fetches. An in-progress module without its manifest/lock fails the full audit; an individual module command audits all public source plus the locks required for that command.

To work on the public learner demo independently of API integration:

```sh
node scripts/orchestrate.mjs install learner
node scripts/orchestrate.mjs browsers learner
npm run check:learner
npm --prefix apps/learner --workspaces=false start
```

Open `/demo` on the development server for the labeled public demo. `/` is the connected learner host and needs the API; a frontend-only server does not provide that backend. `check:learner` first builds its recursive local dependencies (including visuals), creates the production web export, then runs typechecking, unit/component tests, Expo compatibility checks, and the app's `/demo` Playwright workflow/accessibility suite. Stop the development or preview server before browser tests; the tests own their server and port. The learner suite currently uses Google Chrome. Browser installation also installs Playwright Chromium for the other app's default browser projects. Linux CI adds `--with-deps` to install the required system libraries.

The admin equivalent is:

```sh
node scripts/orchestrate.mjs install admin
node scripts/orchestrate.mjs browsers admin
npm run check:admin
npm --prefix apps/admin --workspaces=false run dev
```

An unfinished admin/browser integration fails with the missing file or script. It is never silently skipped. Both apps must provide Playwright configuration, browser tests, and asserted axe scans before their CI jobs can pass. Refer to the component READMEs for supported demo interactions and adapter contracts.

For independent packages:

```sh
node scripts/orchestrate.mjs install policy
npm run check:policy
node scripts/orchestrate.mjs install providers
npm run check:providers
```

Every install/check resolves local dependencies recursively from runtime, development, optional and peer dependency declarations. Prerequisites are built before consumers, shared dependencies are prepared once, and cycles, missing modules, mismatched names/paths and symlink redirects fail before commands run. Builds and advertised export checks precede public-contract typechecks, which can import the freshly built package. Only selected modules run their tests; dependencies retain separate CI test jobs.

The same commands accept `supervisor` and `visuals`. Supervisor checks also require and execute `test:temporal`; the service owns its disposable Temporal test server and cleanup, not a deployed worker. Install visuals browsers with `node scripts/orchestrate.mjs browsers visuals` before `npm run check:visuals`. Its own `test:browser` suite runs after the library build; the app-specific axe requirement applies to learner and admin. Missing supervisor or visuals integration fails explicitly rather than disappearing from the root matrix.

## Practical exercise sandbox

The [sandbox package](packages/sandbox/README.md) documents the Python execution and grading boundary. It participates in the same dependency DAG as the other modules. Run its build, typecheck and unit checks locally with:

```sh
node scripts/orchestrate.mjs install sandbox
npm run check:sandbox
```

Real Docker tests are an additional mandatory `Sandbox / real Docker Linux` CI job on a GitHub-hosted Ubuntu 24.04 runner. After the unit checks, CI runs `npm run sandbox:pull` and then `npm run check:sandbox:docker`. These root entrypoints reject non-GitHub-hosted or non-Linux execution rather than skipping qualification. The helper selects the native x64 or arm64 digest from the built `QUALIFIED_IMAGES`, verifies the Docker daemon architecture, explicitly pulls that exact Python image/platform, and inspects the image's digest and architecture. The test phase only inspects the prepared image and runs the package's `test:docker`; it never pulls. Missing Docker, missing/wrong images, or any failed test fail the job. The same job then runs `npm run test:self-host`, which builds the [self-host image](deploy/docker/README.md), starts PostgreSQL, the API and the HTTPS proxy under a throwaway Compose project, signs an owner in over HTTPS, checks the restart policy and removes everything it created.

The current hosted job is x64. ARM64 pin selection is supported without emulation; local ARM64 results do not establish hosted x64 qualification. The package's tests cover real computation and wrong/self-awarded results, host-file/environment/network isolation, a read-only root, 128MiB memory limits, timeout/output flooding, cancellation and a shared filesystem admission lock. The reference grader remains outside the learner container. Learner execution retains `--pull=never`; image preparation is separate. No GPU or local model is provisioned.

Sandbox test work under `packages/sandbox/.local` is covered by the existing `.local/` ignore rule and is not uploaded as a CI artifact. Root `npm run check` includes sandbox unit/build checks; the separate Docker job and API practical qualification are also required before treating the full CI matrix as passed. Follow the package README for separately authorized local requalification and failed-cleanup handling. Production isolation, practical learning validity and broader API/evidence acceptance remain separate gates.

## Supported SDK range

Core consumes `@course-core/sdk` only as exact, lockfile-pinned public release assets:

| Component | SDK release |
| --- | --- |
| `services/api`, `packages/adaptation`, `packages/visuals`, `apps/learner` | 0.5.0 |
| `examples/courses` | 0.5.0 |

Course bundles are supported for SDK releases `>=0.1.0 <0.6.0`. Every release in that range keeps course schema 1 and compiled format 1, so the API validates with 0.5.0 and still accepts bundles authored with 0.1.0 to 0.4.0 unchanged: 0.4.0 packs recompile byte-identically (`services/api/test/sdk-compat.integration.test.ts` pins their 0.4.0 digests and runs one through real HTTP and PostgreSQL) and CI loads the example packs, which were authored for 0.1.0 and compile to the same digests under 0.1.0 and 0.5.0. Features from later SDK minors (0.3 `retention`, 0.4 `insert_episode`, 0.5 versioned gates and item types) need the matching release. Bundles from SDK 0.6 or later are unsupported until Core pins that release.

`packages/visuals` imports SDK types only, so its built JavaScript was byte-identical under SDK 0.2.0 and 0.5.0 and the pin move kept visuals 0.1.1. A visuals build's identity is every dist file plus its manifest, minus only the pin of that reviewed type-only dependency. Visuals 0.2.0 added clip, mask, symbol/use and equation nodes, 0.3.0 added springs, staggers, the four-layout set and synchronized panes, 0.4.0 added publish-time scene checks (invariants, goldens) and authoring tools, and 0.5.0 adds images, radial gradients, matrix equations, path morph, colour animation and a camera, with export, device chrome, lazy loading, completion observations and translatable player texts. Core still serves courses that declared an earlier visuals build, limited to that build's render features. See `RELEASES.md` and `packages/visuals/README.md`.

Lesson visuals must be accessible whatever SDK built the bundle: publication refuses
(`PUBLISH_VISUAL_INACCESSIBLE`, details `reasons`: `keyboard`, `renderer_text_alternative`,
`visual_description`) a visual block or a `surface: "visual"` renderer definition whose
renderer extension does not declare `accessibility.keyboard: true` and a non-blank
`textAlternative`, or a visual with a blank description. SDK 0.6 validate refuses the same
(`INACCESSIBLE_VISUAL`, `MISSING_TEXT_ALTERNATIVE`); Core no longer relies on it.

Watching a lesson visual to the end is an observation, never evidence or mastery. The learner
app reports it once per mounted block (`POST /api/enrollments/:id/visual-completions` with the
episode, block, visual and scene fingerprint); the API checks that the block shows that visual
in a lesson the learner can open and that the fingerprint is the released scene's
(`VISUAL_COMPLETION_OUT_OF_SCOPE`, `VISUAL_COMPLETION_STALE`), then appends one
`visual.completed` learning event keyed by enrollment, course version and block. Replays,
scrubbing, remounts and concurrent reports return the same event (`duplicate: true`); nothing
else changes, not even the enrollment revision. Lesson visuals load lazily: the runtime is
created near the viewport and released after a minute away from it (state kept), and they load
eagerly while the debug inspector is open.

### Gates and assessment (SDK 0.5)

Core computes every gate decision itself from persisted, server-issued evidence and records it in `gate_decisions` (migration 036), bound to the gate version, course digest and policy revision. A decision has one of five statuses (`ready`, `needs_evidence`, `needs_help`, `under_review`, `closed_with_gaps`), per-criterion results, a learner-visible reason and concrete next actions. `GET /api/enrollments/:id/gates/:gateId/decision` returns the current decision and `.../decisions` its history. The `complete` command recomputes the decision at commit time; a refusal returns the status and next actions (`GATE_NOT_READY` for versioned gates, `EVIDENCE_REQUIRED` with the 0.4 details for unversioned ones), and a `gateDecisionId` from another tab, policy revision or enrollment is refused (`GATE_DECISION_STALE`, `GATE_DECISION_UNLINKED`). Every learner-visible sentence of a decision also comes as a message code with parameters beside the SDK record (`messages`: the reason, each criterion by ID and each next action by position; stored in `gate_decisions.messages`), and the learner app shows it in the learner's language; the codes are not part of the decision's inputs digest. Decisions recorded before codes existed show their English text.

**Gate review and exception.** When a versioned gate's `appealPolicy` allows it, the learner can ask staff to review the current decision (`POST /api/enrollments/:id/gates/:gateId/review-requests` with the decision ID and a reason, within the policy's window; one open request per gate). Staff with evidence review rights see open requests at `GET /api/admin/courses/:catalogId/gate-reviews` and decide them at `POST /api/admin/gate-reviews/:requestId`: `upheld` with a note the learner reads, or, for staff who may change enrollments, `exception`. An exception is a separate audited grant, not a gate decision: the decision keeps its status and open criteria, nothing becomes evidence, and the objectives are not counted as demonstrated. It lets the learner complete that episode (recorded with the grant on `episode_progress`) on the course and gate version it names, and it does not lift a reached course limit (`GATE_CAP_REACHED`). The learner never reviews their own request.

Versioned gates need independent success in the declared families, independent transfer on production work (recognition never counts) and no unresolved critical misconception; Core refuses recognition-only gates and gates that cannot collect transfer or misconception evidence at publish. Unversioned 0.4 gates keep their 0.4 family-count rule and gain the same false-mastery rules: when the gate offers any task beyond choosing among given answers (or a judged conversation), an objective needs one such independent success, and a declared critical misconception the learner showed blocks readiness until a later independent success on an item exposing it. A 0.4 gate of choice items only stays publishable, so SDK 0.4 bundles keep working unchanged, but the release shows staff a warning (`LEGACY_RECOGNITION_ONLY_GATES`) that it can be passed on recognition alone. Prediction and trace items are graded deterministically (prediction honours relative tolerance and units; a value stated in another unit of the same kind, such as mm for cm or km/h for m/s, is converted before the tolerance is applied, while a unit of another kind is refused as `UNIT_MISMATCH`), code repair uses the installed code evaluator, and counterexample, experiment-design and teach-back tasks go to quoted human review. "I don't know" is recorded without evidence or a failed result, and optional confidence is stored but never graded. A course retention policy without intervals uses 1, 3, 7 and 21 days.

A versioned gate may name a `conversationalRubricRef`, and an unversioned 0.4 gate a `conversationalEvaluatorId` that names a 0.5 evaluator definition bound to exactly one course rubric. The learner explains in their own words (`gate-conversation:<gateId>`) and a reviewer may ask neutral follow-up questions in the same thread. When the learner has opted in to AI drafts and a reviewer model is configured, the supervisor proposes quoted findings by itself for every turn, reading the earlier turns too (staff can also ask). The host verifier refuses any proposal whose "met" findings do not quote the learner's own words verbatim; a reviewer's question is not the learner's words. A verified proposal is still a draft. Evidence needs confirmation: a human reviewer who quotes the learner, or, for an evaluator declared `method: 'deterministic'`, the installed, integrity-matched adapter's `confirmConversationFindings`. Core records deterministic confirmation only as "met", and only when every finding the proposal marks met is confirmed and every required criterion is met. Otherwise it records why (`automaticCheck` in the review queue) and the answer waits for a person. A model impression without quotes therefore never produces evidence or a ready decision. Core refuses a conversational gate at publish unless its rubric requires cited evidence and its evaluator requires human confirmation or is deterministic with an installed confirmer. A 0.4 conversation counts as one item family, so its listed items must supply the remaining families (`PUBLISH_GATE_EVIDENCE_UNREACHABLE`). A `conversationalEvaluatorId` that names a bare extension has no rubric to cite and is still refused (`PUBLISH_CONVERSATIONAL_GATE_UNSUPPORTED`). SDK 0.5 lists no conversation item type, so a deterministic conversation evaluator declares one of the deterministic item types in `itemTypes` and binds the rubric through `rubricIds`. No deterministic confirmer ships with Core, and scripted models in tests show the host's checks, not any model's quality. An answer that reproduces a sentence of a companion reply is refused as agent-authored.

### Activity runtime (SDK 0.5 activities)

Core publishes an activity block only when every target the course declares runs on an installed runtime or has an objective-equivalent fallback, its required capabilities are implemented by the broker (`state.read`, `state.patch`, `observation.emit`) and offered by the runtime, and a declared evaluator is installed. Two execution adapters run: Core's own declarative interpreter (`course-core-declarative-activity`, no course code) and `sandboxed_web`, an installed script whose sha256 is its integrity. An observation is never evidence; only an installed evaluator's result is (`activity_evidence`, migration 059). Staff copies of a learner's record leave out activity state and observations (`activity-work`).

**Built-in answer check, no host install.** Core also ships `course-core-declarative-evaluator`, a data-only checker for declarative activities (it runs no course code). A course uses it like the declarative interpreter: it declares the extension with the id, version and integrity that `GET /api/runtime/extensions` advertises and adds an SDK evaluator definition (`method: 'deterministic'`, `humanConfirmation: 'none'`) naming it. The key is the course's own server-only assessment items, graded exactly as Core grades questions: control `<controlId>` of activity `<activityId>` is checked by item `<activityId>.<controlId>` (numeric for a number control; choice, with its correct option among the control's options, for a choice control; toggles are not checked). A submission passes when every checked control matches. The key never goes into block configuration, which the learner receives. Feedback is an admin setting, never part of the key: if the admin section whose id is the evaluator definition's id has a boolean `show-mismatched-controls` setting and staff turn it on (for the course, a chapter or one enrollment; audited), a result that did not pass names the labels of the controls that did not match. Activity evaluators receive these admin-section values for the learner's enrollment. Publication refuses a key the checker could not apply with `PUBLISH_EVALUATOR_CONFIGURATION_INVALID` and a `reason`. Courses that need other judgments (code, prose) still use an installed evaluator. `examples/courses` builds and runs such a course from the released SDK alone (see its README, "Clean-room author proof").

**What a sandboxed web activity can still do.** The frame has an opaque origin (`sandbox="allow-scripts"`, never `allow-same-origin`) and a CSP with `default-src 'none'` and `connect-src 'none'`, so fetch, XHR, WebSocket, beacons, subresources, nested frames, workers, plugins and forms are blocked. CSP does not cover two of the routes; before the activity script runs, the frame bootstrap closes both:

- WebRTC: the RTC constructors are removed and cannot be restored.
- Network hints: WebKit (Safari) preconnects to `<link rel=preconnect>` hosts despite `default-src 'none'`, and may resolve `dns-prefetch` names. The bootstrap keeps every link with a hint rel (`preconnect`, `dns-prefetch`, `prefetch`, `preload`, `modulepreload`, `prerender`, `next`) out of the document. It also keeps out nested frames and plugins, and no meta element can carry `http-equiv` (inserted with it, or given it afterwards through `setAttribute*`, `setAttributeNode*`, `NamedNodeMap`, `httpEquiv` or an `Attr`). It patches and pins every insertion, parsing, cloning and attribute entry point it knows (node insertion methods, `innerHTML`/`outerHTML`/`insertAdjacentHTML`, `Range`, `DOMParser`, `importNode`/`adoptNode`/`cloneNode`, template content, table and select setters, `setAttribute*`, `Attr` and `relList`), and it refuses `document.write`, `designMode`/`execCommand`, `attachShadow` and `setHTMLUnsafe`. Caller-supplied names and values are converted to strings exactly once, and the converted strings are both checked and passed on, so a `String` object or a `toString` that changes between calls cannot slip a hint past the check. The WebKit browser suite (`browser/activity-hints.spec.ts`) checks this against a local listener. No HTTP header stops explicit hints in WebKit; the frame also sends `X-DNS-Prefetch-Control: off`, which only affects automatic prefetching where it is honoured. This is a JavaScript-level defence: a DOM entry point it does not list (a new browser API) could still create a hint.

Navigating the frame is limited by the learner page, not the frame: the learner app's CSP `frame-src 'self' https://www.youtube-nocookie.com` stops the frame navigating to (or being redirected to) any other host, in Chromium and WebKit. The host also stops a frame that leaves Core's document. These guarantees hold only while the learner app is served with Core's Content-Security-Policy (the API server sets it on every response); a proxy that drops or loosens it removes them.

What remains, as far as the review found:

- Navigation to Core's own origin. The request is unauthenticated: the frame's origin is opaque and the session cookie is `SameSite=Strict`, so it reaches only public routes, but its URL can carry data into Core's access logs.
- Navigation to `www.youtube-nocookie.com`, which the learner page allows for reviewed videos. Plausible as a channel; not tested.
- HTML the learner pastes into an editable region inside the activity, which bypasses the script-level guard.
- `dns-prefetch` hints, which make no connection and could not be observed in local tests. The guard keeps them out of the document the same way as preconnect.

So treat anything an activity script can read (its configuration, its granted state and what the learner types into it) as something it could send out. It never receives credentials, the learner's identity or other activities' data. Do not put sensitive data in activity state or configuration, and install only sandboxed activity code you have reviewed. The admin release checks show this warning whenever a `sandboxed_web` runtime is installed.

### Browser practice runs (Python)

A Python code exercise in a lesson check (practice or independent mode) in the connected learner app has a **Run in browser** button with Stop, Reset Python, an optional JSON sample input for `solve(input)` and an output pane (a polite live log; status changes are announced). It runs the learner's code with [Pyodide](https://pyodide.org) on the learner's own device. These runs are practice and feedback only. Nothing about a browser run is sent to the server, the runner routes are read-only, and the answer schema refuses any client-supplied result, so a browser run never creates an attempt, evidence or a gate decision. Grading stays with **Run code & check**, which uses the registered server evaluator in the Docker sandbox (`services/api/test/python-runner.integration.test.ts`).

**Isolation.** The learner page loads Core's runner document (`/api/python-runner/frame`) in an iframe with `sandbox="allow-scripts"`, never `allow-same-origin`, and the document's own CSP repeats `sandbox allow-scripts`. It therefore has an opaque origin even if it is opened directly: no cookies, no storage of Core's origin and no access to the parent's DOM. Its CSP is `default-src 'none'`, `connect-src 'none'`, one hash-pinned script, `worker-src blob:` and `script-src blob: 'wasm-unsafe-eval'`. The second is only so that the frame can start its worker and compile WebAssembly; blob URLs belong to the frame's own opaque origin. Pyodide and the learner's code run in one dedicated worker that inherits that policy. Before any learner code runs, the worker also replaces `fetch` and removes `XMLHttpRequest`, `WebSocket`, `EventSource`, `WebTransport`, `importScripts`, nested workers, `indexedDB`, `caches` and `BroadcastChannel`. This is the same opaque-origin model as the [activity runtime](#activity-runtime-sdk-05-activities). A separate port or host was not needed: the local pilot stays a single origin on its port, with no pilot or proxy configuration change. The worker has no DOM, so the network-hint routes described for activity frames do not exist there.

**Watchdog and budgets.** The frame's watchdog terminates the worker at the run's wall-clock limit (10 s by default) and when the output passes 64 KiB, counted in UTF-8 bytes. A stopped, crashed or over-limit run leaves no worker behind; the next run starts a fresh interpreter. The worker caps WebAssembly memory growth at 256 MiB, so Python raises `MemoryError` instead of exhausting the tab; this is a JavaScript-level guard on Pyodide's heap growth, not a browser process limit. The page keeps an outer watchdog: if the frame does not say hello within 15 s, does not load Python within 90 s, does not report within the limit plus 2 s, or does not answer Stop within 1 s, the page removes the frame, which ends its worker. A page has at most one runner frame and one Python worker. The worker's memory is outside the 250 MB shell budget in [performance budgets](docs/performance-budgets.md). The shared limit code is plain JavaScript that the unit tests execute byte for byte (`services/api/test/python-runner.test.ts`, `apps/learner/tests/pythonRunner.test.tsx`). A Chromium and WebKit browser journey at phone, tablet and desktop sizes (`apps/learner/tests/connected-web/python-runner.spec.ts`) checks print output, a runaway loop killed at the limit, Stop, the output and memory caps, that no request reaches a local listener, that the parent's cookie and storage are unreadable, that nothing new is recorded on the server, and axe.

**Vendored runtime and its licence.** The runtime is the unmodified `pyodide` npm release 314.0.7. It is pinned exactly in `services/api/package.json` and by sha512 in its lockfile, and the API serves five of its files from Core's own origin at `/api/python-runner/assets/314.0.7/` (about 13.5 MB, about 6.3 MB gzip, served compressed and with immutable caching). At startup the API refuses any installed file whose size or SHA-256 differs from its pins (`PYODIDE_FILES`). The learner bundle carries the same pins and checks every downloaded file before handing it to the frame (`PINNED_PYODIDE`; a root test keeps the two lists equal). No CDN is contacted at runtime. Pyodide is under the Mozilla Public License 2.0. MPL-2.0 is file-level copyleft and allows its unmodified files to be distributed as part of a larger work under other terms, so serving them unchanged next to Core's Apache-2.0 code is compatible. The MPL terms still apply to those files, and their source is linked from the runner panel and from the API's `/api/python-runner` response ([pyodide 314.0.7 source](https://github.com/pyodide/pyodide/tree/314.0.7)). The files are not copied into this repository or into the release archives: they come from the lockfile-pinned npm package when the API is installed, and the release dependency notice lists the package and its licence. The learner web export does not change size.

**Where runs are offered.** Only on lesson checks (`practice` and `independent` challenge modes, an allow-list in `apps/learner/src/connected/code.ts`). Running one's own code is what a learner does in any editor, and only the server evaluator grades. Checks that measure what the learner already knows or still remembers without help get no runner: placement items (they place the learner past known material) and delayed retention checks (the held-out check of what was retained). Any other or future mode gets none until it is added deliberately.

**Configuration.** Practice runs are on by default. `PYTHON_BROWSER_RUNS=disabled` turns them off for a host, and `PYTHON_BROWSER_RUN_TIMEOUT_MS` (100-60000) sets the wall-clock limit. The page checks the files with Web Crypto, or with the same SHA-256 in plain JavaScript on a plain-HTTP page that has no Web Crypto. SDK 0.5 has no per-exercise switch: every Python `code` and `code_repair` lesson check gets the button when the host enables runs. A per-item flag (for example `browserExecution: 'python' | 'none'` on code items) needs an SDK release; until then this is host-level configuration.

**Limits.** Learner code may use the device's CPU until the limit and holds up to 256 MiB of WebAssembly memory. Only the Python standard library is available: no packages are loaded, and `input()` reads end-of-file. Runs are synchronous, so top-level `await` is not supported and promise callbacks finish after the run. A run's state (imports, module globals) persists between runs until a limit, Stop or Reset starts a fresh interpreter. Each run gets a fresh `__main__` namespace.

## API tests with disposable Postgres 17

The API currently pins the public SDK `0.5.0` release asset and its lockfile integrity. Root API checks require that explicit released dependency; a missing or mismatched pin fails instead of falling back to a development SDK. Future SDK upgrades and matching child lockfile changes remain the module owner's responsibility.

Use a new disposable database, never an application database. For example, start a separate local container with no persistent volume:

```sh
docker run --rm --detach --name course-core-ci-local \
  -e POSTGRES_USER=course_ci \
  -e POSTGRES_PASSWORD=course_ci_test_only \
  -e POSTGRES_DB=course_core_ci \
  -p 127.0.0.1:55432:5432 \
  --health-cmd='pg_isready -U course_ci -d course_core_ci' \
  --health-interval=5s --health-timeout=5s --health-retries=20 \
  postgres:17
```

Wait until `docker inspect --format '{{.State.Health.Status}}' course-core-ci-local` reports `healthy`, then:

```sh
node scripts/orchestrate.mjs install api
node scripts/orchestrate.mjs browsers api
env -u DATABASE_URL \
  TEST_DATABASE_URL=postgres://course_ci:course_ci_test_only@127.0.0.1:55432/course_core_ci \
  npm run check:api
docker stop course-core-ci-local
```

`install api` installs and builds the resolved API dependency graph from the separate locks. Current local API dependencies include policy, providers, supervisor and sandbox; the graph is read from manifests, not a hard-coded API list. The learner is an additional preparation root for the connected browser suite, so its visuals dependency is also prepared. `check:api` rebuilds the full prerequisite graph, then runs API unit/database tests and the required `test:browser` suite. The export and browser suite share the same checkout lock; no output is borrowed from a parallel CI job.

The hosted-Linux API job also has a mandatory practical exercise gate. After the API build from `install api`, it explicitly runs `sandbox:pull` on its own runner, then `check:api:practical`. This root wrapper verifies the built API, qualification entrypoint, real Postgres 17 connection and prepared image, then runs the API's `test:practical` (`qualification/practical-flow.ts`) with only the validated `TEST_DATABASE_URL` and selected `COURSE_SANDBOX_IMAGE` as task-specific settings. It never pulls during qualification or falls back to an application database. The same pinned Python image policy is shared with the sandbox job; their Docker stores are separate.

The practical fixture is public sorting/comparison data. The real Postgres/real Docker flow checks correct and wrong programs, duplicate-answer replay with one persisted attempt/evidence result, and oracle privacy. Missing scripts, source/build files, database, image or failed assertions fail CI. `check:api` alone does not claim this Docker acceptance; `check:api:practical` is an additional required CI command, with the same GitHub-hosted Linux restriction as the sandbox Docker gate. Test schema and `.local` storage cleanup belong to the API qualification script.

The connected suite uses the test-only host in `services/api/browser/start.ts`, Google Chrome, and a fresh per-run schema. CI serves it on the fixed loopback ports **4317** (main host) and **4318** (the `localhost` passkey host). Local runs pick free loopback ports, so suites in separate checkouts can run at the same time. Set `COURSE_BROWSER_PORT` and/or `COURSE_BROWSER_PASSKEY_PORT` to choose them yourself, or `COURSE_BROWSER_PORTS=fixed|free` to choose the mode (`services/api/browser/ports.ts`). Root commands such as `npm run check:api` run their children with `CI=true`, so they pass the mode from your own `CI` setting and forward these variables. The Playwright configs pass the chosen ports to the host and to test workers. The admin real-API suite (`apps/admin`, `test:real`) follows the same rule: port **4384** in fixed mode (CI), a free loopback port in free mode (local), or `COURSE_ADMIN_REAL_PORT`. It exercises signed-in lessons, independent evidence, reloads, server gates and sign-out on desktop, phone and tablet. It complements the original `/demo` workflow/axe suite; both remain required. Missing browser configuration, host, suite or export is a failure.

The credentials above are public disposable-test values. Do not reuse them for an application. Root checks require a loopback PostgreSQL URL and a database named `course_core_ci` or `course_core_test[_suffix]`, reject an ambient `DATABASE_URL`, and query the actual server to require PostgreSQL 17. API unit and browser tests receive only `TEST_DATABASE_URL`; they own isolated test schemas, migrations, cleanup, transactional assertions, and concurrency negatives. This does not invoke the application's migration CLI or modify an application database.

## Course catalogue and release selection

The learner catalogue presents one administrator-selected published release per
course. Publication selects the newly published release; administration can use
**Use for new learners** to select an earlier published version. These operations
retain enrollment pins, assessment evidence, progress and course windows.
Existing enrollments remain resumable, and explicit historical release IDs remain
supported for deliberate enrollment and staff assignment.

`GET /api/workspaces/:workspaceId/courses` returns the selected releases.
Authorized staff may request `?includeHistorical=true` for release history;
draft metadata retains its existing owner/admin/author/reviewer restriction.
The admin release response exposes `availableForNewLearners`, and its revisioned,
idempotent transition endpoint accepts `activate` with publication permission.
Selection revalidates the immutable bundle and installed runtime capabilities.
Migration015 chooses the newest already-published release for existing catalogues
without changing any saved enrollment. Published content remains immutable.

### Editing a draft safely

Staff edit a draft's chapters and lessons as forms in the admin app: titles,
summaries, order, which lessons are required, which objectives a lesson teaches,
and its reading text. Checks, visuals, media and activities stay as they are and
are changed in the whole manifest file (still available as an advanced tab).
Saving always asks the server first:

- `POST /api/admin/courses/:courseId/releases/:releaseId/check` (`course.write`)
  validates a manifest exactly as saving would, without saving it: SDK problem
  codes with their JSON paths, whether the course id and version match the draft,
  whether this runtime could run it (the publication gate's code), and what it
  changes against the live release.
- `POST /api/admin/courses/:courseId/releases/:releaseId/preview` shows the saved
  release, or an unsaved manifest, as four made-up representative learners (just
  starting, tested out of placeable objectives, finished the first chapter, nearly
  finished). Each roadmap is computed by the learner engine; completed gated lessons
  use the engine's own staff-exception path on that exact digest, so no evidence is
  invented. Drafts and unsaved manifests are visible to owners, admins, authors and
  reviewers only.
- `GET /api/admin/courses/:courseId/releases/:releaseId/publish-impact`
  (`release.publish`) is the affected-learner analysis for publishing forward:
  who stays on the live release (nobody moves), how many are part-way through a
  lesson the draft changes or removes, recent enrollments, changes by kind, and
  which defective items the draft fixes or carries over, with an `impactDigest`.
  Publishing from the admin route requires that digest while any learner is pinned
  to the live release (428 `IMPACT_CONFIRMATION_REQUIRED`, 409 `IMPACT_CHANGED`).

## Platform operations

Owners and administrators of a workspace have two more admin pages.

- **Platform** (`GET /api/admin/workspaces/:id/platform-readiness`): the database
  (PostgreSQL version, latency, migrations applied against the ones this build
  ships), the Temporal worker (when it last reached this API, waiting and held-back
  events), the grading sandbox, telemetry export (spans sent and dropped), versions
  (Core, SDK, Node, course file format), and backups. The recovery targets are
  checked from the backup tool's reports (`platform_backup_reports`, migration 100;
  see `deploy/local/README.md`): RPO 60 minutes from the newest snapshot or backup,
  RTO 60 minutes from the latest restore drill, drills at most 7 days old. Each
  failing part says what to do. Worker contact is kept in memory per API process.
- **Integrations** (`GET /api/admin/workspaces/:id/integrations`): installed
  extensions, whether each course's live release can run on them, course package
  install receipts, update checks, AI provider connections (status only) and
  whether telemetry export is on.
- **Billed versus estimated cost** (`GET|POST /api/admin/workspaces/:id/billing-statements`):
  staff type in what a provider billed for up to 92 days (from its invoice or usage
  page; never a card or account number). Each figure is listed next to the spend
  ledger's estimate for the same UTC days, its unsettled part and the difference.
  Core never fetches billing data, and every cost the admin app shows is labelled
  as an estimate.
- **Audit export** (`GET /api/admin/workspaces/:id/audit/export?format=csv|json&from=&to=`,
  `audit.export`: owners and admins) downloads up to 10,000 events of at most one
  year, with the audit page's privacy projection. CSV cells that a spreadsheet
  would run as formulas are prefixed with a quote mark. The download is itself an
  `audit.exported` event with the file's digest.
- **Policy history** (`GET /api/admin/courses/:id/policy-history`, `policy.read`):
  one response for both admin pages. `entries` lists course policy settings,
  placement settings, the organization limits above the course and the learning
  policy of each published release, each as a field-by-field diff from the one
  before; `revisions` lists the stored revisions of the course settings and
  organization limits with their reason and who saved them.

## Installing a course

Administration installs a course from one **course package** (course-package v1, a
`<courseId>-<version>.course.tgz` file made with the course SDK's packer) instead of creating
a draft and pasting a manifest. In **Course & releases**, an owner or administrator chooses
**Install course**, then either uploads the package file or pastes a GitHub link:

- `https://github.com/<owner>/<repo>` or `…/releases/latest` (the latest release),
- `…/releases/tag/<tag>`, or
- `…/releases/download/<tag>/<asset>.course.tgz` (one release file).

**Inspect package** verifies the package and shows a preview without installing anything:
course id, title, version and digest; the SDK it was compiled with against the SDK range this
Core supports; the Core version it needs; whether this workspace already has the course or that
version (an identical digest is reported as already installed, different content for the same
version is blocking); the adaptation (recovery) registry it carries and how many profiles;
every host requirement (a code fixture or teaching verifier the host must already have
configured) as *present, identical*, *present, different* or *missing*; the runtime capability
check; and blocking problems first. **Install draft** creates the release draft from the
package's manifest through the same compile and validation as the draft editor, records the
package digest and source on the release, submits it for review and stages its registry. On the
same screen the operator then approves the review, confirms publication of the exact version and
approves the staged registry (digest-bound), each as an explicit step. An actor holding both
review and publication permission can instead tick **Also approve the review and publish this
version now** and type the exact version. Repeating an install of the same package returns the
existing installation. The manual **New draft** path is unchanged.

Verification is strict and executes nothing from the package. The archive must be gzip-compressed
POSIX ustar holding only top-level regular files (names of at most 100 bytes from
`[A-Za-z0-9._-]`; no directories, links, devices, PAX/GNU records, prefixes, absolute paths or
`..`), at most 200 files, 32 MiB per file, 128 MiB uncompressed and 64 MiB compressed.
`course-package.json` must list every other file exactly once with its size, SHA-256 and a known
role; unknown keys are refused. Core recompiles the course manifest with its own pinned SDK and
requires the listed course id, version and digest (and the learner projection, when present) to
match. Host-requirement files are never installed or run: Core compares their SHA-256 with the
files the host configured (`CODE_FIXTURE_FILES`, `TEACHING_VERIFIER_FILES`) and reports names and
digests only. The verifier is `services/api/src/course-package.ts`; it is structured so it can
delegate to the SDK's canonical verifier once Core pins an SDK release that has one.

**Files a course brings.** A course can carry two kinds of extension in its package instead of
asking the operator to install them: a data-only code fixture registry (hidden input/expected
cases, `execution: 'server'`) and a `sandboxed_web` activity script. The course's extension
declaration pins the bytes by its `integrity`; the package member with that SHA-256 (role
`host-requirement` or `other`) supplies them. The preview lists them under "Files the course
brings" as *already approved*, *needs your approval* or *can't be used here* (with what to do),
and **Install draft** needs an explicit approval of exactly those files
(`approveCourseSupplied: {integrities}`; otherwise `COURSE_SUPPLIED_APPROVAL_REQUIRED`). Nothing
from them runs in the API: Core's own code evaluator grades learner code against the cases in the
networkless sandbox, and the script is served only inside the opaque-origin activity frame (see
"Activity runtime"). Approved bytes are kept with the release (`course_supplied_extensions`,
immutable), loaded at startup and installed host-wide by content: another course uses them only
by declaring the same id, version and bytes. An id already installed with different bytes is
never replaced (`EXTENSION_ID_CONFLICT`). Hidden code cases need the grading sandbox
(`COURSE_SUPPLIED_CODE_FIXTURES=on`, or host fixture files configured); without it they are
reported as `NO_SANDBOX`. Automatic updates never approve new course files
(`AUTO_PUBLISH_REFUSED_COURSE_CODE`).

GitHub links work for public repositories only (a private or missing one is reported as
`GITHUB_REPOSITORY_NOT_PUBLIC_OR_MISSING`). Core resolves the release through
`api.github.com` without credentials, picks the asset named `*.course.tgz` (several: the operator
chooses) and, when the release has a `<asset>.sha256` file, verifies it (one `sha256sum` line
naming the package). Only `api.github.com`, `github.com` and GitHub's release-asset download
hosts are contacted, over https, with every redirect hop checked against that list (at most 5),
connect and read timeouts, a streaming size cap and no cookies or credentials; a pasted URL is
never fetched as given. The operator switch `COURSE_PACKAGE_REMOTE_FETCH` is `github` by default;
`off` disables link installs (uploads still work). Inspected packages are kept server-side for 60
minutes (at most 4 per workspace) so installing does not upload or download them again.

API (owner/admin with `course.write`; approval and publication keep `release.review` and
`release.publish`):

- `POST /api/admin/course-packages/inspect?workspaceId=<id>` with the package bytes
  (`Content-Type: application/gzip` or `application/octet-stream`) or JSON `{"url", "asset"?}`.
- `POST /api/admin/course-packages/:sha256/install` with `{workspaceId, idempotencyKey, notes?,
  approveAndPublish?: {confirmVersion}, approveRegistry?: {configurationDigest},
  confirmOlderVersion?: true}`.
- `GET /api/admin/course-packages/installs/:releaseId` and
  `POST /api/admin/course-packages/installs/:releaseId/registry` with
  `{configurationDigest, expectedRegistryRevision}`.

Inspections and installations are recorded as `course_package.inspected` and
`course_package.installed` workspace audit events (package digest, course, version, source; no
learner data). Migration 077 adds the staging and release-package tables.

**Version direction.** Course versions are semantic versions and move forward in a workspace
(`services/api/src/course-versions.ts`):

- Installing a package whose version is lower than the newest installed version of the same
  course is refused with `OLDER_VERSION_CONFIRMATION_REQUIRED` (409, with both versions) unless the
  install request says `confirmOlderVersion: true`. Administration shows the older version
  plainly and asks for that choice with a checkbox. The confirmed install records
  `olderVersionConfirmed` in its `course_package.installed` audit event.
- Publication refuses a release whose version is not a semantic version (`PUBLISH_VERSION_INVALID`)
  and one lower than a version of the same course already published (or published and later
  archived) with `PUBLISH_VERSION_OLDER_THAN_PUBLISHED` (409, with `newestPublished`), unless the
  publish request says `confirmOlderVersion: true`. This applies to the reviewed transition
  (`POST /api/admin/courses/:id/releases/:releaseId/transitions` with `action: "publish"`), the
  direct `POST /api/releases/:releaseId/publish` (optional body `{"confirmOlderVersion": true}`) and
  install-and-publish. A confirmed older publication is recorded (`release.older_version_published`
  or `olderVersionConfirmed` on `course.published`).
- Returning to a version that was already published is a rollback: select it again with its
  reviewed impact instead of publishing anything. Automatic course updates only ever move to a
  newer version.

## Course updates

Each course can have an **update source** (Course & releases → **Updates**, `course.write`):
a public GitHub release link (same forms, hosts and fetch limits as installing; a repository
link follows its latest release), or a **host folder**: one of the package directories the host
operator allowed (pilot `coursePackageDirectories`, passed to the API as
`COURSE_PACKAGE_DIRECTORIES`) plus a relative path inside it. Administration names a directory
by an id and its folder name only; the browser never sends or sees a host path. Every path is
resolved with `realpath` and refused when it leaves its directory (`..`, absolute paths, symlinks
that point elsewhere). A host folder may hold one `*.course.tgz`, several (the newest
`courseVersion` of this course is chosen; several different files with that version are listed
for a choice) or an unpacked package folder with `course-package.json`, which is packed
deterministically and verified with the same rules and limits as an upload.

**Check for updates** (always available) compares the newest package at the source with the
newest version this workspace has of the course. A newer one is verified and staged and shown
with the install preview and a summary of content changes against the live release; **Update to
<version>** continues with the same install → review → registry → publish steps and
confirmations.

**Automatic updates** are off by default. Per course: `check` (record and show “Update
available” in Course & releases and Overview; install nothing), `install` (also install it as a
draft in review and stage its registry; owner/admin) or `publish` (also approve and publish it;
saved only by someone holding `release.review` and `release.publish`, with an explicit
acknowledgement), every 1–720 hours (default 24). Automatic publication is refused, and the
version left as a draft in review, when the preview has a blocking problem, a host requirement
that is not identical, course files that still need approval, a failing runtime check, an unmet minimum Core version or an SDK outside
the supported range. It never touches existing enrollments. A packaged registry is approved
automatically only at `publish`, and only when its digest equals the live release's approved
registry or the acknowledgement explicitly also covers a changed registry. The saving person's
permissions are checked again on every run. The API runs due updates every
`COURSE_UPDATE_TICK_MS` (default 300000, at least 60000) under a Postgres advisory lock
(single-flight across processes); each attempt is recorded (last check, result, error code) and
audit-logged (`course_update.checked`), and failures wait longer each time (interval × 2^failures,
at most 7 days). Changing the source turns automatic updates off again.

API (`:courseId` is the admin course id): `GET /api/admin/courses/:courseId/updates`,
`PUT …/updates/source` `{expectedRevision, source: {kind:"github", url} | {kind:"path",
directoryId, subpath} | {kind:"none"}}`, `PUT …/updates/settings` `{expectedRevision, level,
intervalHours, acknowledgePublish?, autoApproveRegistry?}`, `POST …/updates/check`. Migration 078
adds `course_update_sources` and `course_update_attempts`.

## Sign-in and sessions

People sign in with a **username and password** in both the learner app (`/`)
and administration (`/admin/`). `POST /auth/login` takes `{ login, password }`
and, on success, issues the same session as before: an HttpOnly, SameSite=Strict
`course_session` cookie plus a readable `course_csrf` cookie whose value every
mutating request echoes in `X-CSRF-Token`, with an exact `Origin` check.

- **Usernames** are a separate `app_users.login_name` column (migration 028), not
  the opaque `subject` (invited accounts have subjects such as
  `invite:<workspace>:<user>`). They are NFKC-normalised, trimmed and lower-cased
  before they are stored or compared, so they are unique case-insensitively:
  3–128 of `a-z 0-9 . _ @ + : -`, starting and ending with a letter or digit. An
  email address works as a username.
- **Passwords** are 12–1024 Unicode code points after NFKC normalisation, with no
  composition rules. They are hashed with Node's built-in scrypt (N=2^17, r=8,
  p=1, 128 MiB, a random 16-byte salt per hash) and stored as
  `$scrypt$ln=17,r=8,p=1$<salt>$<hash>`, so parameters can be raised later: a
  hash made with other parameters still verifies and is re-hashed at the next
  successful sign-in. Comparison uses `timingSafeEqual`. At most two derivations
  run at once per API process (32 more may queue; beyond that `503 AUTH_BUSY`).
- **Failures are generic.** A wrong password, an unknown username and a malformed
  username all return `401 LOGIN_FAILED`, and unknown accounts run the same scrypt
  derivation against a dummy hash, so responses take comparable time.
- **Throttling** is durable in PostgreSQL (`password_login_failures`) and shared by
  every API process using the database. Each attempt is counted as a failure
  before the password is checked (under a per-account advisory lock, so
  concurrent guesses cannot overrun the budget); a correct password clears the
  account's count. Within a sliding 15-minute window an account (keyed by a hash
  of the normalised username, whether or not it exists) allows 10 failures and a
  client address 100; beyond that every attempt, even with the right password,
  gets `429 LOGIN_THROTTLED` with `Retry-After` (the seconds until the oldest
  failure that blocks it leaves the window, rounded up to whole minutes). The address is the TCP peer unless
  `TRUSTED_PROXIES` lists it (see below). A **shared source** (a loopback peer,
  which is where every client of a local forwarder such as `tailscale serve --tcp`
  or an SSH tunnel arrives, or a listed proxy that sent no usable
  `X-Forwarded-For`) is not one client, so it is never locked out as a whole: past
  its 100 failures each username gets only 2 more failures from it in the window.
  One client spraying names through a forwarder therefore cannot lock out other
  users, while brute force on one account stays capped at 10 per window and a
  sprayer gets at most 2 guesses per name. Known and unknown usernames behave
  identically, so throttling reveals nothing about which accounts exist. Each API
  process admits at most as many sign-in attempts as its password derivations can
  run or queue (34); beyond that `503 AUTH_BUSY` before anything is recorded.
  Passkey sign-ins with an unknown credential id share one budget per client
  address. Rows older than the window are deleted as new attempts arrive.
- **Trusted proxies** (`TRUSTED_PROXIES`, off by default) are exact IP addresses of
  reverse proxies that append the client's address to `X-Forwarded-For`. Only for
  a request whose TCP peer is listed is the header read, from the right, skipping
  listed hops; the first other address is the client for the sign-in and agent-key
  throttles (nothing else uses it). Ranges, wildcards and "trust everything" are
  refused. List a proxy only if every connection from that address comes through
  it: a raw TCP forwarder (`tailscale serve --tcp`) or a local process on the same
  address could otherwise send a forged header and choose its own budget.
- **Changing a password** (`POST /auth/password`, signed in, with CSRF) requires the
  current password, is throttled per user, and revokes every other session of the
  account. Both apps offer **Change password** once signed in.
- **Temporary passwords.** Owners and admins can give a workspace member a
  server-generated temporary password from **People & roles** (or when
  inviting, by entering a username). It is 20 random characters (100 bits),
  shown once, never stored in receipts or events, and flagged must-change: it
  creates no session until the person chooses their own password at sign-in
  (`409 PASSWORD_CHANGE_REQUIRED`, then the same request with `newPassword`).
  Setting one revokes all of that person's sessions. The server generates it so
  no weak or reused password is typed by staff. As with sign-in codes, it is
  allowed only for people invited into this workspace who belong to no other
  workspace, because a password signs a person into every workspace they belong
  to; admins manage non-privileged members only, and nobody resets themselves.
- **Host CLI.** On the trusted server host, `set-password` sets a member's
  password; it reads the password from the terminal without echo (twice) or from
  standard input, never from arguments or the environment, and never prints it.
  The username defaults to the account's existing one, else the subject; choose
  another with `--login`. `--temporary` makes it must-change. Existing sessions of
  the account are revoked.

  ```sh
  DATABASE_URL=… npm --prefix services/api --workspaces=false run set-password -- <workspace-slug> <subject> [--login <username>] [--temporary]
  # or, from a built runtime:
  DATABASE_URL=… node services/api/dist/set-password-cli.js <workspace-slug> <subject>
  ```

- **One-time sign-in codes** remain available for future email delivery but are
  **off by default**. Set `AUTH_LOGIN_CODES=enabled` (pilot: `"loginCodes": true`)
  to accept them. While disabled, `POST /auth/redeem` answers
  `403 LOGIN_CODES_DISABLED` without consuming the code, administrators cannot
  issue codes, and the apps show no code field (`GET /auth/options` tells them).
- **Passkeys (optional).** A signed-in person can add passkeys (WebAuthn) to their
  own account from **Passkeys**, next to **Change password**, in both apps, and
  then use **Sign in with passkey** on the sign-in screen. Passkeys are a
  convenience alternative: the password stays primary and always works, and
  deleting the last passkey is allowed.
  - The relying party ID and expected origin come only from the trusted origin the
    request was made from (`PUBLIC_ORIGIN` or one of `ADDITIONAL_ORIGINS`): the
    RP ID is its host name and the origin must match exactly. A passkey registered
    under one origin works only there. Browsers refuse IP
    addresses as RP IDs and require a secure context, so passkeys are offered only
    for `https://<host>` or `http://localhost[:port]`; with `http://127.0.0.1:…`
    they are switched off (`GET /auth/options` reports `passkeys: false` and the
    routes answer `404 PASSKEYS_UNAVAILABLE`). Changing the public host name
    orphans existing passkeys; passwords are unaffected.
  - User verification is required, credentials are discoverable (no username is
    typed or revealed), attestation is `none`, and the WebAuthn user handle is 32
    random bytes per account (not its id, subject or username).
  - Routes: `POST /auth/passkeys/registration/options` and `…/verify` (signed in,
    CSRF, and a session at most 10 minutes old, or the current password in
    `currentPassword`, throttled like `POST /auth/password`; otherwise
    `403 REAUTHENTICATION_REQUIRED`); `POST /auth/passkeys/authentication/options`
    and `…/verify` (exact `Origin`); `GET /auth/passkeys` and
    `DELETE /auth/passkeys/:id` for the caller's own passkeys only (another
    account's id answers `404`). At most 20 passkeys per account.
  - Challenges (`passkey_challenges`, migration 029) are single-use and live 5
    minutes. A registration challenge is bound to the account and the session that
    requested it. At most 10,000 sign-in challenges are open at once across all
    clients, and requesting one is never refused: at the cap the oldest challenge
    of the client address holding the most is dropped. A flood therefore displaces
    its own challenges; clients sharing its address (every device behind a local
    forwarder such as `tailscale serve --tcp` arrives from loopback) lose theirs
    only if the flood issues 10,000 challenges during their ceremony.
  - Passkey sign-in issues exactly the same session and CSRF cookies as a
    password, counts failures in the same `password_login_failures` budget (a
    known account shares its username's budget), clears that budget on success,
    rejects a signature counter that does not increase (counters that stay `0`
    are accepted, as synced passkeys do not count), and refuses an account that
    must change a temporary password (`409 PASSWORD_CHANGE_REQUIRED`, no session).
  - A temporary password from an administrator or `set-password --temporary` is
    account recovery: it also removes the account's passkeys.
  - Tests: real-PostgreSQL API integration with a software authenticator
    (`services/api/test/passkey-auth.integration.test.ts`), and API browser
    journeys (`services/api/browser/passkey.spec.ts`) that register and sign in on
    the learner app and administration at desktop, phone and tablet sizes with
    Chromium's CDP virtual authenticator, against a harness server whose origin is
    `http://localhost:4318` in CI (a free local port, or `COURSE_BROWSER_PASSKEY_PORT`, elsewhere). Playwright has no virtual authenticator for WebKit or
    Firefox, so `playwright.engines.config.ts` skips the passkey journeys there;
    physical-device passkey acceptance remains a separate gate.
- **Session lifetime** defaults to 12 hours. Set `SESSION_HOURS` (fractions
  allowed, at most 720 = 30 days; pilot: `"sessionHours"`). Expiry is computed
  from database time.
- **Ended sessions** (expired, or revoked by sign-out, a password change, staff
  revocation or account erasure) are deleted 7 days after they stop working, by a
  bounded purge every `SESSION_PURGE_INTERVAL_MS` (default 1 hour, minimum 60 s).
  The account keeps only its last sign-in time (migration 080), shown under
  People & roles.

## People and roles

Owners and admins manage workspace membership under **People & roles**
(`/api/admin/workspaces/:workspaceId/people`). Inviting a person creates an
account with a role. With a username, the invitation returns a temporary
password once (see above); when sign-in codes are enabled it can instead return a
single-use sign-in code once (10-minute expiry). Idempotent replays never reveal
or reissue a secret, and secrets are never stored in receipts. Admins manage
only non-privileged roles; owners manage everyone. Nobody changes or removes
their own membership, so a workspace cannot lose its last owner through this
interface. A new temporary password (or code) can be issued only for an account
invited into the same workspace that belongs to no other workspace, because it
signs a person into every workspace they belong to.
Removing a member ends access immediately (sessions end when they have no other
membership) while their enrollments, evidence and history are retained for
audit, export or separate deletion. Every change appends a `people.*` event.
The bootstrap CLI remains the trusted way to create the first owner.

## Reviewed written answers (rubric assessments)

Courses can require written explanations (`type: "rubric"`) by declaring the
built-in `course-core-reviewed-rubric` evaluator (version 1.0.0) with the
integrity Core reports at `GET /api/runtime/extensions`; publication fails if the
running installation does not provide it. Learners see the rubric criteria up
front. A submitted answer (20–8000 characters) creates no evidence: it waits in
the **Answer reviews** queue for an owner, admin, instructor or reviewer who is
not its author. A criterion can be marked met only with an exact quotation from
the learner's answer; the decision must match the required criteria. "Met" and
"not met" become evidence (independent only if the item was answered without
help or prior exposure); "needs clarification" records no judgement and sends a
note to the learner. Each answer is reviewed once, and changing a rubric makes
older submissions unreviewable under the new criteria.

**Conversational gates.** A versioned (SDK 0.5) gate with
`conversationalRubricRef`, or an unversioned 0.4 gate whose
`conversationalEvaluatorId` names an evaluator definition bound to exactly one
rubric, is supported. Its conversation item (`gate-conversation:<gateId>`) goes
through this same quoted review and clarification conversation. Only confirmed,
quoted findings on the gate's current rubric version count: a person's review,
or a deterministic evaluator's confirmation of a verified supervisor proposal
(see "Gates and assessment" above). A `conversationalEvaluatorId` that names a
bare extension has no rubric to cite, so publication refuses it with
`PUBLISH_CONVERSATIONAL_GATE_UNSUPPORTED` (409, `details.gateIds` names the
gates), whatever extensions are installed. A rubric assessment in a gate's
items remains supported too.

**Conversation.** A clarification request can be answered by the learner in the
same thread (`POST /api/enrollments/:id/reviews/:attemptId/reply`, once per
request); the reviewer then judges the exchange and may quote any of the
learner's turns. The reply stays independent only when the reviewer declared the
note a neutral question (`probeOnly`) and the learner asked the companion
nothing since; otherwise it counts as practice. While a clarification request is
open the learner sees only the reviewer's note, never the per-criterion findings
(the review view and the export both withhold them until the exchange is judged).

**Second opinions.** After a met or not-met decision the learner may appeal
once with a reason (`POST /api/enrollments/:id/reviews/:attemptId/appeal`). A
reviewer other than the original one and the learner re-reviews the same answer
under the same quoting rules (`/api/admin/courses/:catalogId/rubric-appeals`,
`POST /api/admin/rubric-appeals/:appealId`). A changed decision invalidates the
original evidence and records the new one; an upheld decision changes nothing.
The learner sees the outcome and the reviewer's note.

**AI drafts for reviewers.** With the learner's separate opt-in
(`/api/enrollments/:id/review-assist`, off by default), a reviewer may queue a
draft of the findings (`POST /api/admin/rubric-reviews/:attemptId/assist`); for
a gate conversation the supervisor proposes one itself on every submitted turn
(`origin: "supervisor"`). It runs as a budgeted `reviewer` supervisor job that
sees only the question, rubric, answer and the earlier turns of the same review
conversation, and is shown only after the host verifies that every "met" finding
quotes one of the learner's turns verbatim and nothing changed since the request.
A draft that fails those checks ends the request as `rejected` with a reason, and
the reviewer may ask again with a fresh request.
A draft is never evidence or a grade; only a gate's deterministic evaluator (see
"Gates and assessment") may confirm one. See `services/api/RUBRIC_ASSIST.md`.

## Supervision loop

After a learner's opt-in the supervisor's trigger table starts teaching actions as
supervisor work (contrast cases, changes of representation, transfer checks, worked
examples, review preparation), runs new material as a planner, two concurrent builders and
an evaluator that alone commits, and follows a delivered change up 24 and 72 hours later
through parked `follow_up_due` jobs. Goal, grading and paid-ceiling changes wait
(`needs_input`) for the learner or an owner/admin. Owners and admins set the autonomy
level, permitted tool families and each learner's daily and per-lesson AI limits. See
`services/api/SUPERVISION_LOOP.md`.

## Agent evaluations

`npm run eval:agents` (in `services/api`) runs Core's public agent eval suite: curated
novice, expert, terse, guessing, uncertain, frustrated, adversarial and inconsistent
dialogues over the public example packs, graded deterministically for hint leakage,
grounding, diagnosis restraint, factuality, authority, tool scope, quotes, citations and
privacy. It drives the real role,
strategy and adapter path with an offline scripted model; a live mode needs an explicit
opt-in and operator credentials and never runs in CI. A course can run its own private
held-out set with `--fixtures DIR`.

Every agent role is evaluated: companion, supervisor plan and tool loop, research,
reviewer and media (`--all-roles`). A new or changed provider, model or prompt revision of
any role activates only with a passing recorded evaluation of that exact revision or an
owner's audited override; a role bound to a strategy the suite does not cover needs the
override. The gate applies at activation only: nothing is turned off at upgrade. Roles
that are on without evidence for the current suite (saved before the gate, turned on while
their strategy was not covered, or checked against an older suite) keep running, unrelated
saves still work, and the admin AI services page lists them with **Run quality check** for
the active setup and an owner's approval; changing such a role's model needs one of the
two. See `services/api/AGENT_EVALS.md` and the upgrade notes in `RELEASES.md`.

## Policy levels

Each new enrollment's policy is one hierarchy: **organization → course →
enrollment → chapter → episode**. The organization level carries the workspace's
ceilings (`/api/admin/workspaces/:id/policy-ceilings`, owners and admins: an end
date, the longest enrollment in calendar days, work caps, whether extensions exist
at all, and whether finished learners keep reading). The course level carries the
release's policy and the course policy settings; the enrollment level starts empty
and holds one learner's own tighter terms, changed through the audited per-learner
or cohort migration (`scopeId: "enrollment"`). Ceilings and settings apply to new
enrollments; existing learners keep the terms they started with. The effective
deadline is the earliest on the path and every quota on the path must have room.
A change to a level that would loosen its parent (a later deadline or a larger
work cap than an ancestor) is refused with `LOOSER_THAN_PARENT`; an authored
course or chapter setting that is looser than an ancestor is clipped and disclosed
as `LOOSER_CHILD_DEADLINE` in the feasibility check. Every resolved constraint
carries `binding`: the scope and level whose deadline is the effective one, and for
each work counter the level with the least room left. The ceilings preview runs
the feasibility check of every course against the proposed ceilings before
anything is saved. Saved organization and course settings keep their history
(`policy_setting_revisions`, `GET /api/admin/courses/:id/policy-history`), and each
enrollment's policy at every revision is kept (`learning_policy_revisions`,
`GET /api/admin/enrollments/:id/policy-revisions`).

## Extension allowances

A release declares calendar-day allowances per scope. Administrators may add pools
in the course policy settings (`extensionPools`): a named unit (`calendar_day`
moves a deadline, `planned_minute` and `episode` raise a work cap), the scopes it
covers (`course`, `every_chapter`, `every_episode`), whether the balance is
`shared` across them or one per scope, a total, a per-grant maximum and a grant
count, plus an optional ultimate ceiling on the course end
(`extensions.ultimateDeadline`). The settings preview flags a pool that can never
be used (a day pool on scopes without a deadline, a minute or episode pool on
scopes without that work cap). Extension requests name `days`, `minutes` and/or
`episodes` (and optionally the `poolIds` that pay); each unit is paid by one pool
enabled at that scope, and the policy still checks every balance, per-grant
maximum and ancestor cap. `GET /api/admin/courses/:id/allowances` lists, across
learners, accepted offers waiting for an administrator (approve or reject through
the per-enrollment routes), every offer and grant, accommodations, and pool use.

## Assessment policy

The course policy settings include the graded-attempt policy (`assessment`):
`maxGradedAttemptsPerCheck` (graded, independent attempts at one check; `null`, the
default, is no limit) and `retryCooldownMinutes` (the wait after a graded attempt that
did not pass; `0`, the default, is none). A check is an episode's gate, counted across
every item it lists, or a single item where the episode has no gate. The server refuses
a graded challenge, and a graded answer to a challenge opened earlier, past the limit
(`ATTEMPT_LIMIT_REACHED`, with `used` and `limit`) or during the wait
(`RETRY_COOLDOWN`, with `retryAt`); the learner sees how many attempts the check allows
or when the next may start. Practice, placement and spaced review are never limited and
recorded attempts and evidence never change. Like the other settings, an enrollment
keeps the policy in force when it started. `GET /api/admin/enrollments/:id/assessment-attempts`
shows use per check, and owners and admins can allow one more attempt at a check with a
reason (`POST …/assessment-attempts/grant`, recorded as `assessment.attempt_granted` on
the learner's events), which also ends any wait there.

## Individual accommodations

Owners and admins can give one learner an accommodation (extra calendar days on
a scope's window or absolute deadline, extra planned minutes or episodes) or an
approved pause (moves a pause-enabled window only) or an outage adjustment
(time lost to a service outage: moves a deadline, never adds work) through
`/api/admin/enrollments/:id/accommodations/preview` and `…/apply`, or the
**Accommodation for this scope** action in the Policy view. The apply step needs
an unexpired preview made by the same person against unchanged revisions, records
an audited authority receipt, and does not draw on extension pools or affect
other learners. The reason is a reference such as an approval ticket, not
health or personal details.

The same adjustment can be applied to many learners at once
(`/api/admin/courses/:id/accommodations/batch/preview` and `…/apply`, at most 500
learners, default every active learner in the course): the preview shows each
learner's deadline before and after and which learners it cannot apply to and
why; apply is all-or-nothing against the previewed revisions, records one
batch (`policy_accommodation_batches`, who, when, why, how many) and each
learner's own ledger entry naming the batch (`accommodation_overrides`).

## View as learner

Owners and admins can debug teaching by opening a read-only view of what one
learner sees (`GET /api/admin/enrollments/:id/learner-view`, **View as learner**
in Enrollments): path and progress, the current lesson with its visuals, applied
personal changes, gate evidence, open checks, written-answer reviews and the
course-made media attached for the learner (title, state, player with captions or
a placeholder, transcript and description). Every
opening is recorded before anything is read (an append-only record of who, in
which role, which enrollment and when), and the learner sees each view in their
data panel and export. The view shows the enrollment profile (display name,
learning goal and pace) like the rest of enrollment administration. The view
cannot act as the learner and creates no learner session; the companion
conversation, the learner model and drafts stay private.
Attached clips and captions play from
`GET /api/admin/enrollments/:id/learner-view/:viewId/media/:attachmentId/{asset,captions.vtt}`
only for the owner or admin whose recorded view `viewId` is, within an hour of
opening it, and only while the learner can see the clip; that view record is the
audit entry for the media shown.

### Debug inspector from the learner app

The same inspector is reachable from the current activity in the learner app,
for an account that may open the learner view of that enrollment (an owner or
admin, for example a workspace owner who is also enrolled). The learner app asks
`GET /api/enrollments/:id/debug-inspector`; a learner always gets
`{ available: false }` and never sees the entry. An authorized account gets a
secondary **Debug inspector** button beside the lesson (never part of the
learning path): a side panel on expanded windows, a pane under the lesson on
medium ones and a full-screen dialog on compact ones; the lesson stays mounted
under it. The panel frames `/admin/inspector`, the admin app's inspector, which
the API serves with `frame-ancestors 'self'` (every other page keeps
`'none'`). Each open reads the learner view, so it writes the same receipt as
**View as learner** (a recorded staff view the learner sees), and runs, payload
reveals and replays go through their usual routes and permissions. The
visual-state panel reads the learner app's own live runtime through a
same-origin bridge on the learner window that exists only while the panel is
open.
The panel also shows the renderer build identity of the visual (the build the
course declares and the installed build serving it, from the learner view's
`visualRenderers`) and the SHA-256, type and size of each image asset the scene
embeds (visuals 0.5 `defs.images`).

### Scoped retry and regrade

Two corrections act on exactly one item, need a reason, are idempotent under an
`idempotencyKey` (a different request under the same key is 409
`IDEMPOTENCY_CONFLICT`), are recorded as staff learning events on the
learner's record (in the audit log without the reason), and are refused for an
erased (410) or a completed or policy-closed (409 `ENROLLMENT_CLOSED`)
enrollment. Erasure redacts their reasons and a regrade's quoted findings.

- `POST /api/admin/courses/:courseId/runs/:runId/cancel` (`supervision.control`:
  owners, admins and instructors) stops one live run before it applies anything.
  It sets the job's cancellation flag, which the bridge honours at the run's next
  step before any provider call, queues a `staff_cancelled` wake-up so a running
  call or wait ends now, and records a `supervisor.run_cancel_requested` staff
  event (`supervisor_run_cancellations`, migration 099). The learner's AI
  supervision and other runs are untouched. A run that already ended (409
  `RUN_ALREADY_ENDED`) or was already asked to stop (409
  `RUN_CANCEL_ALREADY_REQUESTED`) is refused.
- `POST /api/admin/courses/:courseId/runs/replay` (`run.inspect`) replays up to 20
  of the course's latest finished supervisor runs that kept a plan, each in the
  same read-only sandbox as a single replay, with its own new replay id and
  `run.replayed` receipt. It returns each run's verdict and a summary.
- `POST /api/admin/courses/:courseId/runs/:runId/retry` (`run.retry`, owners and
  admins) runs a supervisor run that failed, ended with an uncertain provider
  call, or was stopped by staff, again as a new run: a `supervisor.run_retry_requested` event that the
  dispatcher prepares through the normal path (supervision control, consent,
  policy, fence and budgets, verifier, application) and never coalesces. The
  old run is not changed; the run inspector shows each run's `retry` links. A
  run is retried once. Live runs, applied runs, stopped supervision, withdrawn
  consent and companion, research and written-answer runs (which answer one
  linked request; ask again through that request) are refused.
- `POST /api/admin/enrollments/:id/attempts/:attemptId/regrade`
  (`evidence.regrade`: owners, admins and instructors; never the learner) records
  a new decision on one practice or independent attempt, linked to the decision
  it supersedes (the attempt's automated result, the review, a decided appeal or
  an earlier regrade; `attempt_regrades`, migration 081). An automated attempt is
  graded again by the course's own evaluator for the version it was answered on;
  a written answer takes a second person's findings under the review's quoting
  rules. The attempt and earlier decisions are never edited: an upheld regrade
  changes no evidence, a changed one invalidates the attempt's evidence with a
  reason, adds evidence naming the regrade and recomputes gate decisions. An
  open appeal (decide it first), an unreviewed answer, evidence staff already
  withdrew and placement or retention answers are refused. After a regrade the
  learner sees the new decision and can no longer appeal that answer. `GET` on
  the same path returns the decision in force and the regrade history.

**Grading provenance.** Every attempt and every regrade binds what graded it:
SHA-256 digests (of canonical JSON) of the exact item, of its answer key (a
deterministic key without its teaching explanation, a code item's grading
reference plus the evaluator build holding its hidden cases, or a reviewed
item's rubric) and of the evaluator (Core's deployed deterministic grader
source, or the installed extension's id, version and integrity), plus the
sandbox image a code answer ran in (`attempts`/`attempt_regrades` columns,
`services/api/src/grading-provenance.ts`). The regrade view shows them and
whether the item, key or evaluator changed since the answer was graded.
Attempts recorded before these columns existed show none.

## Supervisor wake-ups

Wake-ups come from durable per-deadline timers (`policy_deadline_timers`,
migration `096`), not from a scan over every active enrollment. Each timer is one
boundary of one enrollment, planned from a named policy and ledger revision: a
binding organization, course, enrollment, chapter or episode deadline entering its
warning window (`deadline.approaching`, 48 hours before), a chapter or episode
deadline passing with that scope's work unfinished (`deadline.reached`, once), the
enrollment's own end (`cap`), or an exhausted work quota that must be checked for
closure (`quota_cap`). A database trigger queues an enrollment for re-planning
(`policy_timer_plans`) in the same transaction as every change of its policy
document or status, from any code path, so a committed change cannot be missed.
The worker sleeps until the next timer, queued plan or retention check is due (at
most `WAKEUP_INTERVAL_MS`, default 60 s, minimum 10 s); each pass plans and fires
bounded batches (500) of what is due, so its work follows the due boundaries, not
the number of enrollments. `retention.due` is still signalled when a delayed check
comes due; it is also the trigger table's review-due signal (T10): with the
learner's opt-in it starts preparing the next review as a teaching action. Each boundary is recorded once per enrollment (`wakeup_signals`), so
repeated or concurrent workers and restarts do not duplicate it, and learners
sharing one absolute deadline each get their own.

**Commit-time fences.** Firing takes the enrollment's policy row lock (the one
every grant, accommodation, migration and closure takes) and compares revisions:
a timer planned from an older policy revision (for a quota check, an older
ledger) is re-planned instead of acted on, so a deadline moved by an extension or
outage adjustment never fires at its old time. Closure is re-checked by the policy
at commit; a timer whose cap the policy says is not reached is dropped and
re-planned. Wake-ups only prompt the supervisor; commit-time policy checks remain
authoritative, and a late or missed wake-up never extends, unlocks or grants
anything. A failed plan or timer is retried after `WAKEUP_RETRY_MS` (60 s); an
exhausted quota whose learner still has a way forward is re-checked on the same
interval. Planning also records the resolved constraints of every scope with the
level that binds (`policy_constraint_snapshots`).

When the course cap is reached the same scan closes the enrollment once with the
policy's gaps report (`reason: "cap"`, covered and uncovered objectives,
demonstrated and unproven concepts) and records `enrollment.closed` with the cap
kind: `deadline` once the binding course deadline has passed, or `work_quota`
when a course work allowance (added minutes, added episodes or remediation cycles
for a concept) is used up *and* the learner has no way forward without more
added work (the next required gate is unmet, all of its items are used, nothing
awaits review or appeal and no admitted work is still being prepared). The policy
refuses if the cap was not actually reached. A chapter or episode deadline never
closes the course. A failing step for one enrollment is recorded in
`wakeup_failures` (stable error code and count only, no payload) and logged as a
`wakeup.failure` line on stderr; it never stops the others.

## Least-privilege database operation

Production-style deployments set `MIGRATION_DATABASE_URL` (schema owner) beside
`DATABASE_URL` (a separate runtime login role). The API migrates and grants with
the owner connection, then serves only as the runtime role, which receives data
access but no DDL, TRUNCATE, trigger or schema-creation rights and must not own
tables; startup fails otherwise. Immutable-history triggers and erasure work
unchanged under the runtime role. Without `MIGRATION_DATABASE_URL` the API keeps
the single-role behaviour for development.

## Optional artifact object store

By default every artifact stays in Postgres. Setting `COURSE_ARTIFACT_STORE=s3`
moves large artifacts to a private S3-compatible bucket (MinIO, Ceph, AWS S3 and
others; path-style requests with Signature Version 4): generated media clips, and
supervisor artifacts whose canonical JSON exceeds
`COURSE_ARTIFACT_INLINE_LIMIT_BYTES` (default 16384). Supervised plans always
stay inline because their content is matched in SQL against the tool trace.
Required: `COURSE_ARTIFACT_S3_ENDPOINT` (an origin; plain `http` only on a
loopback host), `COURSE_ARTIFACT_S3_BUCKET` (an existing bucket),
`COURSE_ARTIFACT_S3_ACCESS_KEY_ID` and `COURSE_ARTIFACT_S3_SECRET_ACCESS_KEY`.
Optional: `COURSE_ARTIFACT_S3_REGION` (default `us-east-1`) and
`COURSE_ARTIFACT_S3_PREFIX` (default `course-core`). The API checks the bucket at
startup and refuses to start if it is unreachable.

Postgres keeps the authoritative record of every object (`artifact_objects`,
migration 062): SHA-256, size, type, owning workspace and enrollment, and its
lifecycle. Object keys hold identifiers only. Every full read is checked against
the recorded digest and size, and range reads send the entity tag recorded at
upload as `If-Match`, so an object changed in the bucket is refused
(`ARTIFACT_OBJECT_INTEGRITY`) instead of served; an unreachable store answers
`503 ARTIFACT_STORE_UNAVAILABLE` and nothing is recorded. The API proxies every
read after its normal authorization and never hands out bucket URLs. Erasure
releases an enrollment's objects; a sweep every `ARTIFACT_SWEEP_INTERVAL_MS`
(default 60 s) deletes released objects and uploads that were never recorded
(after 15 minutes) and retries failures. Back up the bucket together with the
database: a Postgres backup alone does not contain the stored objects, and
keep the store configured while any object is recorded in it.
`npm run test:object-store` (services/api) qualifies a real service, for example
a disposable local MinIO; the regular API tests use an in-process endpoint.

## Full-text retrieval

Retrieval uses Postgres full-text search (no embeddings yet). Each release's text
blocks and cited source titles are indexed when the release is stored (or a
draft's bundle replaced), and the learner's own companion questions are indexed
as they are written. The supervisor's `search_sources` and `search_history`
tools return at most five ranked, short snippets with their references. The
language-neutral `simple` configuration lower-cases but does not stem; query
words match as prefixes. History search covers only this enrollment's learner
questions in the current course version and never returns assistant turns,
erased or deleted questions, or questions the learner excluded from AI context.

## Learning events and the event stream

Every learning event carries an envelope (migration 054):
- `schema_version`;
- the client that caused it (`platform`, `app_version`, `client_sequence`, `occurred_at`), taken from the request's `X-Course-Platform`, `X-Course-App-Version`, `X-Course-Client-Sequence` and `X-Course-Occurred-At` headers. These are advisory: malformed values, and times more than 7 days from server time, are ignored. Background work records none;
- the server's `received_at`;
- the enrollment's `course_digest`;
- the `activity_instance_id` and `attempt_id` it concerns (an answer records its check);
- `payload_ref` and `causation_id`.

The learner web app and the admin app (`apps/admin/src/client/eventEnvelope.ts`) send the client headers on every change they make (not on reads), so staff events carry the same client facts as learner events. Each app reports its own version and keeps its own per-session sequence. Erasure
keeps the identifiers and clears the payload and the client's device facts.

`GET /api/enrollments/:id/events?after=` pages events as before.
`GET /api/enrollments/:id/events/stream` is a resumable Server-Sent Events
stream for the same readers, with the same payload rule: staff readers get
allowlisted payloads only. Each event's SSE id is its sequence, so a
reconnecting client resumes after the last event it received
(`Last-Event-ID`), and `?after=` starts after a known cursor. Limits:
- up to 100 events per read, and a read every second while idle;
- a heartbeat every 15 s;
- access rechecked every 30 s, and a `closed` event when access ends;
- a `reconnect` event after 5 minutes;
- 4 streams per account and 200 per process (more get 429, and the client
  falls back to polling).

The companion reloads at once when the stream reports a question or an answer,
and polls more slowly in the background while the stream is connected.

The companion also states what it is doing:
- available;
- your question is queued;
- building a reply;
- checking the reply before it is shown;
- waiting for your choice (keeping a check independent);
- service unavailable;
- offline.

While the browser is offline a question is held on the device and sent once
when the connection returns, if the learner is still in the same lesson with
the same draft.

## Continuing after closure

A closed course (completed or ended at its cap) offers an optional continuation
track (`/api/enrollments/:id/continuation`). The learner opts in with explicit
consent and may stop at any time; staff cannot opt a learner in. On the track the
learner keeps spaced review checks (retention wake-ups continue, and review
checks and their answers are allowed on the closed course); nothing on it is
required, it adds no work, grants no credit, and the closed enrollment and its
closure report stay as they were. Planning, new lesson checks and generated work
stay refused (`CONTINUATION_NO_REQUIRED_WORK`). Erasure stops the track.

## Questions after completion or closure

A closed course, whether completed or closed at its cap (a reached deadline or
exhausted quota, enrollment status `closed`), keeps bounded explanatory questions
when its policy keeps existing material readable (`existingMaterialAccess:
read_only`, the default) and its closed-course question budget has room.
The companion route checks the policy's `read` action instead of starting study
windows or planning, and the supervisor admits only **companion** jobs for a
completed or closed enrollment, checking `read` at admission, input, tool and
publication fences. The course deadline that capped the enrollment does not
shorten the answer job; its own duration does. Planner, research and adaptation
work never resume, new checks are refused, answers add no evidence or progress,
and provider budgets still bound every answer. A policy that closes existing
material refuses the question (`ACCESS_CLOSED`).

A question is charged against the closed-course budget when it is accepted and
the charge is returned if it can never be answered: the supervisor refused it
(for example access closed before delivery), its delivery was quarantined, or its
job ended failed or cancelled. Such a question reads as `refused` (or its job
state) in the conversation. Questions still queued or being answered stay
charged, so concurrent questions cannot exceed the budget.

**Output Core refuses.** When the model answers but Core's own checks refuse
what it returned (a companion reply over the size bound, or a supervisor teaching
proposal naming an objective outside the lesson), that is a definite outcome, not
an uncertain submission. The strategy returns an `output_refusal` holding only the
role and a reason code (`output_too_large`, `objective_out_of_scope`), never the
refused text, and the call's reported usage is charged. The verifier rejects it, so
the job ends `failed` with `verification_rejected` and nothing is delivered. The
learner sees "The companion couldn't answer this question" with **Ask this
question again**, which puts the question back in the draft to send as a new one
(`refusal_reason` on the question in `GET .../companion`). Staff see the refused
output and its reason in the run inspector. A response whose fate Core cannot know
(a timeout or lost connection after sending) still waits as `provider_uncertain`
and is never resent (`services/api/src/output-refusal.ts`).

The supervisor tool loop refuses the same way when its own round checks stop a
run mid-way, after tool receipts and paid rounds were recorded: a decision that
breaks the loop's contract or a tool's argument contract
(`tool_loop_invalid_decision`), a third teaching candidate, research request or
reviewed resource (`tool_loop_candidate_limit`), every round used without
finishing (`tool_loop_round_limit`), or a tool result or next prompt over its
bound (`tool_loop_tool_result_too_large`, `tool_loop_input_too_large`). The run
stores only that reason, never a partial plan. Every round's reported usage is
charged and the tool receipts stay as the run's record. The job ends `failed` with
`verification_rejected`, so nothing is applied and staged research is never
dispatched. A retried gateway request is answered from its receipt, and a sandbox
replay reports `refused_output` without calling a provider. The learner's
supervisor timeline and the staff run inspector show the run's receipts as not
delivered rather than pending, and the inspector names the reason. A provider
round whose fate Core cannot know still leaves the job `provider_uncertain`.

A tool's own refusal of the model's call ends the run the same way when it is
decided only by the model's request against data fixed for the run: the call's
arguments, the job's own earlier receipts, the frozen context and the immutable
release (for example a topic, profile, resource or source the run never
retrieved, a history cursor outside the enrollment, or an objective outside the
lesson). A refusal that reflects state changing during the run is not blamed on
the model. When the learner turns support off or starts an independent check,
the enrollment revision changes and the job is cancelled as `stale_revision`; an
enrollment that ends cancels it as `inactive_enrollment`. A generation profile
staff withdrew from the registry during the run (`GENERATED_TEACHING_UNAVAILABLE`)
does not fence the job, so it ends the run as a host-side failure,
`tool_loop_runtime_unavailable`, rather than waiting
(`services/api/src/supervisor-tools.ts` lists both groups). A later round the provider certifies it never received, after
earlier rounds ran, ends the run as `tool_loop_round_not_started`, and a later
round the provider definitely refused (every attempt a documented rejection
status such as 401, 403 or 429) ends it as `tool_loop_round_rejected`. Both are
charged with the earlier rounds only and never retried, because a retry would
repeat them; a 5xx, timeout or cut-off response stays `provider_uncertain`. The
run inspector labels these three host or provider causes "Run ended without
output" rather than a refused model output.

Teaching hypotheses a refused run recorded stay. A hypothesis tool writes when it
is called, after its own checks (consent, no independent check, cited learner
events, caps, the learner's pins and rejections), as a revisable guess the
learner sees and can correct or reject, which expires and never counts as
evidence. "Nothing applied" covers what needs the run's verified plan (teaching,
profile suggestions, research and resources); a hypothesis is not part of the
plan, and it stays for a rejected or cancelled run in the same way.

## Companion context

Each companion question carries a context capsule (`services/api/src/context-capsule.ts`,
migration 053). When the learner asks, Core resolves what they point at against
the current course and refuses anything that no longer matches (`ANCHOR_STALE`)
instead of guessing:

- text selected in the lesson, classified as prose, a formula or code example, or
  feedback from their latest graded answer in that lesson;
- lines of their own code in an open code check (`code_line`, with a snapshot
  hash);
- a labelled part of an illustration;
- the course video, with an optional playback position.

The question also records the UI revision and the event cursor the answer must
be at least as new as.

When the job answering it builds its provider context, the conversation is
retrieved for **that lesson and course version only**. That is at most 8
messages, 1,000 characters each and 6,000 in all, and every message carries a
reference to its message and request event. Earlier questions in the lesson
become an extractive summary that names its source events. This replaces the
earlier paste of the last 20 messages from any lesson. Messages the learner
excluded are never retrieved
(`POST /api/enrollments/:id/companion/context-exclusions`, learner only). The
capsule stores what the job was given:

- revisions;
- the selection, the media reference and its reviewed segment;
- evidence and history references and the summary;
- the extension allowance and the pending gate decision;
- the exact resolved constraint snapshot.

The answer shows all of this as **Context used**, and the learner can stop any
of their earlier messages being used again. The supervisor fence now uses the
enrollment revision minus `navigation_revision`. Reading a block, switching
episode or asking another question therefore no longer drops an answer being
prepared, and the answer stays attached to the lesson and question it was
asked about. An answer, a new independent check and changes to profile,
policy, learner model or evidence still fence it. Capsules are part of the
companion conversation for privacy: they appear in the learner's export only
and are erased with it.

The capsule is a public, versioned contract (`schemaVersion: 1`):
`services/api/src/contracts/context-capsule.ts` is a dependency-free type module
(no imports) that the SDK can adopt verbatim, `contracts/context-capsule-schema.ts`
is its runtime schema, and `docs/contracts/context-capsule.v1.schema.json` is the
JSON Schema generated from it. `services/api/test/context-capsule-contract.test.ts`
checks that the contract type equals the capsule the server stores, field for field
(the resolved policy view is an open object in the contract), and that the committed
JSON Schema is current (`UPDATE_CONTRACTS=1` regenerates it); the companion
integration test validates a stored capsule against it. Within version 1 fields are
only added. Adopting the type in `@course-core/sdk` is a separate SDK release; Core
does not depend on it.

## Personal changes the learner controls

`GET /api/enrollments/:id/personal-changes` lists every adaptation applied to the
learner's personal course with its reason, episode, date and classification.
The learner (only) can hide an *optional* addition and restore it later
(`POST …/personal-changes/visibility`); hidden blocks leave their lesson view.
Required changes and lesson rewrites cannot be hidden (`CHANGE_NOT_HIDEABLE`);
disagreement goes to the companion or course team. Applied adaptation history,
evidence and gates never change, and optional personal additions are never
required reading for episode completion. Withdrawing an applied change from the
underlying plan itself is not implemented.

**Remedial episodes.** A teaching-bank profile with operation `insert_episode`
(SDK 0.4) can insert an exact, author-reviewed text-only episode after its
anchor episode, chosen by staff or by the supervisor after learner opt-in. It is
never graded, is metered as at least one additional episode, and is governed by
its anchor's policy scope. A required insertion must be read before the next
episode unlocks; an optional one never blocks progress and can be hidden and
restored as a whole. Owners, admins and instructors can insert one without any
model through `POST /api/admin/enrollments/:id/adaptation/reviewed-episode`
(`{expectedRevision, expectedPlanRevision, idempotencyKey, profileId, entryId,
stageOnly?}`): only an exact entry of an approved `insert_episode` teaching-bank
profile is accepted (`REVIEWED_EPISODE_UNAVAILABLE` otherwise), and it goes
through the supervisor's path (installed bank generator and verifier, SDK and
assignment validation, policy work caps, plan and evidence fences, an audited
`adaptation.applied` staff event, and the learner's personal-changes list).
`stageOnly: true` only verifies and stages it for the existing apply route.
Retries with the same key replay the stored result.

**Generated interactive content.** With learner opt-in and an approved profile,
the supervisor can also generate simulations, check questions whose answer key
Core derives from a scene's computational model, code exercises with hidden tests
proven in the isolated grader, and small interactive components that run only in
the sandboxed Python runner. A generated addition to the lesson a learner is
mid-attempt in waits until they add it after the attempt. See
[services/api/GENERATED_TEACHING.md](services/api/GENERATED_TEACHING.md).

**Return point after a detour.** When the learner opens a lesson off their path
(an optional lesson, authored or inserted for them, or one they already
finished) while their current step is elsewhere, the lesson names where they
return to: the current lesson and the part they stopped at, or its check when
every part is read, with a button that takes them there (`returnPoint` in
`apps/learner/src/connected/ConnectedLesson.web.tsx`).

## Delayed retention checks

Courses declaring SDK 0.3 `retention` get one schedule per retention objective,
derived from when the evidence completing its gate was recorded (so schedules
are reproducible and created idempotently on first read). When a check is due,
`POST /api/enrollments/:id/retention/check` issues an unseen held-out item as an
independent challenge in mode `retention`; a second pending check is refused.
The schedule is graded, not a mastery estimate (`nextSchedule` in
`services/api/src/retention.ts`): an independent success records the objective
as retained and moves one interval on (keeping the schedule's own rhythm when the
check was on time); a wrong answer steps back one interval rather than restarting,
and only a second miss in a row restarts at the first interval; "I don't know yet"
loses no step and schedules a review after the first interval; a right answer
given with help neither gains nor loses a step. A miss or "unsure" marks the
objective for review without revoking demonstrated understanding. Learners can
set the weekdays they study, in their time zone
(`POST /api/enrollments/:id/retention/availability {weekdays, timeZone}`,
`retention_availability`): a check that would fall on another day waits for the
start of their next study day, never earlier, and clearing the setting restores
the schedule's own times. A delayed check may use any item this host can
evaluate: deterministic items, code with a qualified evaluator, and written
answers with the installed reviewer, whose review then moves the schedule (a
second check waits while one is under review). If staff later invalidate a
delayed-check result (an upheld dispute or a defective item), the schedule is
rebuilt from the results that still stand. When no unseen item
remains the API says so (`RETENTION_ITEMS_EXHAUSTED`) instead of repeating one.
Retention never changes gates, completion or lesson states. Learners see an
optional Delayed checks panel, and the supervisor receives a `retention.due`
wake-up. Due-ness, the reschedule after a miss and the retained time all use one
server clock (`services/api/src/clock.ts`). Tests may pass a controllable clock to
`createServer({ clock })` instead of rewriting stored timestamps; `createServer`
refuses any clock other than the system clock unless `NODE_ENV` is exactly
`test`, and no environment variable, header or route can change the time.

## Optional placement runs

When a course enables placement, a newly enrolled learner (before any study) is
offered **Find my starting point** or **Start from the beginning**; declining is
recorded and never penalised. A run is bounded by the course's `maxItems`, and
items can only be issued inside an in-progress run, one at a time, so an
interrupted item is resumed rather than replaced. Placement items do not start
study windows for later material.

The server walks the required path in order and proposes exemptions only for
episodes whose gate is satisfied by this run's independent placement evidence.
A wrong or assisted answer, a protected episode, an unplaceable episode, missing
fresh items or the item cap ends the walk; nothing past an unproven prerequisite
is proposed, and untested objectives stay on the path. Exemptions are written
only when the learner accepts a start point (the proposal or anything earlier),
as `placed` progress with evidence references and no invented reading. An answer
that is still awaiting evaluation (a written answer waiting for review or for the
learner's clarification reply) is undecided, never wrong: placement offers
another unseen item if one fits, otherwise it pauses with stop reason
`pending_evaluation` and lists the undecided objectives. Finishing then keeps
those objectives (and everything after them) on the path; once the review
arrives, an unfinished run continues from the real outcome. Staff see
the run state, stop reason and exemptions. The legacy per-episode
`complete { placement: true }` path is refused in favour of run acceptance.

The result explains itself without a global level: each objective shown lists
the questions that showed it, objectives tried but not shown say why (an answer
was not correct, help was used, or more kinds of question are needed), and the
placeable objectives on the path that were never asked are listed. The note that
untested objectives are no judgement of ability is a message code the learner app
translates (`untestedNoteCode`).

**Author policy and staff settings.** Placement is on only when the course offers
it and staff enable it, and staff settings only tighten the author's. Core reads
the SDK 0.5 `retestPolicy` (runs and cooldown), `assistancePolicy` and
`evidenceThresholds` of every live release that offers placement: effective runs,
cooldown and item families per lesson are the stricter of the author's and the
staff values, and saving looser staff values is refused
(`PLACEMENT_RETESTS_LOOSEN_AUTHOR`, `PLACEMENT_COOLDOWN_LOOSENS_AUTHOR`,
`PLACEMENT_EVIDENCE_LOOSENS_AUTHOR`). With `unassisted_only`, revealing a
placement answer and companion help while a placement item is open are refused
(`PLACEMENT_UNASSISTED_ONLY`). Staff may narrow the author's blueprint (leave
questions or placeable objectives out) and protect more lessons, never add
questions or un-protect an author's lesson (migration
`098_placement_blueprint.sql`). `POST /api/admin/courses/:id/placement/settings/preview`
shows, without saving, what each required lesson would allow (placeable, not
placeable, no questions left, protected by the author or by staff); the admin
page requires that check before saving a blueprint change.

## Answer keys and test answers

The admin **Answer keys** page (`course.write`: owners, admins and authors; keys
reveal answers) lists a release's questions with their keys
(`GET /api/admin/courses/:id/releases/:releaseId/assessments`). Keys and rubrics
change only on a draft release, which is then reviewed and published like any
draft: `PUT .../assessments/:assessmentId/key` (choice, numeric, prediction and
trace keys) and `PUT .../rubrics/:rubricId` (a course rubric, whose changed
criteria need a version that was not published with other criteria, or a 0.4
written item's own rubric). Test answers belong to the course: answers a question
must reject (wrong-answer fixtures, usually a likely mistake) or accept
(`GET|POST /api/admin/courses/:id/assessment-fixtures`,
`DELETE .../assessment-fixtures/:fixtureId`; at most 50 per question and 2000 per
course). A key change is checked first
(`POST .../assessments/:assessmentId/key/preview`) and a change that grades a test
answer the wrong way is saved only with `acceptFailingFixtures`. A test run
(`POST .../releases/:releaseId/fixture-runs`) grades every test answer with the
learners' deterministic grader and is recorded (`assessment_fixture_runs`); the
report (`GET .../fixture-runs`) shows counts to anyone who can read the course
and each answer's result to course writers, and marks a run stale when its draft
changed since. Code and written questions are reported as not runnable here (no
sandbox run or reviewer is started). Every change is audited.

## External agent tools

A learner can connect an AI agent they use elsewhere (a desktop assistant, a coding agent, a script) to one enrollment from **My profile → Connected agents** (`POST /api/enrollments/:enrollmentId/agent-grants {label, scopes, expiresInDays}`; list with `GET`, revoke with `POST .../:grantId/revoke`). A grant names its scopes (`context`, `profile`, `evidence`, `history`, `propose_intervention`), expires after at most 90 days and can be revoked at any time; at most five are active per enrollment. The access key is shown once; Core stores only its SHA-256 digest. Staff, peers and the read-only learner view cannot create, list or revoke grants. Erasing the enrollment or the account revokes them, and so does removing the learner from the workspace (for good: adding them back does not revive an old key).

Agents call the tools with `Authorization: Bearer <key>` only, over plain HTTP (`POST /api/agent-tools/v1/tools/{get_context|get_profile|get_evidence|get_history|propose_intervention}` with the arguments as the JSON body) or a minimal MCP endpoint (`POST /api/agent-tools/mcp`: JSON-RPC 2.0 `initialize`, `ping`, `tools/list`, `tools/call`; JSON responses, no server-sent stream). Every call checks the key, revocation, expiry, the tool's scope, the learner's membership and the enrollment again; bad, revoked and expired keys get the same 401 and a missing scope 403. Limits per minute: 60 requests per grant and 120 per enrollment across all its grants, counting every request an authenticated agent makes (MCP `initialize`/`ping`/`tools/list`, notifications, unknown tools and failed calls included), reserved atomically before the call runs; 2 proposals per grant; and 30 failed authentications per client address (resolved as for sign-in, see `TRUSTED_PROXIES`), after which that address gets 429 `AGENT_AUTH_THROTTLED` without a database lookup. From a shared source (loopback, where every client of a local forwarder arrives) a key that authenticated in the last 15 minutes still gets its full check, so one client sending bad keys cannot cut off the working agents behind the same forwarder; a key not used recently waits out the minute. Arguments never choose the enrollment, workspace or user. Session cookies do not authorize these routes and the key authorizes nothing else.

Reads use the supervisor's minimal projection: no private notes, pending suggestions, answer keys, unissued items, staff notes, other learners, or evidence and messages the learner excluded from AI context. `propose_intervention` goes through the learner-model proposal port as a learner-agent principal: it creates one source-linked suggestion (pace, explanation style or an objective to review) that waits in the learner's own review queue, labelled "From your connected agent <label>" (the course's own AI suggestions are labelled separately), and never grants mastery or touches evidence, grading or progress; the grant is re-checked under the row lock revocation takes. A grant may hold at most 3 pending suggestions and all connected agents together 5; these never count against the course services' own 20, so an agent cannot crowd out the supervisor. A pending agent suggestion does not change the enrollment revision (it changes nothing a learner command or a companion answer's revision fence depends on, and provider context carries only reviewed suggestions), so it cannot make the learner's open commands stale or drop companion answers; the learner-model revision still records it. An agent cannot cite a question the learner excluded from AI context.

Reads stay available while the enrollment is paused, closed or completed: it is the learner's own record and they granted access to it. Proposals require an active enrollment. An erased enrollment answers nothing. The tools call no model provider and forward the key nowhere; it never appears in logs, errors, events, telemetry or the per-call audit (`agent_tool_calls`: grant, tool, outcome code, time), which the learner sees in their data export.

## Learner data export and erasure

A learner can download everything an enrollment recorded about them
(`GET /api/enrollments/:id/export`, format `course-core.enrollment-export` v1):
profile, attempts and evidence, companion conversations, learner model,
deadline/extension records, supervision summaries, the generated media staff
requested for them (`media`: title, objective, script, review text, captions and
attachment state; clips are listed by digest, not embedded) and events. Course content,
grading keys and other learners are excluded. Personal teaching
(`supervision.personalTeaching`) goes through an allowlist
(`services/api/src/learner-export.ts`): text, episodes, media, visuals and
suggestions as delivered, and a generated item variant as its question only
(the same `publicQuestion` allowlist every learner-facing item route uses), never
its grading key, hidden fixtures, numeric recipe or generator. Owners and admins can export on a
learner's request through `/api/admin/enrollments/:id/export`; instructors and
other staff cannot. A staff copy (`audience: "staff"`) follows the learner
privacy rule below: `companion` and `learnerModel` are `null` and `withheld`
lists what was left out; the learner's own download (`audience: "learner"`)
is complete. Each export records its digest and an audit event in the
append-only `data_exports` table (UPDATE, DELETE and TRUNCATE are refused;
migration 038). A staff export also records the exporter's role and, like a
staff view, is listed for the learner under **Your data**
(`GET /api/enrollments/:id/staff-views`, `exports`) and in their next export
(`staffExports`). These rows hold no learner content and survive erasure.

**Portable event export.** `GET /api/enrollments/:id/event-export?after=<sequence>&limit=<n>`
(and `/api/admin/enrollments/:id/event-export`, same roles) returns the enrollment's learning events
in the SDK 0.6.0 `learningEventExport` record format (`exportFormat: 1`): the course ID, semantic
version and compiled digest, the enrollment's opaque ID as `enrollmentRef`, and each event's stable
UUID, durable sequence (a decimal string), type, actor kind, time, payload and trace ID. It is one
cursor page per request: `after` is exclusive (default `0`), at most `limit` events (default 1000,
at most 5000), and `cursor.through` is the last sequence returned, so the next page starts there;
the `Course-Core-Export-Has-More` header says whether one exists. Malformed cursors and limits get
400. A staff copy keeps every event's identity and replaces payloads the event privacy rule withholds
with `{"withheld":"event-payloads"}`. Each page is recorded in `data_exports` and the audit log like
the full export. SDK 0.6.0 is not released yet, so Core's tests validate every export against the
schema vendored in `services/api/src/vendor/sdk-event-export` (implementation: `src/event-export.ts`).

### Learner model privacy

The learner model (`/api/enrollments/:id/learner-model`) holds the learner's own
notes: preferences, prior-knowledge statements, thoughts and the proposals made
about them. Following the design's role boundary (course administration alone
does not grant access to personal chat or the learner's own notes; instructors
see permitted evidence), only the learner reads all of it. Owners, admins and
instructors get a redacted `GET` (`access: "staff"`): the evidence-derived
understanding per objective and the enrollment `profile` (display name,
learning goal, pace), with `selfReport` and `suggestions` withheld. The learner
model's own copy of goal and pace is part of `selfReport` and stays private.
`/changes` and `/history` (profile edits, proposals and the learner's companion
questions) return 403 for them. Other workspace roles get 403; other learners
and other workspaces get 404. The supervisor and companion read the minimal
provider projection only through their admitted, non-cancelled supervisor job
for that enrollment (`readLearnerModelForSupervisorJob`), not through a staff
role or the learner's identity. There is no learner-controlled sharing yet.

The learner's own statements about themselves follow one rule:
- **What it covers:** preferences, goal, prior-knowledge statements and the suggestions the learner accepted.
- **Companion turns:** a companion turn answers the learner's own question, so it always receives these statements. The learner wrote them to shape how they are taught.
- **Autonomous supervisor work:** it receives them only under the course-scoped supervision opt-in, like teaching hypotheses. Without the opt-in, the supervisor's context says `withheld: "supervision_opt_in_required"`. Withdrawing the opt-in takes them out of new supervisor work.
- **Thoughts:** the learner's private thoughts never reach any model.

Every suggestion about the learner (pace, explanation style, an objective to review)
carries its provenance (C06, migration 106): the source events it cites, an
`uncertainty` Core states from how much of the learner's own activity it rests on
(one event `high`, two or three `medium`, four or more `low`; never the model's own
claim) and an `expiresAt` 30 days after it was made. A suggestion still undecided at
its expiry is listed as `expired`: it was never applied, never reaches a model, and
can still be disputed but not accepted or corrected (`PROPOSAL_EXPIRED`). A decision
made in time keeps the learner's later choices open. Older suggestions keep `null`
for both.

Each objective's state (`not_assessed`, `needs_evidence`, `practicing`,
`demonstrated`, `retained`, `needs_review`, `disputed`) carries a plain
`explanation` of why it was given. The learner has two controls over any piece
of their own evidence (`POST .../learner-model/evidence/:evidenceId/control`,
actions `dispute` with a reason, `withdraw_dispute`, `exclude`, `include`;
migration 044, `learner_evidence_controls`). A dispute shows the objective as
`disputed` until the learner withdraws it, staff review that evidence, or the
evidence is invalidated; staff see that the result is disputed but not the
learner's explanation (`evidence-dispute-reason`). Excluding keeps the evidence
and its attempt out of everything the companion and supervisor receive (the
provider projection, its retrieval and recent attempts); staff do not see
exclusions. Neither control grants, removes or changes credit, and both are
exported and erased with the learner's data. At most 20 disputes may be open.

Staff find open disputes on the Answer reviews page (`GET /api/admin/courses/:courseId/evidence-disputes`,
`evidence.review` on that course through the admin permission check). Each row has the dispute's state, the
objective, the evidence reference (item, kind of answer, check mode, recorded result, course version) and its
age, never the learner's reason. Any result can be disputed: a choice, a number, a trace, code, a written
answer or a delayed retention check. Resolving (`POST .../evidence-disputes/:disputeId/resolve`, `accept` or
`reject` with a note) is the same evidence review as on the enrollment: `accept` keeps the result as recorded
(any result that did not pass, which grants nothing, or a pass Core can acknowledge: independent, unassisted,
passing deterministic answers), and `reject` invalidates the evidence and recomputes progress; for a delayed
check it also rebuilds the review schedule without that result. An automatically graded practice or
independent answer can instead be graded again (scoped regrade, `canRegrade` on the row). Either one closes the dispute, is idempotent by key, refuses the learner's own dispute and
a closed one, and is audited (the enrollment event names the dispute; a course-level
`admin.evidence_dispute.resolved` event records who decided).

This is one rule, kept in `services/api/src/learner-privacy.ts` and applied by
every staff-facing read of a learner's space: the learner-model API above, the
read-only view as learner and staff data exports. Each reports the same
`withheld` list (companion conversation, learner model, device-local drafts,
and the learner's own words in gate review requests, in written-answer
appeals and in evidence disputes). Gate review requests are
split by purpose: staff must read a request to decide it, so the review queue
and the enrollment's per-gate request list keep the learner's reason, while
the read-only learner view and staff exports carry the request, its state, the
decision it names, the reviewer's note and any exception, but `reason: null`.
Written-answer appeals ("second opinion") follow the same split: the appeal
queue keeps the learner's reason; the learner view and staff exports carry the
appeal, its state, decision, findings and note with `reason: null`. The same
file classifies every learner-written free-text field a staff route can reach;
answers (including clarification and placement replies) are assessment evidence
and stay staff-visible by design.
New staff reads take their audience from `audienceOf()` and drop those
categories rather than redacting per route.

The enrollment profile (display name, learning goal and pace) is not part of
the learner's private space. The same file's `enrollmentProfileFor()` decides
who sees it: every staff role that may read the enrollment (permission
`enrollment.read`: owner, admin, instructor, reviewer, support observer and
service, workspace-wide or through a course grant) gets exactly those three
fields on every staff surface: enrollment administration, the read-only view
as learner, staff exports and the staff learner-model read. Roles without
enrollment access (observer, author) get none of it. The run inspector's
payload reveal carries no profile fields (its `get_profile` tool call mixes the
profile with the learner model and stays withheld), and learner-granted agent
tools act for the learner, not as staff. The learner app says so
next to the profile, in the memory panel (whose own goal copy stays private)
and under **Your data**.

Erasure (`POST .../erase`, typed confirmation `ERASE <first 8 id characters>`
and a reason) is irreversible. It first withdraws supervision consent and waits
for running supervisor jobs to stop, then redacts personal content in one
transaction: answers, results, conversations, learner-model history, personal
teaching artifacts, supervisor inputs/outputs, receipts and event payloads.
Identifiers, timestamps, event types, spend and extension accounting remain as
an audit skeleton. Paid work is finished first, in the same transaction, so no
reservation stays held once the job state it would settle against is gone: work
that certainly never ran is released, a completed call is settled at its recorded
usage, and anything that may have run stays charged at its full reservation but
is closed (ledger `uncertain`, settled). Erasure counts record each kind
(`paidWorkReleased`, `paidWorkSettled`, `paidWorkClosedUncertain`). Generated
media made for the learner is treated as theirs: live attachments are revoked,
unfinished jobs cancelled, the title, objective and script, the reviewer's
captions, transcript, visual description and rationale, and revocation reasons
are replaced by placeholders, the provider operation's opaque adapter state is
dropped (its handle stays in `provider_operation_id`), and the rendered clips are
deleted (`mediaJobText`, `mediaReviews`, `mediaRevokeReasons`, `mediaAssets`).
Job and review IDs, states, asset digests, model, pricing, charges, ledger rows,
review decisions and findings remain; other learners' media is not touched, and
staff cannot request new media for an erased enrollment (410). Digests of what
was redacted go too: a plain SHA-256 of a small-domain answer (a 0-10 number, a
toggle, an option) gives the answer back by hashing every candidate, so the
request digests of command, admin and media receipts, media jobs, written-answer
reviews, appeals and review-assist requests, gate reviews, supervisor tool calls
and model selections, and learner-model source events are replaced by the
tombstone `erased` (`erase_enrollment_digests`, migration 065, which also applied
it once to enrollments erased earlier). The receipt rows stay, so their keys stay
reserved: a replay after erasure is answered 410 `ENROLLMENT_ERASED` and never
applied again. Immutable learning-history tables accept this redaction only
inside a transaction that names the same enrollment (never deletion). The
enrollment becomes `erased`: reads return 410, it cannot be resumed or silently
re-created, and staff views show only the skeleton. Durable workflow histories
and backups are not rewritten; they expire under their own retention settings.
Every placeholder satisfies its column's constraints, since one that does not
fails the whole erasure: written-answer appeal reasons accept `[erased]`
(migration 068) as gate review and placement override reasons already did, and
proof verification evidence becomes an empty list. A test fills every table that
names an enrollment with learner content and erases it, by enrollment and by
account (`erasure-constraints.integration.test.ts`).
Course admin command receipts store only the command's receipt and message,
never the admin workspace view (every learner's profile and evidence review
notes). Each reply, first or replayed, rebuilds the view as it is, so a replay
after erasure shows the learner only as erased; migration 069 removed the views
receipts stored before.

**One question.** A learner can delete one of their companion questions:
`POST /api/enrollments/:id/companion/messages/:messageId/delete`, learner only.
- Its text and the answer to it are replaced by `[deleted]`.
- An answer still being prepared is cancelled and fenced, and its pending delivery is quarantined.
- What was derived from it is revoked:
  - the capsule of the answer to it is cleared, and other answers' capsules drop it from their references and summary;
  - learner-model suggestions that cite it get a `proposal.source_revoked` change. They leave provider context and cannot be accepted again (`PROPOSAL_SOURCE_REVOKED`).

**The whole account.** `POST /api/account/erase` with the typed confirmation
`ERASE MY ACCOUNT` and a reason (migration 055):
- Every enrollment of the learner is erased with the same two steps as above: supervision is stopped first, then one transaction does all the redaction and settles paid work.
- The account then loses its name, sign-in identity, last sign-in time, password, passkeys, sign-in codes, sessions (every device is signed out; the revoked session rows are deleted by the session purge 7 days later) and workspace memberships. Its id stays as an anonymous identifier so audit rows that name it remain valid.
- What staff people-administration commands recorded about the account goes too (`erase_account_records`, migration 069, which also applied it to accounts erased earlier): the login name and a revocation's reason leave the receipts and their `people.*` events (marked `accountErased`), the receipts' request digests, which hash the invited display and login name, become the tombstone `erased`, and password-login throttle rows keyed by a digest of the login name are deleted. A replay of such a command is refused (410 `ACCOUNT_ERASED`).
- `account_erasures` records which enrollments were erased, with counts and the reason.
- Accounts with a course-team role are refused (`ACCOUNT_HAS_STAFF_ROLE`) until an administrator moves the role, so no workspace loses its owner.

**Deletion window.** Erasure is synchronous:
- **Live database:** the content is gone when the request returns.
- **Pending deliveries:** quarantined in the same transaction.
- **Workflow histories:** Temporal holds identifiers only, never learner text.
- **Backups:** a backup taken before the erasure keeps a copy until it is deleted. With `deploy/local/backup.mjs prune --keep N`, run after each backup, the window is N backup intervals. For example, daily backups kept 7 deep mean that data erased today is gone from every backup within 7 days. Operators must publish their interval and N as the deletion window for their learners.
- **Providers:** a model provider that already received a request keeps it under that provider's own terms. Core cannot recall it.

## Research source review and optional delivery

Approved public-topic research produces unreviewed suggestions. Turning any
source into learner-facing help is a separate, audited staff workflow:

1. **Add** (`course.write`): staff add one public HTTPS page or YouTube video to an
   approved topic with an expiry of at most a year. A topic's author-declared
   `allowedDomains` bind web sources. This authorizes inspection only.
2. **Inspect** (`course.write`): the server fetches the single approved address
   through `@course-core/research/node` (public-IP pinning, redirect/size/time
   limits, no scripts or subresources) and stores an immutable, digest-bound
   `unreviewed` inspection. Failures record only an error code.
3. **Review** (`release.review`): an approval must cite exact quotes from the
   inspected text, affirm relevance, accuracy-for-use and audience safety, and
   name a rights basis matching the requested use. Videos need a written
   alternative; transcripts are never scraped. Reviews are append-only; the
   latest review of a source supersedes earlier decisions.
4. **Attach** (`release.publish`): the latest approved review can be attached to a
   published release episode whose objectives cover the topic, with an expiry
   no later than the source approval. **Revoke** (`release.review`) is audited.

`GET /api/enrollments/:id/resources?episodeId=` returns only live, unexpired,
unrevoked attachments for the learner's pinned release. The learner sees them as
collapsed optional help with click-to-load privacy-enhanced players. Delivery is
never progress, gate evidence or mastery, and a review is a content-use decision,
not a truth certificate. All mutations take an idempotency key and append
`research.*` audit events. The administration workspace exposes the full flow
under **Research sources**. Live inspection of real third-party pages depends on
the deployment's network; tests use a synthetic inspector and never fetch.

## Run the connected learner locally

The application server is separate from the disposable test host. Set `DATABASE_URL` securely in your shell for an intentionally chosen development application database. Do not use your test database or commit a connection string. The server applies migrations at startup.

From the repository root, after `node scripts/orchestrate.mjs install api`:

```sh
npm --prefix apps/learner --workspaces=false run export:web
npm --prefix services/api --workspaces=false run build
LEARNER_WEB_DIR="$PWD/apps/learner/dist" \
  PUBLIC_ORIGIN=http://localhost:4310 API_HOST=127.0.0.1 PORT=4310 \
  npm --prefix services/api --workspaces=false start
```

| Setting | Purpose/default |
| --- | --- |
| `DATABASE_URL` | Required application PostgreSQL connection; never inherited by root API tests. A connection Postgres ends (restart, `pg_terminate_backend`, network loss) is logged as `{"event":"db.connection_lost","code":"<SQLSTATE or socket code>"}` and replaced on next use; a request using it at that moment fails, the process keeps running |
| `LEARNER_WEB_DIR` | Absolute path to the learner's exported `dist`; set it to serve the connected UI and `/demo` |
| `PUBLIC_ORIGIN` | Primary browser origin used for origin/cookie checks and links; defaults to `http://localhost:4310` |
| `ADDITIONAL_ORIGINS` | Optional comma-separated exact origins (at most 8) that are also trusted, e.g. a Tailscale `serve` proxy. Each is `https://`, or `http://` to a literal Tailscale address (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`) with an explicit port; no path, credentials, wildcard or default port. An invalid entry fails startup. `PUBLIC_ORIGIN` itself still requires HTTPS off loopback, and this does not change `API_HOST` |
| `ALLOW_INSECURE_ORIGINS` | Operator switch for the insecure-address check, `false` (check on) when absent or empty. Exactly `true` lets `ADDITIONAL_ORIGINS` also list any plain `http://` origin with an explicit port, such as a LAN address; any other value fails startup. Traffic to such an origin, sign-in included, is unencrypted and it gets no passkeys. Exact-origin matching, CSRF and cookie rules are unchanged; the API logs `origins.insecure_allowed` at start and the admin app shows a notice. The local pilot sets it with `node deploy/local/pilot.mjs security insecure-origin-check on\|off\|status` (`off` sets `true`); see `deploy/local/README.md` |
| `API_HOST` | Bind address; defaults to loopback `127.0.0.1` |
| `PORT` | Listen port; defaults to `4310` |
| `TRUSTED_PROXIES` | Optional comma-separated exact IP addresses (at most 16) of reverse proxies that append the client to `X-Forwarded-For`; off when absent or empty. Used only to key the sign-in and agent-key throttles; ranges, wildcards, host names and "trust everything" fail startup. Do not list an address that also carries raw TCP forwards or untrusted local processes (for example `127.0.0.1` behind `tailscale serve --tcp`) |
| `SESSION_HOURS` | Session lifetime in hours; defaults to `12`, at most `720` (30 days) |
| `SESSION_PURGE_INTERVAL_MS` | How often ended sessions older than 7 days are deleted; defaults to `3600000` (1 hour), minimum `60000`; a smaller or invalid value turns the purge off |
| `AUTH_LOGIN_CODES` | `enabled` accepts one-time sign-in codes; defaults to `disabled` |

On the trusted development server, a second shell with the same `DATABASE_URL` can create or reuse a workspace and owner and set the owner's password (prompted without echo; `--password` reads it from standard input when not on a terminal, `--no-password` skips it). The owner's username is the subject unless `--login <username>` is given:

```sh
PUBLIC_ORIGIN=http://localhost:4310 \
  npm --prefix services/api --workspaces=false run bootstrap -- local-course local-owner "Local Owner"
```

Then sign in at `http://localhost:4310/` or `/admin/` with that username and password. With `AUTH_LOGIN_CODES=enabled` set for both the API and the bootstrap, it also prints a one-time sign-in URL; treat that URL as a credential, open it privately and keep it out of source, screenshots and public logs. Its origin must match the server's configured browser origin. This bootstrap is distinct from the root `npm run bootstrap`, which installs dependencies and builds modules without provisioning accounts. Remote application serving requires HTTPS under the API's current startup checks. These commands describe a local connected path; backend integration, deployment and live-provider qualification are still in progress.

## Complete repository checks

Once every module and the SDK release dependency are ready:

```sh
npm run bootstrap
node scripts/orchestrate.mjs browsers web
node scripts/orchestrate.mjs browsers visuals
node scripts/orchestrate.mjs browsers api
env -u DATABASE_URL \
  TEST_DATABASE_URL=postgres://course_ci:course_ci_test_only@127.0.0.1:55432/course_core_ci \
  npm run check
```

`bootstrap` runs separate `npm ci --ignore-scripts --workspaces=false` installs and builds each module in dependency order. No root `npm install` is needed. The resolver applies to every selected module, including `check:web`, rather than special-casing the API's dependencies. Npm uses explicit public configuration/cache paths, with host `HOME` preserved and auth/provider environment variables omitted from subprocesses.

Local modules are installed as symlinks (`install-links=false`, recorded as `link` entries in the consumer lock), so rebuilding a prerequisite such as `packages/policy` is immediately visible to its consumers' TypeScript, tests and runtime without reinstalling. Only the Expo/Metro web apps, marked `copiesLocal` in `scripts/modules.mjs`, keep npm's `install-links=true` copies so bundling and React resolution stay inside the app; `audit:public` rejects copied local entries or `install-links=true` anywhere else. A consumer with copied local packages is reinstalled during `check` (and by `install`) after its dependencies are rebuilt, so a stale copy in `node_modules` cannot mask a fresh-checkout failure; after changing `packages/visuals` outside the root commands, rerun `node scripts/orchestrate.mjs install <app>`. These installs use the existing lockfile and never rewrite child manifests or locks.

The root runs modules sequentially. A checkout lock rejects overlapping root commands, keeping app exports/builds and their browser suites in the same ordered operation. Separate CI matrix jobs use separate checkouts. Do not run an app's direct export/build, install, or preview command while a root check owns that checkout; commands outside the orchestrator cannot participate in its lock. After a crashed command, `node scripts/orchestrate.mjs unlock` removes a lock only if its owner process no longer exists.

CI uses Node 26, separate policy/provider/supervisor jobs, the sandbox unit/real-Docker job on hosted Linux, a disposable Postgres 17 API job with mandatory practical Docker qualification and connected learner browsers, learner/admin demo browser jobs with axe assertions, and the visuals package's browser suite. All required modules are checked: missing code, tests, manifests, lockfiles, release dependencies, images, or qualification entrypoints are failures. Public CI has no deployment/provider secrets, no private repository checkouts, no publishing permissions, and no native-mobile build steps.

## Integration and deployment gates

- **Released contracts:** consume the exact public SDK release asset in API metadata and keep its integrity locked. A pushed SDK commit is not a downloadable release artifact.
- **Server/UI adapters:** the connected learner path and disposable-database browser gate now exist. Continue backend/admin integration, broader workflow and reconciliation coverage, and deployed-environment acceptance. Local storage and demo receipts are not authorization or durable server evidence.
- **Provider execution:** configure authorized models and credentials server-side, verify live account capabilities, and integrate budget, moderation, retries, artifact storage, and job lifecycle with server policy. No live provider call is made by root CI.
- **Deployment:** the API/deployment owner maintains entrypoints, containers/compose, migrations, TLS/origin/cookie settings, secret delivery, backup/restore, observability, and production smoke tests. Root CI does not deploy or qualify these.
- **Accessibility and native:** automated axe checks and browser workflow tests cover their tested views. Human keyboard/screen-reader review and production CSP checks remain necessary; iOS/Android builds and device qualification are deferred.

See [CONTRIBUTING.md](CONTRIBUTING.md) for CI maintenance and [SECURITY.md](SECURITY.md) for reporting. The [threat model](docs/threat-model.md) describes trust boundaries, mitigations and residual risks; the [pilot guide](deploy/local/README.md#availability-recovery-targets-and-degraded-modes) gives availability and recovery targets and degraded modes; the [Linux/Docker self-host guide](deploy/docker/README.md) runs Core on any Linux server behind an HTTPS proxy, and CI brings that stack up on every pull request; [performance budgets](docs/performance-budgets.md) describes the browser performance and memory checks. [Internationalization](docs/i18n.md) explains message catalogs, right-to-left layout, locale selection and the hardcoded-string check; Hebrew wording follows the [glossary](docs/i18n-glossary.md). The [usability protocol](docs/usability-protocol.md) explains how to test the 90% learner task-success targets and analyse them with a study's research export. [Accessibility checks](docs/accessibility.md) lists what the automated accessibility tests prove and the manual screen-reader traversal of a full lesson. Original repository code is licensed under [Apache-2.0](LICENSE); dependencies retain their own licenses.
