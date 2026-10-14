# Course Core learner

An Expo / React Native application with a connected web learner at `/` and an explicitly local authored demo at `/demo`. The connected learner uses the released SDK contracts, real same-origin account/enrollment endpoints, server-issued challenges, and the public `@course-core/visuals` package. It never derives course credit from reading controls, animation state, companion messages, or local storage.

## Run and verify

From this directory:

```sh
npm ci --workspaces=false
npm run typecheck
npm test
npm run check:expo
npm run export:web
npm run test:web
```

`check:expo` is hermetic: it runs `expo install --check` in offline mode with outbound network refused, so it compares installed dependencies with `expo/bundledNativeModules.json` from the lockfile-pinned `expo` package rather than Expo's live API (a new upstream patch cannot turn CI red). It first proves on a synthetic fixture that a mismatched native dependency still fails. Bumping `expo` to a newer patch is a deliberate lockfile change.

The production-export preview runs with `node scripts/serve.mjs` on loopback port 4173. It serves files only; `/` requires the API host or explicit test routes. `/demo` remains usable without an account. Stop the preview before `test:web`, which owns that port.

`@course-core/sdk` is pinned to the published v0.4.0 GitHub release tarball (see the root README for the supported SDK range). `@course-core/visuals` is the permitted `file:../../packages/visuals` dependency. `install-links=true` copies its built public package into this module's dependencies, keeping Metro and React resolution local; build that package before installing a fresh checkout. No sibling SDK source, private course bundle, or domain service code is imported into the application. This work does not modify the visuals package.

After the parent rebuilds the public visuals package, refresh the learner's copied dependency even when its version is unchanged (`npm ci --workspaces=false` re-copies it). Regenerate the public browser fixture with `node scripts/generate-visual-fixture.mjs`, then run the checks and export. SDK timeline cue events are identifiers such as `cue-0`; authored prose remains in the renderer scene. `tests/visualSdkFixture.test.ts` compares the fixture with the installed serializer, validates and compiles a whole course through the released SDK, and rejects prose in the outer SDK event field. The SDK schema is not loosened.

### React singleton and real visual mount

`metro.config.cjs` pins `react`, `react-dom`, and their subpaths (including JSX runtimes) to the learner installation. `extraNodeModules` alone is a fallback and cannot guarantee this for linked packages. The resolver therefore supplies the app origin and exclusive app module search paths, delegates conditional exports to Metro, and verifies the resolved real path. Only the public visuals package is added to watch folders. The actual Metro resolver test includes a conflicting foreign React package and checks browser/react-server conditions.

`npm run export:web:linked-visuals` temporarily links the public package, exports the real connected host, checks source-map contents against the learner's React files, then restores the copied dependency even on failure. It refuses a stale copy before starting. Run it serially: do not install dependencies or run Node unit tests while it temporarily changes that dependency. The resulting `dist` can be exercised by `test:connected`. Locally qualified versions are learner React/React DOM **19.2.3**, with the linked public package's own **19.3.0** dev peers present. This is web qualification only.

The learner-owned real API suite consumes the public sorting `VisualExperience` from the compiled server course. It checks the mounted SVG and hooks through `ConnectedHost → ConnectedLesson → VisualBlock`, timeline geometry, compact resizing without losing position, reduced motion, accessibility, and unchanged server revision/reading credit. It fails on script/renderer console errors; only the read-only harness's known missing favicon is excluded. This test is separate from the authored demo gallery and the HTTP-fixture UI tests. Private visual overlays are neither imported nor copied.

Real API/database browser checks require an explicitly disposable loopback PostgreSQL 17 database:

```sh
# Supply TEST_DATABASE_URL for course_core_ci or course_core_test[_suffix].
# Do not use an application/production database.
npm run export:web
npm run test:connected
```

The learner-owned connected test configuration starts the existing read-only API browser harness on port 4317, which creates and drops its own random database schema. Its cases run on desktop (1440), phone (390), and tablet (834) viewports. Do not run another API harness concurrently on that port. Test output stays in this module's ignored `test-results/connected` directory.

## Connected learning flow

`src/ConnectedHost.web.tsx` owns authentication, enrollment selection, server snapshots and command orchestration. A lesson has one back action, a compact heading, one current reading part, revisitable completed parts, and a clear next reading/check action. The finish action remains disabled until the server snapshot satisfies the checks and coverage. Progress uses the learner-facing phrase **independent checks**.

`src/connected/ConnectedLesson.web.tsx` renders actual course `MarkdownContent`, visuals, media and source references. It reads the current server challenge rather than bundling assessment answers. Placement remains optional and separately verified. Expired challenges preserve the local answer draft and offer a refresh; they are not submitted as a valid current attempt. Closed lessons cannot start new requests. Reading and media loading never mark anything complete automatically.

`src/client/apiClient.ts` preserves exact semantic payload, admitted revision and idempotency key while a request is uncertain. Loading an enrollment reconciles its saved pending command before requesting the current snapshot. Four-hundred responses clear rejected commands; transport/server uncertainty retains them. Corrupt pending records fail closed. An in-memory copy preserves retry identity even if session storage fails; a visible notice explains that reload recovery then cannot be guaranteed. A saved-request retry action is available in the connected UI. Answer and companion drafts are separately scoped by account, enrollment, course digest, and challenge/episode.

Server snapshots and receipts remain authoritative. The UI does not fabricate passed checks, update credits optimistically, or convert practice into independent credit. Browser state is user-editable and is not an authorization boundary.

## Companion: real persisted messages, honest asynchronous state

`src/client/companionClient.ts` exports `ContextualCompanionClient`, `CompanionContext`, `CompanionMessage`, and `CompanionReceipt`. The default client uses the implemented endpoints:

- `GET /api/enrollments/:id/companion` reads saved conversation rows.
- `api.command(snapshot, 'companion', { episodeId, blockId?, content, allowAssessmentAssistance? })` submits a versioned idempotent request.

Only an actual queued receipt confirms sending. Assistant text is rendered only when present in saved server messages; the learner does not simulate responses or claim provider availability. Known job states and `configuration_missing` are mapped to safe human-readable labels. Arbitrary provider error/reason payloads are never displayed. Every message includes its source lesson context. The endpoint currently supplies the most recent 100 messages.

All active independent challenges in the enrollment are considered before sending, not only the current lesson's challenge. The learner must explicitly choose between **Keep independent attempt** and **Switch to practice & send**. The `allowAssessmentAssistance: true` flag is sent only by the latter action. A server `ASSESSMENT_HELP_CONSENT_REQUIRED` response opens the same choice without resending. The server atomically downgrades affected challenges; the learner refreshes its snapshot after the send and displays the resulting practice status. If the snapshot refresh fails after a confirmed queued receipt, the draft is still acknowledged and only explicit server-returned assistance downgrades are reflected; a refresh action is offered. Chat cannot award course credit.

`useCompanionConversation` fetches on entry, then polls every three seconds while open or every five seconds for known queued work while closed. It does not overlap requests. Context/account changes and unmount abort the request and timer. Switching to a different enrollment cannot retain another enrollment's conversation view. GET responses—not transient local messages—restore history after reload.

The companion stays in a contextual side panel at sufficient effective desktop width/height. On phone/tablet, a fixed **Companion** button opens a focus-trapped drawer with an inert background and Escape dismissal. The same DOM content stays mounted across layouts: draft, textarea selection, and focus survive transitions. Closing restores the invoking control. Drafts persist in session storage independently of the panel and remain in memory if storage is denied. Native presentation uses a portable modal/text fallback; native connected transport is still deferred.

`ConnectedHost` accepts an optional typed companion client for host integration/testing. Its default is the real API client; no availability or provider endpoint is invented. The parent still owns outbox/worker/provider wiring, availability signaling, response verification and server assistance enforcement.

## Visuals, prose and sources

`VisualBlock.web.tsx` accepts the released SDK's `VisualExperience` and passes it through `fromVisualExperience`. The scene is never directly interpreted by the learner. Supported scenes use `VisualPlayer` and its shipped styles, responsive layouts, keyboard/pointer controls, timeline, and reduced-motion/text equivalent. Unknown renderers or invalid scenes show the authored SDK accessibility description instead. Equivalent scene JSON preserves runtime state across snapshot refreshes. Runtime callbacks are not wired to server reading or completion commands. The native `VisualBlock.tsx` renders only the text equivalent.

`MarkdownContent` remains a non-executable subset: paragraphs, headings, bold, inline code, fenced code and safe inline references. HTML remains literal text. `SourceLinks` renders source titles as HTTPS links only when the URL is explicitly safe; other references, including private URNs, remain plain labels. Credentials, non-HTTPS URLs, protocol-relative paths, control characters and backslashes are rejected. External links use `noopener noreferrer`. Private URN values are not placed in visible labels or link targets. No arbitrary HTML is injected.

## Reviewed media

Only reviewed YouTube resources with an exact allowed host and validated eleven-character video ID can embed. The browser constructs a fixed `https://www.youtube-nocookie.com/embed/ID?autoplay=0&rel=0` URL. No iframe or external video request exists until the learner presses **Load reviewed video**; autoplay permission is absent. A textual alternative remains visible, and the sandbox restricts the embedded frame. Other reviewed HTTPS media is an explicit external link, never an arbitrary iframe URL.

Required/unrequired status comes from the SDK **media block**, not `MediaResource`. Missing, unreviewed/rejected, unsafe, expired, or closed required media cannot be acknowledged or complete the episode through this UI, even if an old snapshot says it was read. URL `expires`/`expire` parameters are recognized; The SDK does not define a separate media expiry field, so no server expiry protocol is invented. The UI reevaluates known expiry times and unloads expired embeds. Loading, playback and iframe events never imply watched/read status or completion. Optional unavailable media may be read through its textual alternative.

These are user-experience guards. The parent owns equivalent authoritative publication/access/media enforcement in the API; client guards cannot prevent a manually constructed request. Real external YouTube playback has not been qualified by the intercepted-network UI tests.

## Exports and portability

`src/index.ts` exports the existing demo presentation ports plus `ConnectedHost`, `ConnectedCompanion`, `CompanionDock`, `VisualBlock`, `ReviewedMedia`, `SourceLinks`, companion/API client types and factories, and safe-resource helpers. DOM-specific rendering lives in `.web.tsx` files. Shared components keep React Native primitives and text/modal fallbacks. The connected native host explicitly directs learners to web; **no iOS/Android/RN build, signing, device test, or native runtime qualification is claimed**.

The parent owns API/auth lifecycle, canonical progression, course publication, policies and deadlines, receipts and evidence, provider orchestration, and deployment. This module owns the connected presentation, safe rendering adapters, drafts, and its existing command transport. No API, provider, root, admin, or visuals source files are changed here. No commits or pushes are part of this task.

## Verification and handoff

Verified locally on 2026-10-12 after the React singleton pin and refreshed visual cue serializer: TypeScript, Expo dependency compatibility and production web export pass; **74 unit/component tests, 24 production-export browser tests, and 6 real API/PostgreSQL 17 browser tests pass**. The real API suite ran against the deliberately linked visuals export with conflicting package dev peers present. Source maps verified all eight bundled React/React DOM modules against the learner installation. The final copied-dependency export produced the identical JavaScript bundle and passed the 24 production browser regressions. The temporary test database was removed.

The real suites cover desktop, phone and tablet, mount the compiled SDK visual, and assert zero enrollment POSTs before explicit Start, then one enrollment across start/reload/resume. Code-grader negative cases and extension-offer edge cases use declared HTTP fixtures; these are not a claim of live Docker grading or live extension approval qualification. Native builds remain deferred.

- Unit/component tests cover resource validation, safe fallback, actual visual runtime rendering, expired/unreviewed media, independent-check gates, typed companion transport, explicit consent, quiet polling/cancellation, responsive focus, account-scoped drafts and storage-failure retry safety. Existing demo session/client tests remain in place.
- `tests/web` runs the production export. Existing demo regressions are retained; connected visual/media tests use explicitly declared fixture HTTP responses and intercepted video requests. Those fixture tests are **UI acceptance only**, not proof of real API/provider behavior.
- `tests/connected-web` runs against the real API and disposable PostgreSQL: signed-in progression, dynamic checks, server gates, reload, sign-out, persisted companion messages, explicit practice consent, server downgrade, source context and responsive draft/focus preservation. Model replies are not simulated or required by these cases.
- `tests/metroSingleton.test.ts` exercises Metro resolution with conflicting peers; `tests/visualSdkFixture.test.ts` checks the installed serializer, SDK cue grammar and whole-course compilation. `scripts/export-linked-visuals.mjs` checks the actual linked export's module sources, and `tests/connected-web/authority.spec.ts` exercises its real server visual. Desktop/phone/tablet screenshots are named `connected-sdk-visual.png` under the connected test output directories.
- Axe checks the tested lesson, visual, and companion drawer views; this does not substitute for a human screen-reader audit.

The existing API-owned browser test remains untouched. In `services/api/browser/learner.spec.ts`, add a click on the **Start course** button after **Open course**, before continuing into the enrolled roadmap. Also change the exact completion text from `Your required evidence is recorded.` to `Your independent checks are complete.` The learner-owned real-flow tests include both changes. Other navigation/action locators are retained.

Screenshots and traces are generated under `test-results/web`, `test-results/connected`, and `test-results/api-original`. Check the task handoff for the final counts and exact pass/failure boundaries. Source changes are restricted to `apps/learner`.

## Connected Python exercises

The connected `Question` discriminated union now includes the released SDK's `code` fields: `language` and `starterCode`. Only the canonical language ID `python` can be submitted by the initial UI. The server's prompt remains visible above the editor; the protocol note explains that `solve(input)` receives a decoded JSON value and returns a JSON-compatible Python value. The runner handles JSON I/O, so learner code must not print results or read stdin. Only Python's standard library is supported initially; no package installation or network access is promised.

`CodeEditor.web.tsx` uses a plain, accessible monospace textarea at a mobile-safe 16px font size. Autocorrect, capitalization and spellcheck are off. Long lines scroll inside the editor, Tab leaves the field, and an explicit four-space insertion control supports touch keyboards. Optional `.py` / `.txt` import accepts strictly decoded UTF-8 source up to **64,000 bytes**, matching the broker's current source bound (slightly below 64 KiB). Import errors retain the existing draft, and delayed imports cannot overwrite newer typing or another challenge. No learner source executes in the browser or application process.

Untouched challenges show the authored starter. A deliberately emptied draft stays empty across reloads. Code drafts use an account/enrollment/course-digest/challenge namespace, retain up to 64,000 characters, and are checked against the stricter UTF-8 byte limit before submission. They do not inherit the companion's 4,000-character truncation. The bounded session-store envelope and denied/quota-failed storage preserve the current in-memory draft with the existing storage warning.

**Run code & check** submits the exact source string as `answer` to the existing `answers` command; it does not run or grade locally. The UI displays a pending state and the server's returned explanation. Unsupported languages, unconfigured/unavailable graders and malformed/inconsistent result receipts cannot display a fabricated pass. Retried code requests keep the original source, admitted revision and idempotency key; recovered answer receipts display the server's feedback. The solution-reveal action is omitted for code because the current `solution` endpoint only supports choice/numeric questions. Companion help still requires the explicit switch-to-practice choice for active independent code challenges.

`CodeEditor.tsx` provides the portable text-entry fallback; native connected execution remains deferred. The parent owns the qualified evaluator registry, hidden fixtures, Docker broker, publication checks and server credit. No sandbox or API implementation is imported into this learner. Code-specific browser tests deliberately use declared HTTP fixtures for negative responses; they are not live Docker/API grading qualification. `tests/codeEditor.test.tsx` and `tests/web/code.spec.ts` cover the editor, UTF-8 bounds/import failures, large/empty drafts, responsive/reload behavior, pending feedback, help consent, unsupported language and unconfigured-grader failure.

## Enrollment clocks, optional extensions and closure

`EnrollmentPreview` presents the catalog's released-SDK `LearningPolicy` and summary before creating a new enrollment: calendar window, timezone, fixed cap/target, pause behavior, access after closure, extension allowance/count/per-offer ceiling, and published additional-work limits. Missing or malformed policy metadata disables Start. Browsing and leaving this preview perform no enrollment mutation. **Start course** is the explicit start action. It refreshes the enrollment list and matches `releaseId` first; an existing enrollment is loaded without an enrollment POST. The server's unique learner/release enrollment remains the final protection against races. If a start request's outcome is uncertain, the preview says the clock may already be running; retry checks for the saved enrollment before creating anything.

After enrollment, `useEnrollmentPolicy` loads the real `/api/enrollments/:id/policy` response, aborting stale account/enrollment requests. The optional **Study dates & optional extensions** disclosure shows the server-resolved course and current chapter due dates, remaining allowance, and offers. Dates include timezone and UTC offset (including DST distinctions). The learner does not add days or recompute inherited deadlines. A fetch failure shows unavailable data rather than a fabricated zero balance or unlimited period. Opening the disclosure, using Refresh, or changing the enrollment revision fetches current values. This adds no mandatory tab or separate navigation workflow.

Each offer shows the server's before/after dates and allowance, added work, expiry, required approval, and optional plan details/alternatives. An unchecked explicit-consent control gates acceptance. Changes to the offer digest or policy revision reset consent; stale or expired offers cannot be accepted in this view. Acceptance sends exactly `{offerId, termsDigest, explicitConsent: true}` through `api.command`; decline sends `{offerId}`. Neither operation optimistically changes dates or balances. Pending approval is displayed separately from a granted extension, and saved policy data is refreshed after decisions. Technical transaction IDs and ledger names do not appear in the learner flow.

`ClosureSummary` renders the returned `closureReport`, separating material coverage from demonstrated understanding and outstanding gaps. A completed step list without a closure report is described as such. Both views explicitly state that this is a course learning record, **not professional certification or qualification**. No continuation, new enrollment, expansion, or extension is automatically accepted.

Policy/clock source files are `src/client/policyClient.ts`, `src/connected/policyPresentation.ts`, `src/hooks/useEnrollmentPolicy.ts`, `src/components/EnrollmentPreview.tsx`, `src/components/PolicyPanel.web.tsx`, and `src/components/ClosureSummary.tsx`, integrated in the connected host. Tests are in `tests/policy.test.tsx`, `tests/web/policy.spec.ts`, and the learner-owned real API suite. Screenshots include `before-start.png` and `extension-offer.png` under `test-results/web`. Server policy, grant transactions, sandbox execution and provider integrations remain parent-owned; this change edits only the learner module.
