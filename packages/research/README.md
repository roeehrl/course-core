# Source inspection and review

Provider-neutral, course-neutral source inspection. The portable entrypoint
contains inert media descriptors and contracts; `@course-core/research/node`
contains the server-only inspector and reviewer. It never runs page scripts,
loads page subresources, scrapes video transcripts, or grants learning credit.

An application supplies an authenticated authorization port that loads a
versioned, approved public-topic/source catalog. Requests accept catalog IDs,
not arbitrary learner-supplied URLs, search queries, profiles, or credentials.
HTTPS requests validate every DNS answer, pin one public address, preserve
certificate/hostname verification and recheck every redirect. Responses, headers,
time, concurrency, extraction depth and readable text are bounded. Private,
loopback and special-purpose addresses are rejected. HTML is parsed in a worker
and reduced to escaped readable text with immutable hashes and provenance.

Search results, page text and provider attribution remain untrusted. Inspection
returns `unreviewed` content. A separately authorized author review must bind the
exact inspection and relevant passages, explain suitability, and specify rights.
An author review is a content-use decision; it is not a truth certificate.

YouTube metadata is fetched from a server-derived oEmbed URL. The descriptor uses
the nocookie embed host and requires deliberate user activation. Authorized
transcripts or author explanations provide fallbacks; there is no automatic
transcript scraping or background thumbnail/video request.

`npm run check` exercises actual bounded extraction and TLS loopback transport,
including certificate failures, redirects, body/header limits, cancellation,
DNS rebinding, private addresses, policy/role scope and portable imports.
`npm run inspect:public` is a bounded live inspection of a fixed public MDN page;
it emits metadata and digests only and does not approve or publish the source.
Course Core's API composes these primitives into a stored source catalog,
inspection, review and revocable attachment workflow; course adaptation remains
a host responsibility. `inspectionDigest` and `verifyInspection` let hosts
re-verify persisted inspections without network access. Tests do not establish live model content quality.
