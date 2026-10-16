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
| `services/api`, `packages/adaptation`, `packages/visuals`, `apps/learner` | 0.5.0 |
| `examples/courses` | 0.5.0 |

Course bundles are supported for SDK releases `>=0.1.0 <0.6.0`. Every release in that range keeps course schema 1 and compiled format 1, so the API validates with 0.5.0 and still accepts bundles authored with 0.1.0 to 0.4.0 unchanged: 0.4.0 packs recompile byte-identically (`services/api/test/sdk-compat.integration.test.ts` pins their 0.4.0 digests and runs one through real HTTP and PostgreSQL) and CI loads the example packs, which were authored for 0.1.0 and compile to the same digests under 0.1.0 and 0.5.0. Features from later SDK minors (0.3 `retention`, 0.4 `insert_episode`, 0.5 versioned gates and item types) need the matching release. Bundles from SDK 0.6 or later are unsupported until Core pins that release.

`packages/visuals` imports SDK types only, so its built JavaScript is byte-identical under 0.2.0 and 0.5.0 and it stays visuals 0.1.1. A visuals build's identity is every dist file plus its manifest, minus only the pin of that reviewed type-only dependency, so the released 0.1.1 fingerprint and the reviewed 0.1.0 prior build still resolve. See `RELEASES.md` and `packages/visuals/README.md`.

### Gates and assessment (SDK 0.5)

Core computes every gate decision itself from persisted, server-issued evidence and records it in `gate_decisions` (migration 036), bound to the gate version, course digest and policy revision. A decision has one of five statuses (`ready`, `needs_evidence`, `needs_help`, `under_review`, `closed_with_gaps`), per-criterion results, a learner-visible reason and concrete next actions. `GET /api/enrollments/:id/gates/:gateId/decision` returns the current decision and `.../decisions` its history. The `complete` command recomputes the decision at commit time; a refusal returns the status and next actions (`GATE_NOT_READY` for versioned gates, `EVIDENCE_REQUIRED` with the 0.4 details for unversioned ones), and a `gateDecisionId` from another tab, policy revision or enrollment is refused (`GATE_DECISION_STALE`, `GATE_DECISION_UNLINKED`).

**Gate review and exception.** When a versioned gate's `appealPolicy` allows it, the learner can ask staff to review the current decision (`POST /api/enrollments/:id/gates/:gateId/review-requests` with the decision ID and a reason, within the policy's window; one open request per gate). Staff with evidence review rights see open requests at `GET /api/admin/courses/:catalogId/gate-reviews` and decide them at `POST /api/admin/gate-reviews/:requestId`: `upheld` with a note the learner reads, or, for staff who may change enrollments, `exception`. An exception is a separate audited grant, not a gate decision: the decision keeps its status and open criteria, nothing becomes evidence, and the objectives are not counted as demonstrated. It lets the learner complete that episode (recorded with the grant on `episode_progress`) on the course and gate version it names, and it does not lift a reached course limit (`GATE_CAP_REACHED`). The learner never reviews their own request.

Versioned gates need independent success in the declared families, independent transfer on production work (recognition never counts) and no unresolved critical misconception; Core refuses recognition-only gates and gates that cannot collect transfer or misconception evidence at publish. Unversioned 0.4 gates keep their 0.4 pass rule. Prediction and trace items are graded deterministically (prediction honours relative tolerance and units), code repair uses the installed code evaluator, and counterexample, experiment-design and teach-back tasks go to quoted human review. "I don't know" is recorded without evidence or a failed result, and optional confidence is stored but never graded. A course retention policy without intervals uses 1, 3, 7 and 21 days.

A versioned gate may name a `conversationalRubricRef`, and an unversioned 0.4 gate a `conversationalEvaluatorId` that names a 0.5 evaluator definition bound to exactly one course rubric. The learner explains in their own words (`gate-conversation:<gateId>`) and a reviewer may ask neutral follow-up questions in the same thread. When the learner has opted in to AI drafts and a reviewer model is configured, the supervisor proposes quoted findings by itself for every turn, reading the earlier turns too (staff can also ask). The host verifier refuses any proposal whose "met" findings do not quote the learner's own words verbatim; a reviewer's question is not the learner's words. A verified proposal is still a draft. Evidence needs confirmation: a human reviewer who quotes the learner, or, for an evaluator declared `method: 'deterministic'`, the installed, integrity-matched adapter's `confirmConversationFindings`. Core records deterministic confirmation only as "met", and only when every finding the proposal marks met is confirmed and every required criterion is met. Otherwise it records why (`automaticCheck` in the review queue) and the answer waits for a person. A model impression without quotes therefore never produces evidence or a ready decision. Core refuses a conversational gate at publish unless its rubric requires cited evidence and its evaluator requires human confirmation or is deterministic with an installed confirmer. A 0.4 conversation counts as one item family, so its listed items must supply the remaining families (`PUBLISH_GATE_EVIDENCE_UNREACHABLE`). A `conversationalEvaluatorId` that names a bare extension has no rubric to cite and is still refused (`PUBLISH_CONVERSATIONAL_GATE_UNSUPPORTED`). SDK 0.5 lists no conversation item type, so a deterministic conversation evaluator declares one of the deterministic item types in `itemTypes` and binds the rubric through `rubricIds`. No deterministic confirmer ships with Core, and scripted models in tests show the host's checks, not any model's quality. An answer that reproduces a sentence of a companion reply is refused as agent-authored.

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
    `http://localhost:4318` in CI (a free local port, or `COURSE_BROWSER_PASSKEY_PORT`, elsewhere). Playwright has no virtual authenticator for WebKit or
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
A draft is never evidence or a grade; only a gate's deterministic evaluator (see
"Gates and assessment") may confirm one. See `services/api/RUBRIC_ASSIST.md`.

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

## External agent tools

A learner can connect an AI agent they use elsewhere (a desktop assistant, a coding agent, a script) to one enrollment from **My profile → Connected agents** (`POST /api/enrollments/:enrollmentId/agent-grants {label, scopes, expiresInDays}`; list with `GET`, revoke with `POST .../:grantId/revoke`). A grant names its scopes (`context`, `profile`, `evidence`, `history`, `propose_intervention`), expires after at most 90 days and can be revoked at any time; at most five are active per enrollment. The access key is shown once; Core stores only its SHA-256 digest. Staff, peers and the read-only learner view cannot create, list or revoke grants. Erasing the enrollment or the account revokes them, and so does removing the learner from the workspace (for good: adding them back does not revive an old key).

Agents call the tools with `Authorization: Bearer <key>` only, over plain HTTP (`POST /api/agent-tools/v1/tools/{get_context|get_profile|get_evidence|get_history|propose_intervention}` with the arguments as the JSON body) or a minimal MCP endpoint (`POST /api/agent-tools/mcp`: JSON-RPC 2.0 `initialize`, `ping`, `tools/list`, `tools/call`; JSON responses, no server-sent stream). Every call checks the key, revocation, expiry, the tool's scope, the learner's membership and the enrollment again; bad, revoked and expired keys get the same 401 and a missing scope 403. Limits per minute: 60 requests per grant and 120 per enrollment across all its grants, counting every request an authenticated agent makes (MCP `initialize`/`ping`/`tools/list`, notifications, unknown tools and failed calls included), reserved atomically before the call runs; 2 proposals per grant; and 30 failed authentications per client address, after which that address gets 429 without a database lookup. Arguments never choose the enrollment, workspace or user. Session cookies do not authorize these routes and the key authorizes nothing else.

Reads use the supervisor's minimal projection: no private notes, pending suggestions, answer keys, unissued items, staff notes, other learners, or evidence and messages the learner excluded from AI context. `propose_intervention` goes through the learner-model proposal port as a learner-agent principal: it creates one source-linked suggestion (pace, explanation style or an objective to review) that waits in the learner's own review queue, labelled "From your connected agent <label>" (the course's own AI suggestions are labelled separately), and never grants mastery or touches evidence, grading or progress; the grant is re-checked under the row lock revocation takes. A grant may hold at most 3 pending suggestions and all connected agents together 5; these never count against the course services' own 20, so an agent cannot crowd out the supervisor. A pending agent suggestion does not change the enrollment revision (it changes nothing a learner command or a companion answer's revision fence depends on, and provider context carries only reviewed suggestions), so it cannot make the learner's open commands stale or drop companion answers; the learner-model revision still records it. An agent cannot cite a question the learner excluded from AI context.

Reads stay available while the enrollment is paused, closed or completed: it is the learner's own record and they granted access to it. Proposals require an active enrollment. An erased enrollment answers nothing. The tools call no model provider and forward the key nowhere; it never appears in logs, errors, events, telemetry or the per-call audit (`agent_tool_calls`: grant, tool, outcome code, time), which the learner sees in their data export.

## Learner data export and erasure

A learner can download everything an enrollment recorded about them
(`GET /api/enrollments/:id/export`, format `course-core.enrollment-export` v1):
profile, attempts and evidence, companion conversations, learner model,
deadline/extension records, supervision summaries, the generated media staff
requested for them (`media`: title, objective, script, review text, captions and
attachment state; clips are listed by digest, not embedded) and events. Course content,
grading keys and other learners are excluded. Owners and admins can export on a
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
objective, the evidence reference (item, recorded result, course version) and its age, never the learner's
reason. Resolving (`POST .../evidence-disputes/:disputeId/resolve`, `accept` or `reject` with a note) is the
same evidence review as on the enrollment: `accept` upholds a result Core can acknowledge (independent,
unassisted, passing deterministic answers only) without changing it, and `reject` invalidates the evidence and
recomputes progress. Either one closes the dispute, is idempotent by key, refuses the learner's own dispute and
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
- The account then loses its name, sign-in identity, password, passkeys, sign-in codes, sessions (every device is signed out) and workspace memberships. Its id stays as an anonymous identifier so audit rows that name it remain valid.
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

Local modules are installed as symlinks (`install-links=false`, recorded as `link` entries in the consumer lock), so rebuilding a prerequisite such as `packages/policy` is immediately visible to its consumers' TypeScript, tests and runtime without reinstalling. Only the Expo/Metro web apps, marked `copiesLocal` in `scripts/modules.mjs`, keep npm's `install-links=true` copies so bundling and React resolution stay inside the app; `audit:public` rejects copied local entries or `install-links=true` anywhere else. A consumer with copied local packages is reinstalled during `check` (and by `install`) after its dependencies are rebuilt, so a stale copy in `node_modules` cannot mask a fresh-checkout failure; after changing `packages/visuals` outside the root commands, rerun `node scripts/orchestrate.mjs install <app>`. These installs use the existing lockfile and never rewrite child manifests or locks.

The root runs modules sequentially. A checkout lock rejects overlapping root commands, keeping app exports/builds and their browser suites in the same ordered operation. Separate CI matrix jobs use separate checkouts. Do not run an app's direct export/build, install, or preview command while a root check owns that checkout; commands outside the orchestrator cannot participate in its lock. After a crashed command, `node scripts/orchestrate.mjs unlock` removes a lock only if its owner process no longer exists.

CI uses Node 26, separate policy/provider/supervisor jobs, the sandbox unit/real-Docker job on hosted Linux, a disposable Postgres 17 API job with mandatory practical Docker qualification and connected learner browsers, learner/admin demo browser jobs with axe assertions, and the visuals package's browser suite. All required modules are checked: missing code, tests, manifests, lockfiles, release dependencies, images, or qualification entrypoints are failures. Public CI has no deployment/provider secrets, no private repository checkouts, no publishing permissions, and no native-mobile build steps.

## Integration and deployment gates

- **Released contracts:** consume the exact public SDK release asset in API metadata and keep its integrity locked. A pushed SDK commit is not a downloadable release artifact.
- **Server/UI adapters:** the connected learner path and disposable-database browser gate now exist. Continue backend/admin integration, broader workflow and reconciliation coverage, and deployed-environment acceptance. Local storage and demo receipts are not authorization or durable server evidence.
- **Provider execution:** configure authorized models and credentials server-side, verify live account capabilities, and integrate budget, moderation, retries, artifact storage, and job lifecycle with server policy. No live provider call is made by root CI.
- **Deployment:** the API/deployment owner maintains entrypoints, containers/compose, migrations, TLS/origin/cookie settings, secret delivery, backup/restore, observability, and production smoke tests. Root CI does not deploy or qualify these.
- **Accessibility and native:** automated axe checks and browser workflow tests cover their tested views. Human keyboard/screen-reader review and production CSP checks remain necessary; iOS/Android builds and device qualification are deferred.

See [CONTRIBUTING.md](CONTRIBUTING.md) for CI maintenance and [SECURITY.md](SECURITY.md) for reporting. Original repository code is licensed under [Apache-2.0](LICENSE); dependencies retain their own licenses.
