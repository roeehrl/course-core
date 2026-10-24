# Experimental releases

The platform remains under implementation. A release candidate proves its stated
source, CI and installed-package gates; it does not establish completed product
scope, live provider quality, deployment or production readiness.

Public source and the SDK are separate repositories. Course bundles, learner
records, provider keys, service credentials and operator state never enter public
release assets. Private courses consume the SDK and visual package through pinned
release URLs and retain independent domain-specific qualification.

## Candidate protocol

Commit and verify source first. Create an immutable-intent `vN.N.N` tag matching
the root version. Dispatch `release.yml` **from that tag**, supplying its complete
40-character commit SHA. The workflow has read-only permissions and performs no
tag creation, GitHub release, npm publication or deployment.

The identity gate compares the checkout, workflow ref/SHA, local tag, remote tag
object, repository and package version. Full CI runs from the same commit through
the reusable CI workflow. Preparation checks the live run/attempt and every
required completed job; a missing, skipped, failed or ambiguous gate blocks it.
An isolated snapshot of the immutable Git tree is audited and built with locked
public dependencies, disabled install hooks and a minimized environment.

Candidate assets:

- `course-core-source-N.N.N.tar.gz`: complete public source and license.
- `course-core-runtime-N.N.N.tar.gz`: public source plus compiled modules and both
  web exports, preserving the local dependency graph. Dependencies, databases,
  Temporal server and credentials are not included.
- Learner/admin web archives: public application exports, license and dependency
  attribution inventory. They need an authenticated API; they contain no course
  or learner data.
- `course-core-visuals-N.N.N.tgz`: standalone package with every advertised built
  export, CSS, license and released SDK dependency. It has no local dependency or
  install hook. An isolated HTTP tarball consumer runs headless, React SSR, export,
  CSS and TypeScript checks without reaching a sibling source tree.

The standalone visual component keeps its own version. A packaging-only core
release can therefore carry the same unchanged component without altering its
renderer identity or reassigning another component's qualification. The manifest
binds both versions and their exact bytes.

**Any change to the built visuals package requires a visuals version bump**, except
the pin of a reviewed type-only dependency. Courses declare `course-core-svg-v1` by exact
version and dist fingerprint, so changed code under an existing version breaks every
course built against it. `packages/visuals/released-digests.json` records, per released
version:

- the legacy fingerprint courses declare (`integrity`, which also hashes every
  dependency pin);
- from 0.1.1, the package identity (`identity`): every file under `dist` and the parsed
  manifest in key order, minus the pins of the release's `typeOnlyDependencies`.

`test/released-digests.test.ts` (run by the visuals and CI checks) fails in two cases:

- the current build's identity or files differ from the record for its version;
- the recorded legacy fingerprints cannot be re-derived from the current dist bytes with
  their recorded dependency basis.

To release a change, bump the version and record the new build with
`npm --prefix packages/visuals run digest`. Core v0.1.32 broke this rule (changed React
bytes shipped as 0.1.0); 0.1.1 is that build under its own version.

The SDK is the only type-only dependency. `src` imports it with `import type`, and the
identity refuses dist code that names it. Its pin moved from 0.2.0 to 0.5.0 this way:

- the dist is byte-identical;
- 0.1.1 keeps `sha256-d64441db…`;
- only the legacy value computed from the new manifest (`sha256-5adcdde7…`) moved, and
  the API never advertises it.

The identity also lints dist code against dynamic loading, builtins and unclean
specifiers. That lint supports review of the fixed recorded bytes; it is not a proof
about arbitrary code.

Already published courses keep the version they declared. The API's svg renderer treats
the installed build as a recorded release (`RECORDED_SVG_RELEASES`) only while it
reproduces that release's identity. It then advertises the recorded fingerprint and also
accepts that identity as an exact declaration of the same version. Any other build
advertises its strict identity and serves nothing else; a build the lint refuses is not
served. A prior build is accepted only from the reviewed list (`REVIEWED_PRIOR_SVG_BUILDS`
in `services/api/src/svg-renderer.ts`), as an exact version and integrity pair, and only
while the installed build is a recorded release reviewed to serve it unchanged on the
server (its `servedBy`). Check workers verify that the package on disk still has the
identity computed at startup before they answer.

Visuals 0.2.0 (clip, mask, symbol/use and equation nodes) changed the server-side runtime,
so it is the first release to serve prior builds without byte identity. It serves 0.1.0 and
0.1.1 declarations on reviewed behavioural parity (`packages/visuals/test/prior-parity.test.tsx`
pins the frames and markup the 0.1.1 build produced) and only with the 0.1.x render features
(`gradient`, `path_draw`): publication refuses a course declaring a 0.1.x build whose visuals
need a newer feature (`PUBLISH_RENDER_FEATURE_UNSUPPORTED`). Each reviewed prior build lists
its `features`; the runtime extension listing advertises them per accepted build.

Visuals 0.3.0 (springs, staggers, the four-layout set, synchronized panes, off-screen pause)
follows the same rule. It serves 0.1.x and 0.2.0 declarations, each limited to its own
build's features: 0.2.0 gets clip, mask, symbol, equation, gradient and path_draw. Its
basis is the 0.1.1 parity test and the unchanged 0.2.0 snapshots.

Visuals 0.4.0 adds scene checks enforced at publish (invariants and golden frame
digests) and authoring tools. It serves 0.1.x, 0.2.0 and 0.3.0 declarations, each limited to
its own build's features: a 0.3.0 declaration cannot carry invariants or goldens.

Visuals 0.5.0 adds image assets (embedded PNG, JPEG or WebP, verified against their
sha256), radial gradients, matrix and environment equations, path morph, colour tracks and a
camera, plus, in the React wrapper, export controls, device chrome in the preview, lazy
loading and disposal, completion as an observation and translatable messages. It serves
0.1.x to 0.4.0 declarations, each limited to its own build's features: a 0.4.0 declaration
gets 0.4.0's features and cannot use any 0.5 primitive. 0.4 scenes keep their frames and
golden digests.

Visuals 0.5.1 changes only the React wrapper: a lazy player observes the container it
scrolls in, so its preload margin works inside a scrolling lesson pane instead of only
around the viewport. Its headless code is byte-identical to 0.5.0, so it serves 0.5.0
declarations with all of their features, and 0.1.x to 0.4.0 declarations as before.

Visuals 0.5.2 moves every diagnostic into the error catalog: errors, check failures and
reference-check results carry a catalog key and parameters beside the same English message,
and the inspector shows them through `messages.describeError`, which the learner and admin
apps word in English and Hebrew. Its headless code is therefore not byte-identical to 0.5.0
or 0.5.1 (as 0.5.1's was to 0.5.0). It serves 0.5.0 and 0.5.1 declarations with all of their
features on behavioural parity instead: every frame, React markup and headless SVG of the demo
scenes, the 0.5 primitives included, equals the 0.5.1 build's (`test/v05-parity.test.tsx`).
Declaration-vs-installed checks use
`declarationMatchesInstalled` in `services/api/src/extension-identity.ts`, except
the inline check in `qualifiedCodeEvaluator`, whose source text is pinned by the
code-bank adapter digest (below).

**Any change to a built-in adaptation adapter's `implementationDigest` breaks
every approved registry that pins it.** Each built-in adapter's digest hashes the
compiled source text (`toString()`) of the adapter and of the functions it lists
in `services/api/src/adaptation-store.ts`, including helpers in other files such as
`qualifiedCodeEvaluator`. A comment or a behaviour-preserving refactor inside one
of those functions therefore moves the digest, and profiles pinned to the old one
stop resolving. `services/api/adapter-digests.json` records the expected digests;
`npm --prefix services/api run check:adapter-digests` (run by the API check and
CI after the build, and by `test/adapter-digests.test.ts`) compares them with the
built dist. Leave those function bodies byte-identical. Change a digest only for a
deliberate behaviour change, record it with
`node services/api/scripts/check-adapter-digests.mjs --update`, and state in the
release notes that approved registries using that adapter must be re-approved.
Core v0.1.33 broke this rule (the code-bank digest moved from `05d8ba24…` to
`c51bc8a5…` with no behaviour change); v0.1.34 restores `05d8ba24…`.
- `course-core-sbom-N.N.N.cdx.json`: a deterministic CycloneDX 1.5 SBOM of every
  package locked by every module (name, version, SHA-512, resolved source, declared
  license, which modules lock it and whether it is development-only) plus the
  Course Core modules themselves. It is derived only from the archived lock files
  and the release identity; verification regenerates it and requires identical
  bytes, so an edited inventory fails even with rewritten receipts. It describes
  what the locks resolve; it is not a vulnerability or license review.
- `release-manifest.json` and `SHA256SUMS`: exact commit/tree/tag/run/attempt,
  required job receipts, dependency lock hashes, every asset/member hash, the
  SBOM receipt (`sbom`, outside `assets`) and the compatibility matrix
  (`compatibility`, below). `SHA256SUMS` lists the five archives
  and the SBOM, so `sha256sum -c SHA256SUMS` needs all six files downloaded.

### Compatibility matrix and migration/rollback rehearsal

Before building candidates, the candidate job runs two checks on the tested commit
(`scripts/release-compat.mjs`). Both fail the release; neither is a new job.

- `check` builds the compatibility matrix of the candidate and of the previous
  release (the newest older `vX.Y.Z` with a published GitHub release; dead tags such
  as v0.1.51, whose release workflow failed, are skipped. The list comes from
  `gh release list`, or `COURSE_PUBLISHED_RELEASES`; without either the check fails
  instead of guessing from git tags): the SDK release every module pins and
  which compiled course packages Core accepts (the pinned SDK minor installs; an older
  minor of the same major installs with a warning; a newer minor or another major is
  refused, the same rule as the package preview), the Node engines of the root and every module,
  the PostgreSQL major CI tests and the migration set. It fails when the version did
  not increase, the SDK pin moved backwards, course packages built with the previous
  release's SDK would be refused, PostgreSQL went back, or a released migration was
  edited or removed. The candidate's matrix is recorded in `release-manifest.json`
  as `compatibility`; verification recomputes it from the archived source.
- `rehearse` uses a disposable PostgreSQL 17 service and its own schema. It applies
  the previous release's migrations (read from its tag), seeds synthetic users, a
  workspace, a release and an enrollment, takes a `pg_dump` backup, applies the
  candidate's migrations and requires every previous table, column and row count to
  survive (migrations are additive) and a re-run to be a no-op. It then rolls back
  the way an operator would, by restoring the backup, requires the schema and every
  row to equal the pre-upgrade snapshot exactly, and upgrades again.

### Adopting a new SDK release

The range of course packages Core accepts follows the SDK it pins
(`supportedSdkRange` in `services/api/src/course-package-routes.ts`): pinned to 0.5.x it
is `>=0.5.0 <0.6.0`, and pinning 0.6.x makes it `>=0.6.0 <0.7.0` with no code change.
Packages from an older minor at or above the minimum supported SDK (`MINIMUM_SUPPORTED_SDK`,
0.5.0, in `services/api/src/course-package.ts`) still install with a warning; below it they
are refused (`SDK_BELOW_MINIMUM`), and a newer minor is refused (`SDK_UNSUPPORTED`) until
Core pins it. Adopt a release only after it is tagged and its
tarball is published on the SDK's GitHub release; never pin an unreleased commit.

1. Move the four pins to the release tarball URL and refresh each lockfile with
   `npm install` in that module: `services/api`, `apps/learner`, `packages/adaptation`
   and `packages/visuals` (and `examples/courses` when its packs should use it). The
   visuals pin is a reviewed type-only dependency, so it keeps its released identity;
   `npm run check:visuals` proves it.
2. Check the new range: `node --test scripts/release-compat.test.mjs` and
   `services/api/test/course-packages.integration.test.ts` (a package from the next
   minor is refused, the pinned minor's patches are accepted).
3. For 0.6.0: replace the vendored `services/api/src/vendor/sdk-event-export` schema with
   the released `@course-core/sdk/event-export-schema` (see its README) and rerun
   `test/event-export.integration.test.ts`.
4. Run `services/api/test/sdk-support.integration.test.ts` (the pinned SDK and the gate
   rules over HTTP) and update the README's supported range. Raise `MINIMUM_SUPPORTED_SDK`
   (API and `scripts/release-compat.mjs`) only as a deliberate, documented break.
5. Move `repositories.sdk.commit` in `requirements-map.json` to the released tag's
   commit and run `node scripts/requirements-map.mjs`.
6. Courses can then move to the new SDK; packages they compile are refused by any Core
   still pinned to the older minor, so upgrade Core first.
  `scripts/tests/release-rehearsal.test.mjs` proves on small synthetic repositories
  that a dropped column, deleted rows, a failing migration and an edited released
  migration each fail it; it runs in the same step and may not skip.

Run them locally with a disposable database:

```sh
node scripts/release-compat.mjs check
TEST_DATABASE_URL=postgres://127.0.0.1:5432/course_core_test_<name> node scripts/release-compat.mjs rehearse --pg-bin /opt/homebrew/opt/postgresql@17/bin
```

The rehearsal applies migrations with `psql` in the same way as the API's
migration runner (name order, recorded digests); it does not start the previous
or the candidate runtime, and private acceptance against a real deployment stays
an owner step.

The candidate job then records a GitHub build provenance attestation (Sigstore,
`actions/attest-build-provenance`) for every candidate file, including the
manifest, `SHA256SUMS` and the SBOM. Only that job receives `id-token: write` and
`attestations: write`. Check a downloaded or published file with
`gh attestation verify <file> --repo roeehrl/course-core`; it proves which
workflow run built the bytes, not that the release was reviewed or deployed.

The attribution inventory preserves license declarations and distributed notice
files from installed dependencies, including build tools. It identifies packages
that distribute metadata only; it does not infer which tools were bundled or
replace a content/license review. Runtime installs must preserve dependency locks
and original third-party notices.

Missing third-party package metadata is accepted only through an explicit
version/file-hash review in `scripts/release-license-reviews.mjs`. Unknown versions,
absent files and changed license bytes fail. This does not relax the required
Apache-2.0 declaration for first-party modules. The currently reviewed unionfs
4.6.0 file matches its primary tagged source; its original notice is retained.

Before upload, verification rechecks live identity/CI and compares the source
archive to the actual immutable Git tree. Every asset, member, lock and exported
file is checked; unexpected files, source maps, private paths, links, tar overrides
and traversal fail. Upload produces an immutable Actions artifact ID and digest.
A generation failure retains an explicit `FAILED` marker and cannot verify.

Every tracked path must also be a release input: a reviewed source path with no
private or operational name component (`private`, `secret(s)`, `credential(s)`,
`log(s)` and similar). Public CI runs the release build's own check
(`node scripts/release-artifacts.mjs check-inputs`) over the tracked files at HEAD,
so a pull request that adds such a name fails before it can reach a tag.

**v0.1.36 is an unreleased, dead tag.** It points at `2100d1d` (password login and
adapted-course caching). Its release run (38555505450) refused to assemble
candidates because `services/api/src/secret-input.ts` matched the private-name
rule, which Public CI did not check then. Tags are immutable, so it was neither
moved nor retried: the file is now `password-input.ts`, CI runs the check, and
that work ships in 0.1.37 together with passkey sign-in. Do not build or install
from v0.1.36.

## Upgrade notes

Notes for operators and workspace owners, newest first. They describe what changes for a
running deployment; the candidate's own manifest remains the record of what was built.

### Next release: SDK 0.4 courses are no longer supported

Core is not in production, so it keeps no backward compatibility with SDK 0.4 courses
where that compatibility weakened the false-mastery rules:

- **Minimum SDK 0.5.0.** A course package compiled with an SDK older than 0.5.0 is a
  blocking problem, `SDK_BELOW_MINIMUM`: nothing installs, and automatic updates install
  nothing either. A draft already recorded as built with such an SDK is refused at
  publication (`PUBLISH_SDK_BELOW_MINIMUM`). The supported range itself is unchanged
  (`>=0.5.0 <0.6.0` while Core pins 0.5.x); when Core pins 0.6, 0.5 packages install with
  the usual older-SDK warning and anything below 0.5.0 stays refused.
- **Full rules for every gate.** A gate without a version (the family-count shape,
  `minimumIndependentFamilies`) gets the same rules as a versioned one. Publication refuses
  one whose items are all multiple choice (`PUBLISH_RECOGNITION_ONLY_GATE`) and one that
  passes on one of several objectives (`requireAllObjectives: false`,
  `PUBLISH_GATE_PARTIAL_OBJECTIVES`). Every objective needs independent success in the
  required families including a produced answer (or a confirmed conversation), and an open
  declared critical misconception blocks the gate. The release warning
  `LEGACY_RECOGNITION_ONLY_GATES` is gone: such a course is no longer publishable, and the
  release page names the checkpoint to fix (`GATE_RECOGNITION_ONLY`,
  `GATE_PARTIAL_OBJECTIVES`, `GATE_TRANSFER_MISSING`, `GATE_MISCONCEPTION_CHECK_MISSING`,
  `GATE_EVIDENCE_UNREACHABLE`).
- **Example courses.** The Spanish greetings (1.2.0) and plant journal (1.1.0) packs had
  checkpoints of choice items only; each now has one family where the learner types or
  calculates the answer. The SDK 0.4 digest pins and the 0.4 compatibility test were
  removed (`services/api/test/sdk-support.integration.test.ts` replaces it).

What to do: rebuild any course still compiled with SDK 0.4 with SDK 0.5, give every
checkpoint at least one task beyond choosing among given answers, and make each checkpoint
require all of its objectives (or split it). Releases already published keep their
learners' records, but a course that breaks these rules can no longer be published or
picked as the target of a version move.

### Next release: course packages from a newer SDK are refused

A course package compiled with a newer SDK minor than the one Core pins (for example SDK
0.6.0 on a Core pinned to 0.5) used to install with the warning `SDK_NEWER_THAN_CORE`. Its
bundle could use contracts this Core cannot check, so it is now a blocking problem,
`SDK_UNSUPPORTED`: upgrade Core first, then install the course. Packages from the pinned
minor or an older one install as before.

### Next release (after 0.1.50): every agent role is checked before a change

0.1.50 checked only the companion and the supervisor's plan strategy before activation;
the supervisor's tool loop, research and reviewer were turned on without a check. From
this release Core's public eval suite covers every role, and the suite itself changed
(new conversations), so earlier passes and owner approvals were for older checks.

- Nothing is turned off. The gate applies only when a role's model, limits, adapter or
  prompt changes; there is no runtime gate. Roles that are on keep serving learners.
- Saving an unrelated change (a key, a price, a budget, the job policy or another role)
  works as before: a role whose revision is unchanged never needs new evidence.
- Changing a role's model or binding now needs a passing quality check or an owner's
  approval for that role; the save is refused with `409 PROVIDER_EVAL_REQUIRED` naming
  only the changed roles.
- The admin **AI services** page lists, under Quality check, every job that is on but
  has no passing check or approval for the current checks (status `stale`,
  `not_evaluated`, `not_covered` or `failed`). It says they keep working, offers
  **Run quality check** for the active setup (with its cost estimate; it uses the
  workspace's key and budget, like a draft's check), and lets an owner approve those
  exact active revisions without a check, with a reason that is audited.
- What to do after upgrading: open AI services, check the prices and spending limit,
  and run the quality check for the jobs that are on, or have an owner approve them.
  Until then the jobs keep working, but their model cannot be changed.
- Migration 104 lets a quality check target the active setup (additive: `draft_id` is
  nullable and a `target` column records `draft` or `active`).

## Publication and consumption

Publication is a separate operation. Download candidates from the exact successful
run/attempt and immutable artifact ID; verify the upload digest and manifest,
recheck the remote tag and complete the release/license review. Publish the same
bytes without rebuilding them, including the SBOM. Preserve the candidate run and asset hashes in
the release notes, and verify hosted assets after upload. Never rename a different
build as a qualified artifact or overwrite an existing release asset.

The npm registry is not used for publication yet. A consumer installs the visual
package with its explicit GitHub release tarball URL, retains the lock integrity,
and reruns its own course math/fixture/visual verification. A passing renderer
does not certify a lesson's equations or answer keys.

## Local verification

`npm run test:infra` runs archive, provenance, corruption and dependency-graph
negative controls. Importing the release tool has no side effects. Candidate
generation outside the controlled workflow fails closed. The exported
`qualifyInstalledVisuals` function can qualify a component from an immutable
local public commit; its result explicitly has **no release authority**.

CI uses the Chromium version paired with each locked Playwright installation.
Generated npm caches/logs remain ignored operational data and are not release inputs.
Direct local browser tests use installed Chrome. Other engines and physical-device
acceptance remain separate gates; a phone viewport alone is not an iOS binary test.
