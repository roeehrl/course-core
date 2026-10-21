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

## YouTube Data API: quota and a live run

Search sends only the topic's approved query, with the workspace key in the
`x-goog-api-key` header. Google charges quota for every call, refused ones included, and
the allocation resets at midnight Pacific time (developers.google.com/youtube/v3, read
2026-10-21: 10,000 units a day by default; `search.list` costs 1 unit and is limited to
100 calls a day; `videos.list` costs 1 unit). Course Core reserves each call's units in
`youtube_quota_usage` (migration 103) before sending it, so a workspace stops locally with
`YOUTUBE_QUOTA_EXHAUSTED` and the reset time instead of being refused by Google. A search
reserves 2 units and 1 search. An owner who has a raised allocation sets the real limits
(`POST /api/admin/workspaces/:id/youtube/quota`). When Google answers `quotaExceeded`
anyway, the day is marked used up and nothing more is sent until it resets.

Each documented refusal has its own code and admin message: `YOUTUBE_SEARCH_QUOTA` (the
project's daily quota; with the reset time), `YOUTUBE_SEARCH_RATE_LIMITED` (with the
`Retry-After` wait), `YOUTUBE_SEARCH_KEY_INVALID`, `YOUTUBE_SEARCH_API_DISABLED` (the
project has not enabled the YouTube Data API v3), `YOUTUBE_SEARCH_UNAUTHORIZED` and
`YOUTUBE_SEARCH_FAILED`. None is retried automatically. The research page shows today's
use and a "Check the YouTube key" button (`POST .../youtube/check`): one
`i18nLanguages.list` call (1 unit) that sends no course text.

What a live run needs from the owner, and nothing else:

1. A Google Cloud project with the YouTube Data API v3 enabled.
2. An API key from that project (restricted to the YouTube Data API v3 is recommended),
   entered in AI services → Advanced (for developers) → YouTube search key.
3. "Check the YouTube key" on the research page, then one search on an approved topic.
4. If the project has a raised quota, its limits entered as the workspace's daily limits.

All tests use a stubbed fetch or a local stub HTTP server; no live YouTube call has been made.
