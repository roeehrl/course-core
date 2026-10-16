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

## Structured requests, YouTube search and reviewed resource choice

A course can declare SDK `researchTasks`. `request_research` can then name a
task, an objective of the current lesson, a declared misconception hypothesis
ID, known prerequisite IDs, and enumerated modality, remaining-time and
accessibility buckets. The host fills in the request ID, the episode revision,
the language and the source policy from the task. It validates the whole SDK
`ResearchRequest` with `validateResearchRequest` and stores it, bound by
digest. These fields are never sent to search: the external model still
receives only the approved public query. The task's `deadlineSeconds` sets a
deadline after which a result is never collected, and the request is shown as
`expired`. A learner, or staff with access, can cancel an outstanding request
(`POST /api/enrollments/:id/research/:requestId/cancel`). A result stays bound
to the objective and lesson it was requested for, even if the learner moves on.

Staff can search YouTube for a topic
(`POST /api/admin/releases/:releaseId/research/topics/:topicId/youtube-search`).
The request body carries only a result count. The server sends the topic's
approved query through the Data API adapter, using the workspace key that an
owner or admin binds in Provider setup as `COURSE_PROVIDER_YOUTUBE_DATA_API_KEY`.
Without that key, search is unavailable. Results are stored as metadata-only,
unreviewed MediaCandidates. A source added from a stored search copies the
duration, caption and embeddability metadata on the server. A video review can
record the segment the reviewer actually watched. That segment must fit within
the known duration, and the learner player starts and stops there.

`list_reviewed_resources` presents the lesson's live, latest-approved
attachments as SDK MediaCandidates: objective fit, quoted claims, segment,
duration, captions, rights and concerns. `choose_resource` stages at most one
of these per objective. The plan verifier and the application re-check the
following: the tool receipt, consent, any active independent check, the
learner's current lesson (a choice for a lesson the learner has left is
rejected, so it can be replanned), the attachment's liveness, and the exact
candidate digest. A newer choice supersedes an older one for the same
objective. The learner sees "Suggested for you" on the chosen resource. The
resource stays optional and grants no credit. Erasure ends choices and clears
the stored request fields.
