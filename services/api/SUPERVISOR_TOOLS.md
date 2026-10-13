# Scoped supervisor tools and reviewed lesson support

The supervisor can retrieve bounded retained conversation pages, learner profile
and evidence projections, course source references, and author-reviewed support.
It can select a reviewed explanation for the current episode. A separate host
verifier checks scoped receipts; application rechecks permission, enrollment,
plan, policy, evidence, registry and deadline fences in the same transaction as
lesson delivery. A selection or model summary is never an applied lesson or
completion credit.

## Explicit operator and learner controls

Select the installed `authored-teaching-bank-v1` adapter explicitly. Publish a
course with compatible SDK adaptation targets, generator/verifier declarations,
source references and extension digest. An authorized creator approves the
release's registry containing the exact reviewed `teachingBank` entries. This
adapter verifies exact membership of reviewed content; it does not establish the
truth of arbitrary generated text.

Bind the supervisor role to a model with `structured_assessment` capability and
set `maxToolRounds` to an integer from 2 through 8. `maxInputCharacters` must be
at least 20,000; configure an output bound and sufficient job/shared budget.
Omitting `maxToolRounds` retains legacy proposal-summary behavior. Conservative
all-round token reservation must fit before the first model call. Unknown cost
keeps the reserved monetary ceiling; actual reported usage across rounds is
settled once. No credentials or paid allowance are enabled by these settings.

Each learner chooses **My profile → Personal lesson support → Enable personal
support**. Default is off; staff cannot manufacture the learner's consent. Changes
increment enrollment and permission revisions, invalidating pending stale jobs.
Turning off stops future delivery but retains previously delivered material and
its audit record. Current support is withheld while any independent challenge is
active and remains subject to course work caps. No silent extension or changed
assessment threshold is allowed.

**Learning record → Supervisor activity** is an optional learner timeline. It
shows actual tools, context reference counts, and whether selected support was
applied. It does not expose provider prose, draft teaching, hidden grading data
or raw history. It returns the newest 50 receipts; a complete operator history
viewer remains a separate capability.

## Tools and persistence

- `get_history`: five scoped messages per page, each bounded to 1,000 characters;
  a scoped message-ID cursor retains PostgreSQL timestamp precision. Truncation
  is explicit. This is retained-history paging, not unlimited message retrieval.
- `get_profile` / `get_evidence`: trusted, bounded current enrollment projections.
  Self-report is distinct from independent evidence.
- `list_sources`: reviewed course reference metadata; source contents are not
  fetched or treated as instructions.
- `list_support` / `choose_support`: only the current episode's active, approved
  support bank. No arbitrary URL, SQL, user, tenant, grade or proof parameters.

Receipts use stable operation/step IDs. Concurrent identical retries return the
same receipt; changed arguments conflict. Model-supplied receipt/selection
claims are insufficient. Atomic application records the real adaptation
proposal and plan revision with one effect per supervisor job. Agent application
events do not trigger an unbounded supervision feedback loop.

The bounded loop requires an explicit finish. Bad structured output, reached
round limits, stale scope or oversized projections cannot deliver material.
Already observed provider usage survives later failures. Durable gateway
receipts avoid resubmission after a lost acknowledgement.

## Acceptance and current limits

`test/supervisor-tools.integration.test.ts` exercises real PostgreSQL and HTTP
routes: actual lesson changes with unchanged mastery, opt-out/revocation,
assessment hold, scoped pagination at microsecond boundaries, concurrent retry,
foreign reads/receipts and receipt replay. `qualification/supervisor-tools-flow.ts`
runs within the required combined Temporal gate: actual enrollment outbox,
HTTP gateway, tools, separate verification, atomic delivery, lost committed
application acknowledgement, worker restart, one lesson effect and one cost
settlement. External models are synthetic; these tests do not prove live Google
behavior. Learner tests cover lost permission acknowledgements, stale writes,
account changes and accessible phone/tablet/desktop persistence.

Novel generated drafts, whole personal episodes, fetched-source review,
research/media dispatch and arbitrary rich visual generation remain separate
implementation gates. This module must not be advertised as their completion.
