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
  required job receipts, dependency lock hashes, every asset/member hash and the
  SBOM receipt (`sbom`, outside `assets`). `SHA256SUMS` lists the five archives
  and the SBOM, so `sha256sum -c SHA256SUMS` needs all six files downloaded.

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
