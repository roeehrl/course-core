# Verified adaptation domain

Private standalone TypeScript/ESM package for Course Core, Node 26. It imports
`@course-core/sdk` **0.5.0** from the published GitHub release URL in `package.json`;
`package-lock.json` pins its SHA-512 integrity. See the root README for the
supported SDK range.
SDK sources are not imported from a sibling checkout. `@course-core/policy` is a
package dependency using its built public exports. `.npmrc` sets `install-links=false`,
so `node_modules/@course-core/policy` is a symlink to `../policy` (the lock records it
as a `link` entry). After a policy change, rebuild policy (`npm run build` there) and
this package's TypeScript and tests see the new `dist` immediately; no `npm ci` is
needed. Installing this package does not build/edit the policy package, so build
policy first when bootstrapping a fresh repository.

```sh
npm ci --workspaces=false --ignore-scripts --no-audit --no-fund
npm run check
npm test
npm run test:packed
```

No database, provider calls, credentials, filesystem access, wall-clock reads,
random IDs or dynamic code execution occur in the domain implementation. Hashing
uses the SDK and policy packages. Inputs contain authoritative time, identifiers,
state and trusted registry snapshots. Calls return detached successor snapshots;
they do not persist or publish anything themselves. Failures throw `AdaptationError`
or the policy package's `PolicyError`, with stable `code` values. SDK failures are
reported using their issue codes without echoing content or grading into errors.

## Inputs and trust boundary

`RuntimeContext` contains the immutable validated `course`, complete `policy`
ledger, read-only `EvidenceFence`, and a `TrustedRegistry`. The registry is loaded
by the host from authenticated server records, never from a model/browser request:

- Registered verifier IDs, versions, implementation digests, permitted kinds,
  source references and checks must match the author declarations in the SDK.
- Every proposed proof must exactly match an active stored `TrustedProof`,
  including the exact proposal/artifact digests, sources, check results, timestamp,
  verifier implementation and receipt reference. Its record binds the enrollment
  and immutable base. A syntactically valid model-created receipt alone is rejected.
- `TrustedAuthorization` binds an exact proposal digest, the SHA-256 of the entire
  `ActivityAssignmentDecision[]`, the evidence revision/digest and validity window.
  Each decision references this record's `receiptRef`. Changing classification or
  zeroing cost after approval is rejected. Issuer authentication and revocation
  policy are host responsibilities; an `authenticationRef` string is not a signature.
- Stable episode-to-policy-scope and objective-to-concept mappings are frozen by
  the initial adaptation state. Renaming work, changing a personal plan revision,
  or remapping a concept cannot refill counters. Binding migration is deliberately
  unsupported; do not recreate a state to bypass the restriction.
- Existing reservations named by `protectedReservationIds` preserve headroom for
  remaining core teaching and final assessment. All existing reservations already
  count in the policy ledger. The host must estimate and reserve this work before
  adding enrichment; this package cannot infer its cost or completeness from prose.

The proposal and the trusted registry are **separate inputs**. Passing a model's
entire object as the registry would violate the API's trust boundary. This package
matches authenticated records; it does not implement signature verification or an
authentication service. The same restriction applies to course approval and scopes.

## Lifecycle and effects

1. `createAdaptationState(context)` initializes a **new** enrollment's plan at
   revision zero. Persist it once under a unique enrollment constraint. Existing
   adaptation reservations prevent reinitialization, but uniqueness must also
   protect profiles-only histories. Reload retained state for all subsequent work.
2. Construct an SDK `CourseAdaptation` against `state.plan`. Its base digest never
   changes. The SDK validates operations, target content, canonical families,
   objectives, generator/verifier/source declarations, recipe output, artifact
   digests, size limits and author constraints.
3. `previewAdaptation(context, state, command)` runs admission checks and exposes
   prospective reservations and commit fences without changing inputs. A preview
   is not a reservation and cannot be persisted instead of running admission.
4. `admitAdaptation` checks the authenticated records and reserves work via policy.
   When the enrollment holds live core headroom, required (core-path) work gets its own
   reservation funded from that headroom (minutes and episodes; remediation cycles stay on
   the work and keep their caps), so it never counts as a personal extra. Optional work, or
   core work the remaining headroom cannot cover, is ordinary enrichment.
   Persist its adaptation state, policy state, receipt and outbox entries atomically.
5. `applyAdaptation` repeats SDK validation against the current plan and registry,
   checks evidence, authorization, current time/policy and exact reservation costs,
   then commits reservations and appends one plan revision. Revoked proofs, changed
   evidence, expired authorization, late jobs and stale plans cannot publish.
6. `cancelAdaptation` releases only unused reservations and retains drafts/history.
   It can clean up after policy expiry/revision. Assigned work cannot be cancelled
   or refunded. A policy closure that already cancelled reservations is respected.
8. `revertAdaptation` undoes an applied change as a new plan revision whose rollback
   target is the plan the change was applied on. History, receipts, occupied ids and
   committed work stay (undo never refunds use or frees an id), evidence is untouched,
   and replaced blocks return to their previous live version. It refuses assessment
   variants and a change that a later live change rewrites; revert those newest first.

```ts
import { admitAdaptation, applyAdaptation } from '@course-core/adaptation';

// Inside the parent's transaction, using host-authenticated snapshots:
const admitted = await admitAdaptation(context, state, {
  ...commandFence, admissionId, authorizationRef, proposal, assignments,
});
// Compare/lock admitted.preconditions and persist ALL returned state/effects.
// Later, reload every snapshot and construct a fresh command fence:
const applied = await applyAdaptation(freshContext, freshState, {
  ...freshCommandFence, admissionId,
});
```

`Command` supplies `now`, an idempotency key, and expected adaptation-ledger,
policy, policy-ledger, registry and evidence revisions. The proposal separately
fences the plan revision/digest. A reserve/cancel changes the adaptation ledger but
not the plan revision. Every transition includes `preconditions`, `state`, `policy`,
`receipt`, `replayed`, and an outbox containing references only. `evidenceWrites`
and `creditWrites` are always empty. Applying verified teaching grants no mastery,
credit, completion, consent, extension or profile correction.

Required **and optional** generated work, including replacements, use the same
policy counters. Costs sum by mapped scope; each intervention charges one remediation
cycle per affected stable concept in each scope. Multiple operations for the same
concept/scope in one proposal count as one intervention; different scopes can charge
the same ancestor more than once. Historical committed costs are never subtracted
when content is replaced. Parent deadlines and every applicable quota still bind.
Generation/provider/job spending needs its own admission and resource limits in the
parent pipeline; teaching reservations do not authorize arbitrary external compute.

## Plan materialization and evidence

`materializeAdaptation(context, state)` derives server and learner delivery views
from the immutable base plus applied revisions. It supports appending explanation
or practice, replacing only author-permitted existing **text** blocks, attaching
reviewed media/visuals, and adding assessment variants. It never deletes/reclassifies
base episodes, objectives or assessment/gate standards. Original content remains in
the base; all prior artifacts remain in the journal. Profile changes remain suggestions.

The derived `server` view is not a new immutable course release. Continue using its
separate `baseCourseDigest`, `planRevision` and `planDigest` for delivery. Replacements
bind the current artifact digest. Variant counts and occupied IDs accumulate across
applied revisions. Byte-equivalent pending or applied question content under a new
ID is rejected; semantic equivalence under paraphrase still needs trusted content
verification. Unused cancelled drafts may be proposed again under new admission and
proposal IDs with fresh approval/reservations; cancellation never refunds applied
work. The bounded numerical path additionally avoids pending/applied prompts.

`variants` maps each new assessment to its existing canonical assessment/family and
artifact digest. A variant provides another attempt in the **same** family, never a
new independent-family credit. The parent must enforce attempt eligibility/limits
and preserve canonical evidence semantics when serving/grading it. Failed or passed
old evidence stays bound to its original base/objective/artifact; plan revisions do
not erase it. More available questions do not automatically permit more attempts.

Reading a state (`materializeAdaptation` and every transition) re-checks its digest,
enrollment/base/binding identity, plan lineage and policy reservations. SDK proposal
validation of retained admissions, and the state-only lineage checks, are recorded per
process once they pass, keyed by a SHA-256 of exactly their inputs (immutable base
digest, admitted plan, proposal, assignments and verifiers; or the verified state
digest). A request therefore does not revalidate every adaptation already applied.
Changed or tampered bytes produce another key and are checked in full again; only
successes are recorded. Admission and application run SDK validation of the proposal
against the current plan and registry on every call, and reuse a record only for
byte-identical inputs: a host that checked the proposal with `validateAdaptationProposal`
before staging it (the same key), or admission moments before application. The records
are a bounded in-memory LRU, never shared between processes and never a grant.

The validated base course is recorded by the SHA-256 of its canonical JSON; a host that
passes the same deeply frozen course object again is recognised by identity and the
course is not copied, hashed or validated again, including by transition argument
capture and the numerical generator and verifier ports. Any other course is copied and
hashed on every call. After every check above has run for the current call, the derived view
is looked up by the base course digest and the verified state digest: it is a pure
function of those two inputs, so it is projected and compiled once per state and then
returned again. Views are deeply frozen, share unchanged parts with the frozen base
course, and must be treated as read-only; a tampered or resealed state either fails
the digest check or has another digest and is projected again.
`proposalValidationStatistics()` exposes counters (including `projections` and
`courseDigests`) for tests and diagnostics.

Send only the `learner` projection to general learner clients. It reuses the SDK
compiler's grading/item-bank allowlist; hidden fixtures remain solely in the server
artifact journal. Authorized assessment delivery is a separate parent operation.
Server views, proof registries, authority references and assignments are internal.
Plain text/visual data still requires trusted content review for embedded secrets.

## Bounded numerical generation and independent checking

`createNumericalExerciseGenerator` implements SDK `ExerciseGeneratorPort` for an
author's integer-bounded numerical recipe. A supplied ordinal deterministically
enumerates variable combinations; the SDK interprets the bounded arithmetic AST.
There is no eval, script execution or generated source execution. Noninteger
recipes use another registered creator; this enumerator fails `CREATOR_REQUIRED`.

`createNumericalArtifactVerifier` implements SDK `ArtifactVerifierPort`. The host
supplies a separately implemented `NumericalReferencePort`, selected by the exact
author verifier/version/check. It receives template digest and variables, **not**
the generated expected answer. The verifier compares that reference against the
recipe and exact generated answer, and checks prompt, sources, objectives, family,
scoring tolerance and artifact binding. It only performs the declared numerical
check; it cannot assert unrelated media/language/code checks passed.

`generateFreshNumericalVariant` searches at most 256 supplied candidate ordinals,
skips canonical and retained prompts, and returns an artifact plus verification
data. A failed learner can therefore receive a fresh checked question after the
fixed item bank is used, subject to author family bounds, eligibility and policy.
Wrong outputs/reference values, overflow, invalid variables, missing author scope,
unsupported checks and cancellation fail explicitly. Exhausted search returns
`FRESH_VARIANT_UNAVAILABLE` or `RECIPE_SPACE_EXHAUSTED`; it never grants a pass or
silently expands bounds. Three creator/verifier functions are generic SDK ports;
nonnumerical creator plugins use the same proposal/admission/application path.

The returned `verificationBinding` binds the candidate artifact and current plan;
it is **not** the digest of a final assembled proposal. `publicationAuthority` is
`not_granted`. Assemble the final proposal, run the trusted verifier against its
exact digest, authenticate/store its receipt, and obtain the separate author/server
work authorization before admission. Do not turn a model's assertion, local port
return value or reference hash directly into a trusted receipt record.

## Required transaction integration

The parent must load all relevant data from trusted storage and commit under one
transaction (or an equivalent correctly coordinated protocol):

- Compare-and-swap/lock enrollment + immutable base identity, adaptation ledger
  revision/digest, plan revision/digest, policy revision/ledger/full digest, registry
  revision/full digest, and evidence revision/digest from `preconditions`.
- Persist both successor ledgers, the entire plan/application/admission history,
  reservations/assigned-work records, command receipt and outbox atomically. Never
  merge competing successor snapshots or persist an intermediate scope reservation.
- Enforce uniqueness for enrollment state, idempotency key, admission/proposal,
  reservation/assigned work and outbox IDs. Concurrent parent workflows must share
  the same policy and evidence fences. Cross-enrollment budgets need their own locks.
- The same key and semantic command replays the original receipt with current state
  and no new outbox effects, even after expiry. Transport time/expected revisions are
  excluded from the request digest; changed semantic terms conflict. A new key for
  an already applied admission is rejected. Retain receipts for the retry lifetime.
- On a failed fence, roll back, reload and recompute. Recheck revocation, authorization
  and the authoritative server time at commit. `preconditions.evaluatedAt` records
  the supplied decision time; `mustCommitBefore` is the exclusive earliest applicable
  policy cutoff/authorization expiry for new admissions/applications (null for
  cancellation/replay). Enforce that bound using authoritative commit-time data. Pure functions
  cannot prevent a transaction from committing after its supplied `now` becomes stale.

Snapshots are finite JSON (SDK depth/node bounds apply), with at most 1000 retained
admissions and 3000 command receipts in this implementation. This is a bounded domain
module, not an unbounded journal database or pruning/migration API. Hitting those
bounds is an explicit integration limit, never permission to erase counters/history.

Tests execute actual deterministic arithmetic and a separately written reference
branch, including deliberately wrong variants. Registry/authentication inputs are
synthetic stand-ins for trusted database records. Tests cover pure state transitions,
not live model quality, cryptographic authentication, database transaction races,
durable orchestration, browser delivery or deployment acceptance.
