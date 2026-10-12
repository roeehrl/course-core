# Bounded learning policy domain

Standalone TypeScript ESM package for a server-side policy service. All contracts
live in this package; there are no imports from sibling source trees. Functions
use caller-supplied instants, IDs, authenticated receipts and persisted snapshots.
They perform no I/O, read no environment variables and generate no random IDs.
Invalid input throws `PolicyError` with a stable `code`; `checkAction` and
`checkQuotas` instead return ordinary denial decisions for valid requests.

From this directory, with Node 26 and npm:

```sh
npm ci --workspaces=false --ignore-scripts
npm run build
npm test
npm run check
```

`npm test` builds first, then runs native Node tests against the built public API.
The checked-in lockfile pins runtime and development dependencies. Build output is
`dist/` and is ignored by Git.

## Contracts and caps

- `createPolicyState` creates a **new** enrollment with a fixed core objective and
  concept registry, one connected scope tree, and persistent allowance pools. It
  is never a way to reload or revise an existing enrollment.
- `resolveConstraints(state, scopeId)` returns the full ancestor intersection,
  earliest effective deadline, all binding deadlines, quotas with assigned and
  reserved usage, access policy, and policy/ledger revisions. Scope array order
  does not affect the result. Ordinary child definitions cannot remove ancestor
  constraints. A bounded scope must inherit a deadline or finite work cap;
  `open_ended` must be explicit and still inherits ancestor caps.
- Target dates are advisory. Absolute deadlines, relative calendar windows,
  ultimate ceilings, planned-work counters, submission grace, access, coverage
  and mastery remain distinct. Deadlines use an exclusive upper bound: an action
  at the exact cutoff is late. Planned minutes are estimates of assigned work,
  not elapsed reading time. Zero is a real cap; missing work fields mean no cap
  at that scope. Unknown keys, modes, units and invalid numbers are rejected.
- `checkAction` gates planning, admission, tool calls, publication and submissions
  against the current policy revision and authoritative server time. Submission
  grace is predeclared per scope and intersects all ancestor deadlines. It never
  permits new required expansion. After a deadline or enrollment closure,
  `existingMaterialAccess` controls reading; `closed` denies it. Before that
  cutoff, a closed-after-cap policy still permits learning. A read creates no credit.
- `checkQuotas` checks independent finite resource counters. Callers must enforce
  job, spend, safety, attempt and help quotas in addition to pedagogical policy,
  including for open-ended teaching. A policy preflight is not an admission or
  authorization receipt.

The runtime fields deliberately extend the SDK-shaped names (`mode`, `work`,
`window`, `existingMaterialAccess`). Runtime scope identity, persisted clocks,
pool accounting and server receipts do not belong to a course authoring schema.
An adapter must explicitly validate/translate a released SDK policy; passing an
authoring policy directly to this package is not supported.

## Calendar rules

`resolveCalendarWindow` produces a preview containing an immutable anchor event
ID, anchor kind and instant, explicit IANA zone, calendar-day rule, pause rule,
disambiguation choice and resolved UTC deadline. Persist the accepted preview.
Initial enrollment/new-scope creation verifies the preview. Subsequent reads use
the stored deadline rather than recalculating it on reload or device-zone change.

Calendar arithmetic uses the pinned
[`@js-temporal/polyfill`](https://github.com/js-temporal/temporal-polyfill) (ISC),
with Zod (MIT) for runtime validation. Days are added to local wall-clock date/time,
then resolved in the named zone. `reject`, `earlier`, `later` or `compatible` must
be supplied explicitly for DST gaps/overlaps. Fixed UTC offsets are not accepted
as IANA zones; `UTC` is accepted. An extension that hits ambiguity with `reject`
fails instead of guessing. The accepted offer stores the resolved deadline and
exact digest; revalidation will reject any changed resolution before granting.
Host ICU/IANA data affects new previews, so deployment should pin runtime/tzdata
and persist accepted results. The package does not bundle a timezone database.

There are no implicit pause calculations. `previewAccommodation` and
`applyAccommodation` require an audited scope-specific authority receipt.
`approved_pause` can extend only an `approved_only` relative window; it cannot
move an absolute deadline. Accommodations consume no discretionary allowance.
Other caps and ultimate ceilings still bind. A separately authorized adjustment
at an ancestor is necessary before a conflicting child adjustment can take effect.

## Reservations and extensions

`reserveWork` adds a reservation across every applicable ancestor. `commitWork`
turns it into permanently assigned usage and rechecks current time/policy before
publication. A job admitted under an older policy cannot publish merely by
supplying a fresh command revision. `cancelReservation` releases only an unused
reservation; committed work is never refunded by deletion, renaming or retry.
All work IDs, concept IDs and ancestry must be supplied by trusted domain code.
Model-provided optional/required labels cannot be used to bypass this accounting.
Use separate reservations for independently publishable portions; a reservation
commits or cancels as a whole.

`previewExtension` and `proposeExtension` validate scope permission, full effective
benefit, exact named pool costs, total/per-grant/grant-count limits, work feasibility,
ancestor constraints and required authorities. Pools may be shared across explicit
scope IDs. Ancestor pools and deadlines never change implicitly. Every requested
unit must be effective; the engine rejects parent conflicts instead of silently
clipping terms. Propose a smaller explicit offer if appropriate. A deadline grant
does not increase any work cap. Offer activities describe intent and do not reserve
or assign work; the work APIs remain mandatory.

Offers retain rationale references, activities, added work, current/proposed
effective deadlines, current/proposed quota snapshots, exact before/after balances, parent deadlines, alternatives,
plan impact, required approvals, expiry and a canonical SHA-256 terms digest.
Ancestor offer limits intersect; cooldown uses the latest transition (including
decline), and the frequency budget counts all offers in the scope's lifetime.
Proposal, acceptance, decline and expiration debit nothing.

`acceptExtension` records affirmative exact-term consent in
`accepted_pending_admin`. `grantExtension` accepts either that persisted receipt
or an explicit receipt in the grant command, requires every additional authority,
and revalidates time, revision, balance, constraints and workload. It returns the
grant, debit, policy revision, command receipt and audit entry in one successor
snapshot. States are `proposed`, `accepted_pending_admin`, `granted`, `declined`,
`expired`, `rejected` and `superseded`; `disposeOffer` handles non-grant endings.
Expiry at the exact expiry instant is effective even without a timer transition.

## Revisions, closure and persistence boundary

`previewPolicyChange` exposes before/after impacts, outstanding reservations and
offers. `applyPolicyChange` requires a current preview digest and scoped migration
authority. It retains anchors, scope ancestry, pools, usage and grant provenance;
pending offers become superseded. Existing granted deadlines cannot be erased by
shortening the same scope's base deadline. An explicitly reviewed ancestor
shortening can still bind descendants, and is shown in the impact preview.
This version intentionally has no pool replacement/refill, refund, revocation,
anchor reset, scope removal, ultimate-ceiling relaxation or reopening command.
Those require separate audited operations, not ad hoc snapshot edits. Grant-count
and spent-unit balances derive from retained grants, independent of template
revision. Fresh scope creation cannot erase shared ancestor usage.

`previewClosure` and `closeEnrollment` report coverage and evidenced mastery
separately, list gaps, preserve assigned work, cancel unused reservations and stop
required expansion. Evidence inputs must come from authoritative assessment
records. Finishing coverage or exhausting time does not imply mastery. Existing
reading follows access policy; new submissions stop on explicit closure. Technical
grading of an already eligible submission can finish using a trusted receipt
without reopening the enrollment. Optional continuation requires a separately
authorized track; grants do not silently reopen a closed enrollment.

**The host must provide real transaction and authorization guarantees:**

1. Authenticate the actor and verify scope permissions, consent, authority and
   eligible-submission receipts. These typed receipts are trusted claims, not
   signatures and not authentication. Never pass raw browser/model claims as
   verified receipts. Load a complete authoritative enrollment snapshot, including
   all relevant ancestor policies, reservations, history and receipts.
2. Run a command against that snapshot inside a transaction. Every transition
   returns `{ state, receipt, replayed, preconditions }`; compare-and-swap or lock
   the enrollment using both `preconditions.policyRevision` and
   `preconditions.ledgerRevision`. Shared enrollment pools are in that same fence.
   Pools shared **across enrollments** require a separate database locking model
   and are outside this package's state boundary.
3. Persist all successor state, allowance/grant records, policy revision, command
   receipt, audit/outbox events and work/artifact publication together. The grant's
   `atomicLedgerTransactionId` is supplied by the host; the package does not create
   a database transaction. Enforce unique enrollment/idempotency key, grant/offer,
   reservation and assigned-work IDs as database constraints too.
4. If a fence fails, roll back and reload; re-run validation. Do not merge two
   successor snapshots. Two pure calls on the same input can both propose a valid
   final debit. Exactly one must win the database commit.
5. Retain receipts for the retry lifetime. The same key and semantic command
   return the original receipt with current state, even after revision/expiry.
   Reusing a key with different semantic terms fails. Retry-time `now`, expected
   revisions and a newly allocated transaction ID are transport metadata excluded
   from the request digest. No retry replaces the original grant transaction ID.
   Returning a replay must not publish duplicate outbox entries. Consumers must
   also be idempotent for at-least-once delivery.

Tests cover pure domain behavior, DST, stale revisions, sequential contention,
consent, caps, preserved accounting and invalid values. They **do not prove**
transaction isolation, database race safety, authentication, cryptographic receipt
verification or live deployment behavior.
