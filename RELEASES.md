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

**Any change to what the built visuals package executes requires a visuals version
bump.** Courses declare `course-core-svg-v1` by exact version and dist fingerprint, so
changed code under an existing version breaks every course built against it.
`packages/visuals/released-digests.json` records, per released version, the legacy
fingerprint courses declare (`integrity`, which also hashes every dependency pin) and
the executed identity (`executed`: each runtime dist file, the pins of the packages
those files import at run time, and the manifest loading fields such as `exports`).
`test/released-digests.test.ts` (run by the visuals and CI checks) fails when the
current build's executed identity differs from the record for its version, or when the
recorded legacy fingerprints cannot be re-derived from the current dist bytes with
their recorded dependency basis. Bump the version and record the new build with
`npm --prefix packages/visuals run digest`. Core v0.1.32 broke this rule (changed
React bytes shipped as 0.1.0); 0.1.1 is that build under its own version.

A pin of a package no dist file imports does not change the executed identity and
needs no bump. The SDK pin moved from 0.2.0 to 0.5.0 this way: the dist is
byte-identical, 0.1.1 keeps `sha256-d64441db…`, and only the legacy fingerprint
computed from the new manifest (`sha256-5adcdde7…`) moved, which the API never
advertises. A pin of an imported package (`zod`, the `react` peer range) does change
it.

Already published courses keep the version they declared. The API's svg renderer
advertises a release's recorded fingerprint only while the installed build reproduces
that release's executed identity (`RECORDED_SVG_RELEASES`), and also accepts the
installed executed identity as an exact declaration of the same version. Any other
build advertises its own executed identity. It accepts a prior build only from its
reviewed list (`REVIEWED_PRIOR_SVG_BUILDS` in `services/api/src/svg-renderer.ts`), as
an exact version and integrity pair, and only while the installed server-side headless
runtime has the same executed identity as the one that prior build shipped.
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
- `release-manifest.json` and `SHA256SUMS`: exact commit/tree/tag/run/attempt,
  required job receipts, dependency lock hashes and every asset/member hash.

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
bytes without rebuilding them. Preserve the candidate run and asset hashes in
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
