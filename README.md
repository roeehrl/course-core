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
