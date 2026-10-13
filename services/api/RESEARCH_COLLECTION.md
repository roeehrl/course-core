# Scoped public-topic research collection

The supervisor can list creator-declared public topics and stage at most two
research requests in a job. A model cannot supply a query, URL, tenant, paid
ceiling or source-use approval. The host resolves the selected topic against the
immutable enrolled course and binds its query/domain configuration by digest.

Staging sends nothing to search. Separate plan verification matches actual tool
receipts and current consent/scope. Plan application activates a transactional
outbox event. The dispatcher creates a distinct research job with its normal
shared workspace/enrollment budget and deadline; duplicate activation or
preparation reuses the existing event/job.

The research gateway builds a public-query-only context. It does not load learner
profile, chat, attempts or answer banks. The external model receives only the
approved public query. Output text, parts, source references and citation offsets
are retained with an explicit `unreviewed` state. Provider grounding is a claim,
not a truth or licensing certificate; provider HTML suggestions are discarded.

A dedicated collection verifier checks format, source/query scope and citation
bounds. Its `can_collect_research` authority cannot approve course adaptations.
Verified collection publishes exactly one scoped candidate to the review queue,
never a lesson, media block or mastery record. Lost acknowledgement/restart and
operation/application retries reuse receipts without another search submission.

The learner timeline and research endpoint expose status/reference metadata only.
The authenticated release-scoped owner/admin/instructor endpoint can read
untrusted candidates for review. The run inspector keeps them `pending_review`
even after collection succeeds. Raw external content is not retrieved by the
ordinary debugger; another learner cannot read an enrollment's queue.

This path deliberately stops at an unreviewed collection queue. Source fetching,
inspection, relevance/content/rights review, approved YouTube or other media
attachment, expiry/revocation and their administration UI remain the next delivery
phase. The standalone research package supplies bounded inspection/review
contracts, but a search result is not approval and no uninspected content can be
automatically taught by this collection path.

Regression coverage exercises real Postgres, HTTP and Temporal parent-to-child
dispatch, public/private request separation, query injection, unobserved topics,
request limits, changed consent, duplicate source/queue publication and narrowed
verifier authority. Only external model output is synthetic; live model quality,
source accuracy and learning efficacy require separate acceptance.
