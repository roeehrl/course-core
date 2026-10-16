# Course Core administration — connected integration

`/admin/` now opens the real same-origin application using `/api/admin`, the existing cookie session and the readable CSRF cookie. Staff sign in with a username and password (a temporary password must be replaced first) and can change their password from the connection bar; the one-time code form appears only when the server reports `loginCodes: true` at `/auth/options`. `/admin/demo` explicitly selects the separate public in-memory demo. A connection/authentication failure never falls back to fictional data. Production assets are built with Vite base `/admin/`.

The allowed implementation scope is this app plus exactly:

- `services/api/src/admin-routes.ts`
- `services/api/migrations/006_admin_catalog.sql`
- `services/api/test/admin.integration.test.ts`

No learner, root configuration, released SDK, policy engine, provider bridge, companion routes, server entrypoint or parent test files were changed.

## Parent registration — required in server.ts

This task does not own the server entrypoint. The self-contained integration/browser harness registers these hooks and exercises the real database. The parent must add the same registration to the actual server composition:

```ts
import { registerAdminRoutes, ensureCatalog } from "./admin-routes.js";

registerAdminRoutes(app, db, auth, {
  installedExtensions: () => options.installedExtensions ?? [],
  providerStatus: () => ({
    models: providers.describe(),
    roles: providers.status(),
  }),
});
```

After the existing release-import `INSERT`, **inside that same transaction**, call:

```ts
await ensureCatalog(client, releaseId);
```

`ensureCatalog` groups versions by workspace + course key, links the release review record, and is idempotent. Migration 006 backfills existing releases. Apply migrations using the parent's existing migration mechanism. This work ran migrations only in isolated test schemas, not a production database.

Use the existing `adminDirectory` static option with this app's `dist`. Add `/admin/demo` as an explicit alias to its `index.html`, just as `/admin/` is served. Do not automatically choose demo based on an API error. The browser fixture host demonstrates registration and the static alias without modifying `server.ts`.

The runtime callback is trusted server code and supplies only public model/capability/configuration descriptors. It does not accept client capability declarations or read credential environment variables in the browser. Configuration never implies a successful provider verification.

## Run and verify

Run app commands from this directory with Node 26:

```sh
npm ci --workspaces=false
npm run typecheck
npm test
npm run build
npm run test:web
npm run format:check
```

The PostgreSQL suites require the explicitly selected dedicated test database through `TEST_DATABASE_URL`. They create randomly named schemas, run real migrations and remove their own schemas on shutdown. There is no in-memory database fallback.

```sh
# Set TEST_DATABASE_URL to the authorized dedicated PostgreSQL test database.
npm run test:api
npm run test:real
```

- `test:api` targets only `services/api/test/admin.integration.test.ts`; it does not run or edit parent tests.
- `test:web` serves the production build at `127.0.0.1:4174` and runs explicit-demo and mocked-transport browser checks. Results: `test-results/mock`.
- `test:real` serves the production build plus real API routes on loopback: fixed port `4384` in CI (`CI=true`), a free loopback port locally so suites in separate checkouts can run at the same time, or `COURSE_ADMIN_REAL_PORT` when set. `COURSE_BROWSER_PORTS=fixed|free` overrides the mode, as for the connected host (`services/api/browser/ports.ts`). The config passes the chosen port to `scripts/real-server.ts`; specs use the configured `baseURL`, never a literal port. The host runs with an isolated PostgreSQL schema. Its fixture enables one-time login codes and signs staff in through the real `/auth/redeem` route and real session/CSRF cookies; the people suite invites a learner with a temporary password and completes the must-change sign-in through `/auth/login`. Results: `test-results/real`.
- Browser suites use locally installed Google Chrome. Build first. Do not leave a manual preview running on their ports.
- `scripts/real-server.ts` contains test-only fixture routes on loopback. It is never imported by production code.
- From the repository root, API source typechecking is `services/api/node_modules/.bin/tsc --noEmit -p services/api/tsconfig.json`; it creates no API build output.

## Backend invariants and permissions

All real writes use PostgreSQL transactions and stored receipts. Course writes serialize on a catalog revision. Profile/evidence writes also compare the enrollment revision, preventing a stale admin view from overwriting intervening learner activity. Enrollment policy writes serialize on the enrollment and enforce policy/ledger revisions. Replayed idempotency keys return the committed response; changed semantics or a different actor cannot reuse a receipt. Audit failure rolls back the mutation and receipt.

| Workspace role | Allowed administration                                                                                                                                                 |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| owner, admin   | Catalog, drafts, release review/publication, enrollment/profile/evidence, policy preview/migration, extension proposals, provider metadata requests, operational reads |
| author         | Course catalog and draft bundles; no learner records or runtime debug data                                                                                             |
| instructor     | Enrollment/profile/evidence, policy inspection and extension proposals, scoped operational reads                                                                       |
| reviewer       | Release review, enrollment/evidence inspection and decisions, policy inspection, scoped operational reads                                                              |
| observer       | Course overview and published releases; no enrollment or debug data                                                                                                    |
| learner        | No `/api/admin` access                                                                                                                                                 |

Presentation flags are derived per workspace. Every server route authorizes again. Cookie authentication, exact Origin and CSRF validation use the existing auth service; the browser never supplies an authoritative actor/role or provider credential.

## Actual implemented workflows

**Catalog and releases.** A catalog groups immutable released bundles. Administrative titles/descriptions do not rewrite published content. Draft creation clones a stored bundle into a new version, or accepts a complete manifest; draft editing exposes the full released-SDK manifest to authorized authors. SDK compilation/digest checks validate the draft. Editing clears approval. Review binds to the exact digest. Publication checks that digest and calls the parent's current `assertCourseRunnable` again inside the transaction. Database triggers also prevent published/archived content rewrites and deletion.

Publication delegates to the current parent `assertCourseRunnable`. Code assessments require a matching file-hash-prefixed `sha256-` manifest and a configured runtime with `codeReady`, `validateCodeAssessment` and `evaluateCode`; the parent `code-evaluator.ts` supplies the real sandbox handler. A gate naming a conversational evaluator is refused with `PUBLISH_CONVERSATIONAL_GATE_UNSUPPORTED` (the gate IDs are in `details.gateIds`) because Core has no conversational gate runtime yet; activity paths remain blocked until their handlers exist. Visuals require installed declarations and a validator that accepts the scene. `PUBLISH_EVALUATOR_RUNTIME_UNAVAILABLE`, `PUBLISH_ACTIVITY_RUNTIME_UNAVAILABLE`, `PUBLISH_VISUAL_VALIDATOR_MISSING`, `PUBLISH_VISUAL_INVALID` and missing capabilities remain blocking errors; metadata alone never substitutes for a working handler.

**Enrollment/profile/evidence.** Staff create enrollments only for existing members of the same workspace and pin a published release. Profile saves never change evidence. Progress and descendant access are projected through the existing `learningSnapshot`/gate logic. Accepting an evidence review only acknowledges an existing valid independent deterministic result: the server regrades the stored answer and checks the stored attempt, challenge assistance, independence eligibility and release digest. It never rewrites `passed`, `independent` or a completion record to award credit. Incorrect/assisted/obsolete/unsupported results are refused. Rejection invalidates evidence and records a staff audit event; descendant availability is recomputed. Revoking evidence after completion does not silently reopen a closed policy, and it does not change the enrollment status: a `completed` enrollment stays `completed` (with its completed-course questions) and a `closed` (cap/deadline) one stays `closed`. The learner gets a closed-record notice and the change is audited as `enrollment.closed_record_amended`.

**Learning policy.** Course/chapter/episode modes, anchored calendar windows, hard/soft/ultimate dates, ancestor caps, work quotas, pool totals/max grants/max days per grant, balances, offers and consent are actual projections of the existing policy state. Tool/job budget counters appear separately in the provider view. There is no 60-minute whole-course limit or minutes-to-calendar-days conversion.

Calendar previews call the existing policy domain with `{scopeId, days}`. Proposals require rationale events from that enrollment and activities within the proposed scope. A proposal adds a real exact-terms offer and receipt; it grants no extension, changes no deadline/work cap, debits no allowance and supplies no learner consent. **No admin acceptance or grant endpoint exists.** The existing learner endpoint remains responsible for authenticated learner acceptance of the exact `termsDigest`.

Policy edits use full scope definitions, not an underspecified budget form. A server-computed impact preview is persisted with actor, enrollment, revisions, digest and expiry. Apply accepts only that actor-bound stored preview plus a reason, calls `applyPolicyChange`, and records server authority/audit receipts. The domain preserves established anchors/windows, scope identities, existing pools, grants and ledger history. The UI shows before/after deadlines/work quotas, affected reservations and superseded offers before applying. Editing a request invalidates the preview/review acknowledgment. Policy mutations resynchronize the course snapshot before subsequent profile/evidence edits.

**Providers.** Configuration comes from the trusted runtime callback. Saving a public label/environment creates a real operator-review request; it does not modify credentials, enable a model, call a provider or fake verification. The browser accepts no provider keys.

**View as learner.** Owners and admins (permission `learner.view`) can open a read-only view of one enrollment from **Enrollments**: the learner app's own snapshot (path, progress, gate evidence, current lesson content including visuals, open checks, applied personal changes with their hidden state, written-answer reviews, and the course-made media attached for the learner with a player or placeholder, captions and transcript; clips play only under the viewer's own recorded view, for an hour). Each opening first writes an append-only `staff_learner_views` record (viewer, role, enrollment, revision, time; migration 030) and a workspace `learner.viewed_by_staff` event, then reads in a read-only transaction. The view issues no learner session or cookie and offers no command; the actor stays the staff member, so every learner command refuses them. The view shows the enrollment profile, learning goal included, as **Enrollments** does. The companion conversation, the learner model (the learner's own notes, including its private copy of the goal) and device-local drafts are never included. Instructors and other roles get 403, other workspaces 404, erased enrollments 410. The learner sees every view under **Your data** (`GET /api/enrollments/:id/staff-views`) and in their export (`staffViews`). Staff data exports from **Learner data requests** are recorded the same way (append-only `data_exports` with the exporter's role, migration 038) and appear in the same learner list (`exports`) and in the learner's export (`staffExports`). Staff exports leave out the companion conversation and the learner model (`companion` and `learnerModel` are `null`, `withheld` lists them) and the learner's own words in gate review requests and written-answer appeals (`reason: null`; reviewers still read them in the gate review and appeal queues, where they decide); the learner's own download includes them. Staff exports carry the enrollment profile (display name, learning goal, pace). Staff calls to the learner-model API get only the evidence-derived understanding and the enrollment profile; the learner's own notes, proposals, change log and question history are not available to staff. All three surfaces apply the same rule (`services/api/src/learner-privacy.ts`), which shows the enrollment profile to every role with `enrollment.read` and to no other role.

**Operational inspection.** Real jobs, event metadata, context references, operation states, reserved/used tool budgets and artifact metadata are scoped to the catalog's workspace/course/enrollments. Raw context, event payloads, prompts, provider outputs, private reasoning and artifact bodies are not selected for debug responses. Artifact previews display persisted ID/digest/verification metadata as inert JSON, explicitly labeled as metadata-only. This is deliberate minimization, not a simulated artifact.

## API surface

Base: `/api/admin`. Reads return runtime-validated presentation models in `src/domain/contracts.ts` and `src/domain/policy.ts`; all of these routes are implemented by `registerAdminRoutes`.

- `GET /session`, `GET /courses/:id`
- `PATCH /courses/:id`
- `POST /courses/:id/releases`
- `GET /courses/:id/releases/:releaseId/manifest`
- `PATCH /courses/:id/releases/:releaseId`
- `POST /courses/:id/releases/:releaseId/transitions`
- `POST /courses/:id/enrollments`
- `PATCH /courses/:id/enrollments/:enrollmentId/profile`
- `POST /courses/:id/enrollments/:enrollmentId/evidence/:evidenceId/review`
- `GET /enrollments/:enrollmentId/policy`
- `POST /enrollments/:enrollmentId/extensions/preview`
- `POST /enrollments/:enrollmentId/extensions/propose`
- `POST /enrollments/:enrollmentId/policy/preview`
- `POST /enrollments/:enrollmentId/policy/migrate`
- `POST /courses/:id/providers/:providerId/configuration-requests`
- `GET /courses/:id/runs/:runId`
- `GET /enrollments/:enrollmentId/learner-view` (owner/admin; read-only and audited, see below)

Catalog mutations use `If-Match` and `Idempotency-Key` headers. Profile/review bodies include `enrollmentRevision`. Policy commands use numeric `expectedRevision` and `idempotencyKey` in the body. The same-origin client reads only the `course_csrf` cookie for the CSRF header. Provider secrets are never read from cookies, environment variables or application storage.

## Verification and practical limits

Verified on Node 26: 40 frontend unit/component/transport tests, 16 real PostgreSQL admin integration tests, 14 demo/mocked-transport browser tests and 6 real PostgreSQL/API browser tests passed. Admin/API typechecks, production build and formatting passed. Real browser runs include sign-in/out and policy-to-profile revision resynchronization.

Parent compatibility follow-up: `services/api/test/supervisor-bridge.integration.test.ts:275` deliberately changes the digest of a published release. Migration 006 correctly rejects that fixture mutation. The parent must update that stale-course test to use a new release/repoint the enrollment; this task did not edit or claim a passing parent suite.

The suites cover real PostgreSQL authentication/CSRF, memberships, concurrent retries, stale revisions, audit rollback, immutable releases, capability-gated publication, scoped enrollment, refused grade promotion, evidence invalidation/relocking, exact-consent extensions, migration preservation/staleness and debug redaction. Real browser tests cover sign-in/out, release editing/review/publication/reload, profile persistence, refusing incorrect evidence acceptance, rejection, proposal-only extensions and concrete migrations. Demo/mocked browser tests cover accessibility, errors, focus and responsive layout.

Production server registration and migration rollout remain parent operations. The test harness explicitly registers admin routes when absent; its passing results do not establish production entrypoint wiring. No deployment, commit, push or native build was performed. These admin tests do not qualify live external providers or code execution itself; the parent `services/api/qualification/practical-flow.ts` exercises real code execution. Rubric/conversational-evaluator/activity handlers remain separate unfinished runtime gates. Debug reads are intentionally metadata-only. Current course snapshots bound directory reads to 500 enrollments and run lists to 100 jobs; pagination is not implemented. The local demo remains resettable and is never an authorization or persistence boundary.

## Changed inventory

The server-side changes are exactly the three files listed at the top. The app inventory below includes all owned source/configuration/test files; generated dependencies, caches, `dist` and browser results are ignored.

```text
.gitignore
.npmrc
README.md
index.html
package-lock.json
package.json
playwright.config.ts
playwright.real.config.ts
scripts/real-server.ts
src/AdminApp.tsx
src/ConnectedHost.tsx
src/DemoHost.tsx
src/client/demoClient.ts
src/client/demoPolicyClient.ts
src/client/fetchClient.ts
src/components/ActionFeedback.tsx
src/components/DraftEditor.tsx
src/components/ExtensionComposer.tsx
src/components/ExtensionTerms.tsx
src/components/PolicyDetails.tsx
src/components/PolicyMigrationEditor.tsx
src/components/ui.tsx
src/data/fixtures.ts
src/data/policyFixtures.ts
src/domain/contracts.ts
src/domain/errors.ts
src/domain/policy.ts
src/hooks/useAdmin.ts
src/index.ts
src/main.tsx
src/styles.css
src/views/CourseView.tsx
src/views/EnrollmentsView.tsx
src/views/PolicyView.tsx
src/views/ProvidersView.tsx
src/views/RunsView.tsx
tests/calendarPolicy.test.ts
tests/components.test.tsx
tests/demoClient.test.ts
tests/fetchClient.test.ts
tests/helpers.ts
tests/hooks.test.tsx
tests/real/admin.real.spec.ts
tests/setup.ts
tests/web/admin.spec.ts
tests/web/connected.mock.spec.ts
tsconfig.json
vite.config.ts
vitest.config.ts
```
