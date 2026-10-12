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
- `release-manifest.json` and `SHA256SUMS`: exact commit/tree/tag/run/attempt,
  required job receipts, dependency lock hashes and every asset/member hash.

The attribution inventory preserves license declarations and distributed notice
files from installed dependencies, including build tools. It identifies packages
that distribute metadata only; it does not infer which tools were bundled or
replace a content/license review. Runtime installs must preserve dependency locks
and original third-party notices.

Before upload, verification rechecks live identity/CI and compares the source
archive to the actual immutable Git tree. Every asset, member, lock and exported
file is checked; unexpected files, source maps, private paths, links, tar overrides
and traversal fail. Upload produces an immutable Actions artifact ID and digest.
A generation failure retains an explicit `FAILED` marker and cannot verify.

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
