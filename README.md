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

## Supported SDK range

Core consumes `@course-core/sdk` only as exact, lockfile-pinned public release assets:

| Component | SDK release |
| --- | --- |
| `services/api`, `packages/adaptation`, `apps/learner` | 0.5.0 |
| `packages/visuals` | 0.2.0 |
| `examples/courses` | 0.1.0 |

Course bundles are supported for SDK releases `>=0.1.0 <0.6.0`. Every release in that range keeps course schema 1 and compiled format 1, so the API validates with 0.5.0 and still accepts bundles authored with 0.1.0 to 0.4.0 unchanged: 0.4.0 packs recompile byte-identically (`services/api/test/sdk-compat.integration.test.ts` pins their 0.4.0 digests and runs one through real HTTP and PostgreSQL) and CI loads the 0.1.0 example packs. Features from later SDK minors (0.3 `retention`, 0.4 `insert_episode`, 0.5 versioned gates and item types) need the matching release. Bundles from SDK 0.6 or later are unsupported until Core pins that release.

### Gates and assessment (SDK 0.5)

Core computes every gate decision itself from persisted, server-issued evidence and records it in `gate_decisions` (migration 036), bound to the gate version, course digest and policy revision. A decision has one of five statuses (`ready`, `needs_evidence`, `needs_help`, `under_review`, `closed_with_gaps`), per-criterion results, a learner-visible reason and concrete next actions. `GET /api/enrollments/:id/gates/:gateId/decision` returns the current decision and `.../decisions` its history. The `complete` command recomputes the decision at commit time; a refusal returns the status and next actions (`GATE_NOT_READY` for versioned gates, `EVIDENCE_REQUIRED` with the 0.4 details for unversioned ones), and a `gateDecisionId` from another tab, policy revision or enrollment is refused (`GATE_DECISION_STALE`, `GATE_DECISION_UNLINKED`).

Versioned gates need independent success in the declared families, independent transfer on production work (recognition never counts) and no unresolved critical misconception; Core refuses recognition-only gates and gates that cannot collect transfer or misconception evidence at publish. Unversioned 0.4 gates keep their 0.4 pass rule. Prediction and trace items are graded deterministically (prediction honours relative tolerance and units), code repair uses the installed code evaluator, and counterexample, experiment-design and teach-back tasks go to quoted human review. "I don't know" is recorded without evidence or a failed result, and optional confidence is stored but never graded. A course retention policy without intervals uses 1, 3, 7 and 21 days.

A versioned gate may name a `conversationalRubricRef`: the learner explains in their own words, a reviewer may ask neutral follow-up questions in the same thread, an optional AI draft (learner opt-in, scripted model in tests) proposes quoted findings, and only a human reviewer's findings that quote the learner create evidence. Core refuses the conversational rubric at publish unless it requires cited evidence and an evaluator that requires human confirmation. Unversioned `conversationalEvaluatorId` gates are still refused. An answer that reproduces a sentence of a companion reply is refused as agent-authored.

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
  account's count. Within a 15-minute window an account (keyed by a hash of the
  normalised username, whether or not it exists) allows 10 failures and a client
  address 100; beyond that every attempt, even with the right password, gets
  `429 LOGIN_THROTTLED` with `Retry-After`. The address is the TCP peer (Fastify
  `request.ip`; no proxy headers are trusted), so behind a reverse proxy all
  clients share the address budget while the per-account limit still applies.
  Rows older than the window are deleted as new attempts arrive.
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
  - The relying party ID and expected origin come only from `PUBLIC_ORIGIN`: the
    RP ID is its host name and the origin must match exactly. Browsers refuse IP
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
    requested it. Each client address may hold at most 50 open sign-in challenges.
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
    `http://localhost:4318`. Playwright has no virtual authenticator for WebKit or
    Firefox, so `playwright.engines.config.ts` skips the passkey journeys there;
    physical-device passkey acceptance remains a separate gate.
- **Session lifetime** defaults to 12 hours. Set `SESSION_HOURS` (fractions
  allowed, at most 720 = 30 days; pilot: `"sessionHours"`). Expiry is computed
  from database time.

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

**Conversational gates are not supported yet.** The SDK accepts a gate with
`conversationalEvaluatorId`, but this Core version has no runtime that could
decide such a gate, so publication refuses it with
`PUBLISH_CONVERSATIONAL_GATE_UNSUPPORTED` (409, `details.gateIds` names the
gates), whatever extensions are installed. To judge a written or conversational
answer today, put a rubric assessment in the gate's `assessmentIds`: it is
reviewed with quoted findings and can continue as a clarification conversation.

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
due, `deadline.approaching` when a binding course, chapter or episode deadline
is within 48 hours, and `deadline.reached` once when a chapter or episode
deadline passes with that scope's work unfinished. Each boundary is recorded
once per enrollment (`wakeup_signals`), so repeated or concurrent scans and
restarts do not duplicate it, and learners sharing one absolute deadline each
get their own. Every scan examines a bounded batch of active enrollments (500)
after a shared keyset cursor (`wakeup_scan_cursors`) and wraps around, so every
enrollment is reached in turn however many there are and concurrent processes
take different batches. Wake-ups only prompt the supervisor; commit-time policy
checks remain authoritative, and a late or missed wake-up never extends, unlocks
or grants anything.

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
`wakeup.failure` line on stderr; it never stops the scan of the others.

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
| `SESSION_HOURS` | Session lifetime in hours; defaults to `12`, at most `720` (30 days) |
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
