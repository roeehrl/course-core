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

Real Docker tests are an additional mandatory `Sandbox / real Docker Linux` CI job on a GitHub-hosted Ubuntu 24.04 runner. After the unit checks, CI runs `npm run sandbox:pull` and then `npm run check:sandbox:docker`. These root entrypoints reject non-GitHub-hosted or non-Linux execution rather than skipping qualification. The helper selects the native x64 or arm64 digest from the built `QUALIFIED_IMAGES`, verifies the Docker daemon architecture, explicitly pulls that exact Python image/platform, and inspects the image's digest and architecture. The test phase only inspects the prepared image and runs the package's `test:docker`; it never pulls. Missing Docker, missing/wrong images, or any failed test fail the job.

The current hosted job is x64. ARM64 pin selection is supported without emulation; local ARM64 results do not establish hosted x64 qualification. The package's tests cover real computation and wrong/self-awarded results, host-file/environment/network isolation, a read-only root, 128MiB memory limits, timeout/output flooding, cancellation and a shared filesystem admission lock. The reference grader remains outside the learner container. Learner execution retains `--pull=never`; image preparation is separate. No GPU or local model is provisioned.

Sandbox test work under `packages/sandbox/.local` is covered by the existing `.local/` ignore rule and is not uploaded as a CI artifact. Root `npm run check` includes sandbox unit/build checks; the separate Docker job and API practical qualification are also required before treating the full CI matrix as passed. Follow the package README for separately authorized local requalification and failed-cleanup handling. Production isolation, practical learning validity and broader API/evidence acceptance remain separate gates.

## API tests with disposable Postgres 17

The API currently pins the public SDK `0.2.0` release asset and its lockfile integrity. Root API checks require that explicit released dependency; a missing or mismatched pin fails instead of falling back to a development SDK. Future SDK upgrades and matching child lockfile changes remain the module owner's responsibility.

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

The connected suite uses the test-only host in `services/api/browser/start.ts`, loopback port **4317**, Google Chrome, and a fresh per-run schema. It exercises signed-in lessons, independent evidence, reloads, server gates and sign-out on desktop, phone and tablet. It complements the original `/demo` workflow/axe suite; both remain required. Missing browser configuration, host, suite or export is a failure.

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

## People and roles

Owners and admins manage workspace membership under **People & roles**
(`/api/admin/workspaces/:workspaceId/people`). Inviting a person creates an
account with a role and returns a single-use sign-in code once (10-minute
expiry); idempotent replays never reveal or reissue a code, and codes are never
stored in receipts. Admins manage only non-privileged roles; owners manage
everyone. Nobody changes or removes their own membership, so a workspace cannot
lose its last owner through this interface. A new sign-in code can be issued
only for an account invited into the same workspace that belongs to no other
workspace, because a code signs a person into every workspace they belong to.
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

**Conversation.** A clarification request can be answered by the learner in the
same thread (`POST /api/enrollments/:id/reviews/:attemptId/reply`, once per
request); the reviewer then judges the exchange and may quote any of the
learner's turns. The reply stays independent only when the reviewer declared the
note a neutral question (`probeOnly`) and the learner asked the companion
nothing since; otherwise it counts as practice. While a clarification request is
open the learner sees only the reviewer's note, never the per-criterion findings
(the review view and the export both withhold them until the exchange is judged).

**AI drafts for reviewers.** With the learner's separate opt-in
(`/api/enrollments/:id/review-assist`, off by default), a reviewer may queue a
draft of the findings (`POST /api/admin/rubric-reviews/:attemptId/assist`). It
runs as a budgeted `reviewer` supervisor job that sees only the question, rubric
and answer, and is shown only after the host verifies that every "met" finding
quotes the answer verbatim and nothing changed since the request. A draft is
never evidence or a grade. See `services/api/RUBRIC_ASSIST.md`.

## Individual accommodations

Owners and admins can give one learner an accommodation (extra calendar days on
a scope's window or absolute deadline, extra planned minutes or episodes) or an
approved pause (moves a pause-enabled window only) through
`/api/admin/enrollments/:id/accommodations/preview` and `…/apply`, or the
**Accommodation for this scope** action in the Policy view. The apply step needs
an unexpired preview made by the same person against unchanged revisions, records
an audited authority receipt, and does not draw on extension pools or affect
other learners. The reason is a reference such as an approval ticket, not
health or personal details.

## Supervisor wake-ups

The API scans every `WAKEUP_INTERVAL_MS` (default 60 s, minimum 10 s) and emits
one supervised event per boundary: `retention.due` when a delayed check comes
due and `deadline.approaching` when the binding course deadline is within 48
hours. Each boundary is recorded once (`wakeup_signals`), so repeated or
concurrent scans and restarts do not duplicate it. Wake-ups only prompt the
supervisor; commit-time policy checks remain authoritative, and a late or
missed wake-up never extends, unlocks or grants anything.

## Least-privilege database operation

Production-style deployments set `MIGRATION_DATABASE_URL` (schema owner) beside
`DATABASE_URL` (a separate runtime login role). The API migrates and grants with
the owner connection, then serves only as the runtime role, which receives data
access but no DDL, TRUNCATE, trigger or schema-creation rights and must not own
tables; startup fails otherwise. Immutable-history triggers and erasure work
unchanged under the runtime role. Without `MIGRATION_DATABASE_URL` the API keeps
the single-role behaviour for development.

## Questions after completion

A completed course keeps bounded explanatory questions when its policy keeps
existing material readable (`existingMaterialAccess: read_only`, the default).
The companion route checks the policy's `read` action instead of starting study
windows or planning, and the supervisor admits only **companion** jobs for a
completed enrollment, checking `read` at admission, input, tool and publication
fences. Planner, research and adaptation work never resume, new checks are
refused, and provider budgets still bound every answer. A policy that closes
existing material refuses the question (`ACCESS_CLOSED`).

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
restored as a whole.

## Delayed retention checks

Courses declaring SDK 0.3 `retention` get one schedule per retention objective,
derived from when the evidence completing its gate was recorded (so schedules
are reproducible and created idempotently on first read). When a check is due,
`POST /api/enrollments/:id/retention/check` issues an unseen held-out item as an
independent challenge in mode `retention`; a second pending check is refused.
An independent success records the objective as retained and schedules the next
interval from the demonstration time; a miss marks it for review one first
interval later without revoking demonstrated understanding. When no unseen item
remains the API says so (`RETENTION_ITEMS_EXHAUSTED`) instead of repeating one.
Retention never changes gates, completion or lesson states. Learners see an
optional Delayed checks panel. Notifications and supervisor wakeups for due
checks are not implemented yet.

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
as `placed` progress with evidence references and no invented reading. Staff see
the run state, stop reason and exemptions. The legacy per-episode
`complete { placement: true }` path is refused in favour of run acceptance.

## Learner data export and erasure

A learner can download everything an enrollment recorded about them
(`GET /api/enrollments/:id/export`, format `course-core.enrollment-export` v1):
profile, attempts and evidence, companion conversations, learner model,
deadline/extension records, supervision summaries and events. Course content,
grading keys and other learners are excluded. Owners and admins can export on a
learner's request through `/api/admin/enrollments/:id/export`; instructors and
other staff cannot. Each export records its digest and an audit event.

Erasure (`POST .../erase`, typed confirmation `ERASE <first 8 id characters>`
and a reason) is irreversible. It first withdraws supervision consent and waits
for running supervisor jobs to stop, then redacts personal content in one
transaction: answers, results, conversations, learner-model history, personal
teaching artifacts, supervisor inputs/outputs, receipts and event payloads.
Identifiers, timestamps, event types, spend and extension accounting remain as
an audit skeleton. Immutable learning-history tables accept this redaction only
inside a transaction that names the same enrollment (never deletion). The
enrollment becomes `erased`: reads return 410, it cannot be resumed or silently
re-created, and staff views show only the skeleton. Durable workflow histories
and backups are not rewritten; they expire under their own retention settings.

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
| `DATABASE_URL` | Required application PostgreSQL connection; never inherited by root API tests |
| `LEARNER_WEB_DIR` | Absolute path to the learner's exported `dist`; set it to serve the connected UI and `/demo` |
| `PUBLIC_ORIGIN` | Browser origin used for origin/cookie checks; defaults to `http://localhost:4310` |
| `API_HOST` | Bind address; defaults to loopback `127.0.0.1` |
| `PORT` | Listen port; defaults to `4310` |

On the trusted development server, a second shell with the same `DATABASE_URL` can create or reuse a workspace/owner and issue a one-time sign-in URL:

```sh
PUBLIC_ORIGIN=http://localhost:4310 \
  npm --prefix services/api --workspaces=false run bootstrap -- local-course local-owner "Local Owner"
```

Treat the emitted sign-in URL as a credential: open it privately and keep it out of source, screenshots and public logs. Its origin must match the server's configured browser origin. This bootstrap is distinct from the root `npm run bootstrap`, which installs dependencies and builds modules without provisioning accounts. Remote application serving requires HTTPS under the API's current startup checks. These commands describe a local connected path; backend integration, deployment and live-provider qualification are still in progress.

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

Both symlinked local packages and npm's `install-links=true` copies are supported. A consumer with copied local packages is reinstalled during `check` after its dependencies are rebuilt, so a stale copy in `node_modules` cannot mask a fresh-checkout failure. These installs use the existing lockfile and never rewrite child manifests or locks.

The root runs modules sequentially. A checkout lock rejects overlapping root commands, keeping app exports/builds and their browser suites in the same ordered operation. Separate CI matrix jobs use separate checkouts. Do not run an app's direct export/build, install, or preview command while a root check owns that checkout; commands outside the orchestrator cannot participate in its lock. After a crashed command, `node scripts/orchestrate.mjs unlock` removes a lock only if its owner process no longer exists.

CI uses Node 26, separate policy/provider/supervisor jobs, the sandbox unit/real-Docker job on hosted Linux, a disposable Postgres 17 API job with mandatory practical Docker qualification and connected learner browsers, learner/admin demo browser jobs with axe assertions, and the visuals package's browser suite. All required modules are checked: missing code, tests, manifests, lockfiles, release dependencies, images, or qualification entrypoints are failures. Public CI has no deployment/provider secrets, no private repository checkouts, no publishing permissions, and no native-mobile build steps.

## Integration and deployment gates

- **Released contracts:** consume the exact public SDK release asset in API metadata and keep its integrity locked. A pushed SDK commit is not a downloadable release artifact.
- **Server/UI adapters:** the connected learner path and disposable-database browser gate now exist. Continue backend/admin integration, broader workflow and reconciliation coverage, and deployed-environment acceptance. Local storage and demo receipts are not authorization or durable server evidence.
- **Provider execution:** configure authorized models and credentials server-side, verify live account capabilities, and integrate budget, moderation, retries, artifact storage, and job lifecycle with server policy. No live provider call is made by root CI.
- **Deployment:** the API/deployment owner maintains entrypoints, containers/compose, migrations, TLS/origin/cookie settings, secret delivery, backup/restore, observability, and production smoke tests. Root CI does not deploy or qualify these.
- **Accessibility and native:** automated axe checks and browser workflow tests cover their tested views. Human keyboard/screen-reader review and production CSP checks remain necessary; iOS/Android builds and device qualification are deferred.

See [CONTRIBUTING.md](CONTRIBUTING.md) for CI maintenance and [SECURITY.md](SECURITY.md) for reporting. Original repository code is licensed under [Apache-2.0](LICENSE); dependencies retain their own licenses.
