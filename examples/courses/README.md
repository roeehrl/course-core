# Everyday course packs

Four complete, unrelated, standalone courses for the generic Course Core player. These are teaching packs with original lessons and assessment banks, not reduced schema fixtures. Each JSON file can be imported as a `CourseManifest` through the existing course-release API.

| Pack | Learning purpose | Episodes | Items | Enrollment window |
| --- | --- | ---: | ---: | ---: |
| [Walking the number line](packs/number-line.json) | Read positions, calculate directed moves, distinguish distance and total travel | 3 | 24 | 14 calendar days |
| [A first conversation in Spanish](packs/spanish-greetings.json) | Greet, exchange names, thank and part in short written exchanges, then write your side of a reviewed role-play | 4 | 32 | 21 calendar days |
| [A plant observation notebook](packs/plant-journal.json) | Record observations, use comparable measurements and keep conclusions within evidence | 3 | 24 | 28 calendar days |
| [Searching a sorted shelf: an algorithms lab](packs/search-lab.json) | Count comparisons in a linear scan, trace binary search, write and test small Python search functions | 3 | 24 | 21 calendar days |

The packs contain 13 objectives, 13 gates, 104 items and 4,457 lesson words. The Spanish course uses English instructions and Spanish phrases; it does not score pronunciation or promise fluency. The plant course includes supplied records so a real plant, photograph, notebook upload or waiting period is not required. Optional personal observation practice is clearly separated from the graded examples.

The number-line and plant packs use only text, numeric and single-choice blocks. The other two exercise the rest of what Core runs without any course-specific code:

- **Algorithms lab** (`search-lab`): two interactive pictures drawn by Core's SVG renderer (`course-core-svg-v1`, each with a full text description and no required motion), a practice activity on Core's declarative activity runtime (a number field and a choice; it has no evaluator, so it is never evidence), and four Python code tasks graded in Core's Docker sandbox against hidden cases. The hidden cases are a data-only fixture registry shipped beside the pack, [`packs/search-lab.code-fixtures.json`](packs/search-lab.code-fixtures.json); the pack declares its SHA-256, and a host installs it with `CODE_FIXTURE_FILES` exactly as for any course. The grader checks results, not speed; efficiency is assessed by the tracing questions.
- **Spanish role-play** (episode 4, pack version 1.1.0): the learner writes three to six lines for a stated setting. Each role-play is a rubric item on Core's reviewed-rubric protocol (`course-core-reviewed-rubric`): a teacher or course reviewer decides it and must quote the learner's own words for every criterion marked as met. Nothing marks it automatically and no provider is called.

There are no media players, third-party extensions, provider calls or native application requirements. The current course platform declaration is web. Content remains ordinary Markdown/JSON, including text alternatives for the number-line reasoning and the lab pictures.

## Policies and fresh evidence

Each pack declares its own bounded policy. The window begins on explicit enrollment, uses UTC calendar days, does not pause, and leaves existing material read-only after closure. Discretionary extensions are disabled in these sample policies. These are editable authoring examples, not globally imposed defaults or timed quizzes.

Every episode has one objective and two distinct item families. A gate requires independent success in both. There are four variants in each family, interleaved in the gate bank: family A item 1, family B item 1, A2, B2, and so on. This ordering works with the runtime's first-unseen-item selection and provides fresh attempts after a wrong answer or a solution reveal. Only the first two assessment blocks are shown in authored content; the full gate bank supplies retry alternatives through the challenge API.

The families test different capabilities: reading a scale versus applying order; computing a movement versus explaining its inverse; phrase meaning versus conversational response; direct observation versus recording quality; arithmetic comparisons versus method or inference decisions. Variants within a family do not count as additional independent families.

The bank is finite. A corrected repeat stays practice/ineligible, and help does not become independent evidence simply because the later answer is correct. After all four variants in a still-needed family are exposed, this pack has no fresh item for that family. The current automatic selector may offer remaining unseen items from the other family before reporting that the whole bank is exhausted; those items cannot replace the missing family. These packs do not claim unlimited remediation, retained mastery, spoken-language ability or completion of a real observation journal. Worked examples and feedback can help learning; an item-level exposure flag alone is not proof of unaided understanding.

## Validate and test

This directory has its own package and lockfile and uses the published **SDK 0.5.0 release asset** (the packs were authored and first accepted with 0.1.0). It does not import a sibling SDK source checkout. No root package or API/core test needs to be edited.

```sh
cd examples/courses
npm ci --ignore-scripts --workspaces=false
npm run validate
npm test
```

`validate` compiles all four actual packs, checks the supported content types, substantive lessons, explicit policies, reference coverage, two families with four variants each, interleaving, correct/wrong grading behavior, fresh-evidence recovery and the learner projection. It prints digests and counts without writing a generated course or changing an existing release.

The tests also independently recalculate all 28 numeric item keys (the lab's by simulating the scans and searches each prompt describes), recompute every hidden code case with separate reference implementations and check the fixture file against the pack's declared integrity, check that a good sample role-play can be quoted for every required criterion and a weak one cannot, confirm that no pack, episode, activity or fixture-registry ID appears anywhere in Core's runtime sources, reject invalid authoring variants and scan these example sources and their dependency lock with the repository's existing public-source policy. Choice prompts, answer keys and distractors were manually reviewed for a single intended answer under their stated contexts. This is an author review, not psychometric or broad educational-efficacy validation.

When adopting a later released SDK, change the exact public release dependency and refresh this directory's lockfile, then rerun these commands and the real protocol proof. The first recorded acceptance below used 0.1.0. After moving to 0.5.0, `validate`, the tests and `proof:local` passed again, and the compiled pack digests did not change. The Spanish pack then became version 1.1.0 with the role-play episode, so its digest changed; the number-line and plant digests are still the ones SDK 0.4.0 produced (`services/api/test/sdk-compat.integration.test.ts` pins them). This does not assert that an unreleased or untested version was qualified.

## Import and play

Use an authenticated author/owner session to send the **contents of one pack JSON**, without a wrapper, to:

```text
POST /api/workspaces/:workspaceId/releases
```

Publish its returned release ID using an owner/admin session:

```text
POST /api/releases/:releaseId/publish
```

The connected learner catalog can then display the published title, summary and policy. The learner explicitly starts it with `POST /api/enrollments` and the returned `releaseId`, or uses the existing learner UI's Start course action. No special course-ID branch or custom evaluator is needed. Real HTTP acceptance below used these import and publish routes; it did not insert precompiled releases or fabricated completion rows directly into storage.

These public authoring manifests deliberately contain their assessment keys for review and reuse. They are not confidential exam banks. The runtime privacy tests establish that ordinary learner API responses do not expose grading structures or the entire item bank; they cannot make answers already published in this repository secret. Serve the SDK learner projection and authorized challenges, not the raw authoring JSON as an enrollment bootstrap.

## Protocol scenario against a supplied test host

The script uses the current HTTP protocol and existing authentication. Supply these environment values from disposable test sessions; do not store them in the repository or paste them into reports:

- `EXAMPLE_COURSES_BASE_URL`: API origin, without a path.
- `EXAMPLE_COURSES_WORKSPACE_ID`: an isolated test workspace.
- `EXAMPLE_COURSES_OWNER_COOKIE` and `EXAMPLE_COURSES_OWNER_CSRF`: an owner session for import/publication.
- `EXAMPLE_COURSES_LEARNER_COOKIE` and `EXAMPLE_COURSES_LEARNER_CSRF`: a fresh learner in the same workspace.
- Optional `EXAMPLE_COURSES_ORIGIN`: the server's configured origin if different from the base URL origin.

```sh
npm run scenario
```

This command imports/publishes the packs and creates/uses enrollments in that supplied test workspace. It reuses a matching existing release only if the digest agrees, and requires a fresh learner so an old completed enrollment cannot create a false pass. It does not silently alter an existing version with different content. The external test host should have paid/provider services disabled. The scenario itself issues no provider, companion, media or generation requests.

For each course the scenario:

1. Imports, publishes and sees the actual pack in the learner catalog; an unpublished release stays hidden.
2. Checks anonymous denial, learner-role denial of authoring, and idempotent enrollment creation.
3. Reads lesson blocks and verifies that missing evidence blocks completion and keeps the next lesson locked.
4. Answers the first question incorrectly in every episode, then corrects an explicitly repeated item and confirms it remains ineligible for independent credit.
5. Requests a solution in the first episode of each course and confirms the helped correct answer is not independent.
6. Uses automatically selected, previously unseen items to earn both required families, completes the episode and refreshes the saved state.
7. Completes every episode and verifies final completion without changing course-specific server code.

Where a pack has them, it also views every picture, launches each activity, saves its state, submits it, checks that an undeclared capability is denied and that the observation is not evidence, submits code tasks for sandbox grading, and has a reviewer decide each role-play with quotes from the learner's lines (the owner session reviews unless a separate reviewer session is supplied). Against an external host, that host must install the same extensions and the lab's fixture registry.

Catalog/bootstrap/refresh assertions reject grading keys and unissued prompts. An active authorized challenge may return its own prompt/options; a requested solution or submitted answer may return that item's feedback. Those disclosures are explicitly distinguished from an unissued bank leak.

## Real local proof with PostgreSQL

The optional host harness imports the **existing built** API modules and runs this same scenario over actual loopback HTTP with real PostgreSQL 17. It lives entirely in this examples directory; no API route, test or root configuration is patched. Build/install the API using the repository's normal workflow first. The harness does not build it itself or fall back to mocks.

Use an already-present `postgres:17` image to create a separately owned ephemeral database:

```sh
npm run proof:local -- --docker
```

The container receives a unique name, a loopback-only dynamic port and documented disposable database values. It never pulls an image or stops an existing service. Database storage is temporary, and cleanup removes only the created container and its volumes. The harness waits for TCP readiness rather than the initialization socket. It creates a unique database schema, applies the existing migrations there, seeds synthetic owner/learner accounts, signs in through the normal authentication endpoint, starts the API on an unused loopback port and drops only its own schema on exit. No provider or supervisor service is started.

Alternatively, supply `TEST_DATABASE_URL` for an already-running disposable PostgreSQL 17 database and run:

```sh
npm run proof:local
```

The API is started with the same extensions its own entry point installs (the SVG renderer, the reviewed-rubric protocol and the declarative activity runtime) plus each pack's code fixture registry, the way `CODE_FIXTURE_FILES` installs it. Code tasks need Docker and the qualified sandbox image (`npm run sandbox:pull` from the repository root); without them the proof fails instead of skipping the tasks. Sandbox scratch files go under `examples/courses/.local/` (ignored by git) because Docker Desktop cannot clean up bind mounts in the macOS temporary folder. Role-plays are submitted by the learner and decided by a separate instructor account, which quotes the sample lines; the learner cannot review their own work. After the scenario, every code task's reference program must pass all of its hidden cases in the sandbox and its known-wrong program must fail.

The URL must be loopback and name `course_core_ci` or `course_core_test` with an optional test suffix. An ambient `DATABASE_URL` is rejected. The script never migrates or connects to a chosen application database by fallback. Missing prerequisites fail this proof; they do not produce a skipped passing result.

The local harness also creates a second learner and verifies that they cannot access the tested learner's enrollment. Neither cookies, CSRF values, login codes nor raw learner answers are printed. The resulting report contains course-level test outcomes only.

## Generality gate

`npm run gate` runs `validate`, the tests and `proof:local` in one command. Public CI runs the same gate on every pull request and release candidate: the `Module / example-courses` job runs `validate` and the tests, and the step "Run every public course pack through unchanged Core" in the API job runs `proof:local` against the Core built from the same commit, with real PostgreSQL 17 and the Docker sandbox. No Core source is edited or configured per course; the tests fail if a course ID ever appears in Core's runtime sources.

The design also names a third, private course (the owner's LLM course). Public CI never fetches it. Its owner runs the same gate on their own machine, pointing at a manifest kept outside this repository:

```sh
TEST_DATABASE_URL=postgres://127.0.0.1/course_core_test_private npm run proof:local -- --private-pack /path/outside/repo/course.json [--code-fixtures /path/outside/repo/fixtures.json]
```

After the public packs pass, the private pack is imported, published and enrolled on the same host composition, and its learner view is checked for grading data and unissued prompts. The report holds only its ID, version and pass flags. Paths inside this repository are refused. A private course that needs more than this host installs (for example provider-backed tutoring or teaching verifiers) also needs those host files; its item-by-item acceptance stays with its owner.

## Recorded acceptance and limits

On **2026-10-21**, the four-pack gate passed locally with real PostgreSQL 17 and Docker: 13 episodes completed, each with a wrong first answer and a corrected repeat kept non-independent; in the lab, three code submissions ran in the sandbox (a wrong program rejected, its corrected repeat non-independent, a fresh task independent), the activity was launched, saved and submitted with an undeclared `network.fetch` request denied, and both pictures were delivered and counted as viewed; in Spanish, three role-plays were reviewed by an instructor (one not met, a corrected repeat, one fresh and independent) and the learner's attempt to review their own role-play was refused. All four code tasks then passed with their reference programs and failed with their known-wrong programs.

On **2026-10-12**, all three packs completed the real HTTP/PostgreSQL scenario: 9 episodes, 9 deliberately wrong first answers, 9 corrected repeats kept non-independent, 3 solution-assisted answers kept non-independent and 18 successful independent checks. All nine gates recovered through fresh variants. Refresh/resume, anonymous denial, cross-learner denial and answer-bank privacy assertions passed. The ordinary validation and six source/content/privacy tests also passed.

This proves these unrelated packs are runnable through the tested generic API/evidence/policy path. It is not a browser-rendering/accessibility audit, production deployment, native-app acceptance, provider integration test or proof of learning outcomes. The connected UI can consume the same protocol, but no browser interaction is claimed as tested by this scenario. The sample role-plays and their reviews are scripted test data, not a judgement of real learners' Spanish.

## Public sources and authorship

The lesson explanations, example dialogues, observation records and questions are original. Elementary arithmetic is independently checked by the content tests. Reviewed references, dated **2026-10-12**, are recorded in the relevant manifests:

- [Instituto Cervantes A1–A2 communicative functions](https://cvc.cervantes.es/ensenanza/biblioteca_ele/plan_curricular/niveles/05_funciones_inventario_a1-a2.htm): conventional greetings, name exchanges and courtesy functions. The course is a narrow selection, not an A1 qualification; address forms and time-of-day boundaries are contextual rather than universal rules.
- [Instituto Cervantes conversational routines](https://cvc.cervantes.es/ensenanza/biblioteca_ele/diccio_ele/diccionario/rutinaconversacional.htm): greeting/response purposes. Original dialogues are used; no pronunciation resource is required.
- [National Park Service plant-observation guidance](https://www.nps.gov/teachers/classrooms/plant-adaptations.htm): direct observation, counting and measurement. The supplied journal data are invented for learning, and no diagnosis, species identification or plant-care prescription is made.

No source image or substantial external passage is bundled. Repository licensing covers the original example artifacts; linking an external reference does not assert rights to redistribute that external resource.

## Clean-room author proof

[`src/clean-room-lab.mjs`](src/clean-room-lab.mjs) is a fourth, small course written the way an outside author would write one: it imports only the released SDK (`@course-core/sdk` from the release asset this directory's lockfile pins) and uses only what the SDK documents and what a Course Core host advertises at `GET /api/runtime/extensions`. It adds, without any Core change:

- a custom **activity**: a thermometer-reading lab on Core's declarative runtime (number, choice and toggle controls);
- an **evaluator**: an SDK evaluator definition using Core's built-in data-only checker (`course-core-declarative-evaluator`), keyed by two ordinary server-only items named `<activityId>.<controlId>`;
- an **admin setting**: a section with the evaluator definition's id and a boolean `show-mismatched-controls`, which staff can turn on per course, chapter or enrollment to make results name the values that were off. It never changes a verdict.

`npm test` checks that the source imports nothing but the SDK, that the SDK comes from the public release asset, and that the learner projection carries no key, evaluator wiring or admin setting. With a disposable PostgreSQL 17 database:

```sh
TEST_DATABASE_URL=postgres://…/course_core_test_<suffix> npm run proof:clean-room
```

This starts the built production entry point (`services/api/dist/main.js`, with the same installed extensions as a deployment) on loopback in a fresh schema and, over HTTP only: reads the advertised builds; shows that publishing without the key items is refused (`PUBLISH_EVALUATOR_CONFIGURATION_INVALID`, `key_item_missing`); imports and publishes the lab; runs it as a learner, checking that no key reaches the learner; has a learner fail to read or change the admin section; has the owner turn the setting on for that enrollment; and checks that the next wrong reading names the control while a right one passes and satisfies the block. It then confirms the setting change was audited, stops Core and drops its schema. Build the API first; the required API CI job runs this after the pack proof.

What this does not show: evaluators that judge code or prose still need a host-installed, trusted evaluator (see the root README, "Activity runtime"), and a `sandboxed_web` activity needs its script installed on the host.

