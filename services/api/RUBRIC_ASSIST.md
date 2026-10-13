# AI drafts for written-answer reviewers

A person reviews every written (rubric) answer. When the learner opts in, a
reviewer may ask a model to draft findings for them to check.

- **Learner choice.** Off by default, separate from adaptive-teaching consent,
  changeable at any time (`/api/enrollments/:id/review-assist`). Revoking it
  stops any draft that has not yet been shown; erasure revokes it.
- **What the model sees.** The question, the rubric criteria and the answer
  text. Not the learner's name, profile, history or other answers.
- **How it runs.** A staff request becomes a `reviewer` supervisor job: budgeted,
  fenced and durable like the other roles. It needs a configured `reviewer`
  role (a `structured_assessment` model); otherwise the request is refused.
- **Checks before a reviewer sees it.** The host verifier requires one finding
  per criterion, and every "met" finding must quote the answer verbatim (10+
  characters). The rubric, answer, consent revision and pending state must be
  unchanged since the request.
- **What it is not.** A draft creates no evidence, grade or learner-visible
  review. The reviewer's own saved review is the only judgement, with their own
  quotations, exactly as without drafts.
- **Measuring it.** The review records which draft was open.
  `/api/admin/courses/:catalogId/rubric-assist/agreement` reports how often
  reviewers agreed with drafts per criterion. That is agreement, not accuracy,
  and says nothing about learning outcomes.

Tests use a scripted model through the real bridge and gateway. They show the
host path and its refusals; they do not show the quality of any real model.
