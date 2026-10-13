# AI drafts for written-answer reviewers

A person reviews every written (rubric) answer. When the learner opts in, a
reviewer may ask a model to draft findings for them to check.

- **Learner choice.** Off by default, separate from adaptive-teaching consent,
  changeable at any time (`/api/enrollments/:id/review-assist`). Revoking it
  stops any draft from being produced or shown, including one already shown:
  a draft is visible, and can be recorded as open on a review, only while
  consent is granted at the same revision it was requested under. Granting
  again does not revive an earlier draft; a reviewer may request a new one.
  Erasure revokes it.
- **What the model sees.** The question, the rubric criteria and the answer
  text. Not the learner's name, profile, history or other answers.
- **How it runs.** A staff request becomes a `reviewer` supervisor job: budgeted,
  fenced and durable like the other roles. It needs a configured `reviewer`
  role (a `structured_assessment` model); otherwise the request is refused.
- **Asking again.** Repeating a request returns the same one while it can still
  produce a draft. Once it cannot (its job failed or was cancelled, its event
  was refused or never admitted, or the consent grant it was made under ended),
  the queue shows it as failed or available and a new request supersedes it;
  the earlier request is kept for audit.
- **Checks before a reviewer sees it.** The host verifier requires one finding
  per criterion, and every "met" finding must quote the answer verbatim (10+
  characters). The rubric, answer, consent revision and pending state must be
  unchanged since the request.
- **What it is not.** A draft creates no evidence, grade or learner-visible
  review. The reviewer's own saved review is the only judgement, with their own
  quotations, exactly as without drafts.
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
