# AI drafts for written-answer reviewers

A person reviews every written (rubric) answer, except where a gate's
deterministic evaluator confirms a verified draft of a gate conversation (see
below). When the learner opts in, a reviewer may ask a model to draft findings
for them to check, and for a gate conversation the supervisor proposes a draft
itself.

- **Learner choice.** Off by default, separate from adaptive-teaching consent,
  changeable at any time (`/api/enrollments/:id/review-assist`). Revoking it
  stops any draft from being produced or shown, including one already shown:
  a draft is visible, and can be recorded as open on a review, only while
  consent is granted at the same revision it was requested under. Granting
  again does not revive an earlier draft; a reviewer may request a new one.
  Erasure revokes it.
- **What the model sees.** The question, the rubric criteria, the answer
  text and, for a reply in a review conversation, the earlier turns of that
  conversation (the learner's earlier answers and the reviewer's questions,
  labelled by speaker). Not the learner's name, profile, history or other answers.
- **How it runs.** A staff request becomes a `reviewer` supervisor job: budgeted,
  fenced and durable like the other roles. It needs a configured `reviewer`
  role (a `structured_assessment` model); otherwise the request is refused.
- **Supervisor proposals.** When the learner submits a turn of a gate
  conversation (`gate-conversation:<gateId>`, first answer or reply), has opted
  in, and the supervisor bridge and a `reviewer` model are configured, Core
  queues the same request itself (`origin: "supervisor"`, no staff requester,
  a `system` activation event). Without the opt-in nothing is queued and a
  person reviews the answer as before. The bridge refuses a `system` activation
  for a staff request and a `staff` activation for a supervisor one.
- **Asking again.** Repeating a request returns the same one while it can still
  produce a draft. Once it cannot (its job failed or was cancelled, its event
  was refused or never admitted, or the consent grant it was made under ended),
  the queue shows it as failed or available and a new request supersedes it;
  the earlier request is kept for audit.
- **Checks before a reviewer sees it.** The host verifier requires one finding
  per criterion, and every "met" finding must quote one of the learner's own
  turns verbatim (10+ characters); the reviewer's questions do not count. The
  rubric, answer, consent revision and pending state must be unchanged since the
  request. A summary or a "met" without a quote is refused, so a model's
  impression never reaches anyone.
- **What it is not.** A draft creates no evidence, grade or learner-visible
  review. The reviewer's own saved review is the judgement, with their own
  quotations, exactly as without drafts.
- **Deterministic confirmation (gate conversations only).** If the gate's
  evaluator is declared `method: 'deterministic'` (and does not require human
  confirmation), Core asks its installed, integrity-matched adapter
  (`confirmConversationFindings`) about each quoted finding of a verified draft,
  together with the turn each quote came from. When every "met" finding is
  confirmed and every required criterion is met, Core records the review with
  `confirmation: "deterministic"` (no reviewer, the evaluator and adapter
  identity in `confirmer`) and quoted evidence; the learner sees "Checked
  automatically" and may still ask a person for a second opinion. Otherwise
  it records nothing but the reason (`automaticCheck` in the queue:
  `evaluator_declined`, `proposal_not_met`, `grading_closed`, …) and the answer
  waits for a person. Deterministic confirmation never records "not met".
- **Learner export.** The learner's export lists each draft about their
  answers (summary and per-criterion findings, marked not a grade). While the
  answer still awaits a met / not met judgement the findings are withheld, as
  clarification findings are, so they cannot coach a reply.
- **Measuring it.** The review records which draft was open.
  `/api/admin/courses/:catalogId/rubric-assist/agreement` reports how often
  reviewers agreed with drafts per criterion. That is agreement, not accuracy,
  and says nothing about learning outcomes.

Tests use a scripted model through the real bridge and gateway. They show the
host path and its refusals; they do not show the quality of any real model.
