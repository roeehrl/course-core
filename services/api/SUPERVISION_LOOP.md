# The supervision loop: teaching actions, follow-ups, roles and authority

Design §4 (requirements B02 to B06, B08, B09, N01, Q08, C01, C06). Everything here runs
after the learner's course-scoped opt-in ("personal support"), within the workspace's
autonomy level, its permitted tool families and the paid limits. Scripted models are
used in tests: they prove Core's orchestration and authority checks, not any model's
teaching quality.

## Observe, act, deliver, follow up

1. **Trigger table** (`teaching-triggers.ts`, T1 to T10). A learner signal (an answer,
   a companion question, a challenged grade, a review that came due) yields
   recommendations. A review due comes from the retention wake-up (`wakeups.ts` calls
   `recordReviewDue`, rule T10).
2. **Teaching actions** (`teaching-actions.ts`, table `teaching_actions`). Core starts
   each recommendation itself as supervisor work: a contrast case, a change of
   representation, a prerequisite visit, a transfer check, a worked example, compressing
   toward advanced material, re-evaluation or preparing the next review. A row plus a
   system event `teaching.action_started` that the bridge prepares into its own job.
   Held back (recorded in the signal's `skipped`) when the autonomy level is
   `recommend_only`, supervision is stopped, an independent check is open, the same
   action is already open for the objective, two actions are open, or four were started
   today (`DEFAULT_ACTION_POLICY`).
3. **Job record** (`objective` in the job specification and `supervisor_jobs.objective`):
   what the job is for (`teaching_action`, `follow_up`, `transfer_probe`, or the
   learning event's episode objectives), with identifiers only.
4. **Logical roles** (B04). An action that builds new material (contrast case, change of
   representation, worked example) runs as a planner, two builders that run
   concurrently (`group: build`, at most three) and an evaluator. Each is a checkpoint
   the bound model runs with a narrower brief and tool set (`toolAllowedForRole`). The
   builders see the planner's brief; the evaluator compares their drafts and commits to
   one. One writer commits: only the last checkpoint's artifact is verified and applied,
   and the verifier refuses an evaluator plan that is not exactly one builder's draft. A
   builder that fails ends the job and its sibling's call is cancelled; nothing it made
   can be applied late.
5. **Delivery and follow-up** (B02). When the job's change is applied, its actions are
   delivered and Core schedules a follow-up (after 24 hours) and, for new teaching, a
   transfer probe (after 72 hours). Each is a supervisor job parked as `follow_up_due`
   with its own input event (`teaching.follow_up_scheduled`). The dispatcher's reconcile
   pass resumes it when due: Core first resolves the deterministic part (did independent
   evidence on the objectives follow the change; for a transfer probe, a novel item from
   an untried problem family, never a gate, placement, retention or probe item), stores
   it on the action, and re-bases the job on the learner's current state. A follow-up
   whose objectives were all demonstrated since, or whose learner turned support off, or
   whose workspace lowered autonomy, ends with that reason instead of running.
6. **Learner view.** `GET /api/enrollments/:id/supervision/requests` lists the actions
   (codes only) and the decisions the supervisor asked of the learner. The learner app
   shows them under "Decisions and work from your supervisor". Nothing here is evidence.

## Separate authority (B06)

The supervisor may change personal teaching after the opt-in; the learner sees and can
undo those changes (`personal-changes.ts`). It may not change the overall goal,
required objectives, grading standards or a paid ceiling. It can only ask, with
`request_authority`; such a plan carries nothing else. The plan verifier records the
request (`supervisor_authority_requests`) and parks the job (`needs_input`, deadline
extended by up to seven days within the course deadline).

| Change | Who decides | On approval |
| --- | --- | --- |
| A new overall goal | the learner (`POST /api/enrollments/:id/supervision/requests/:requestId/decision`) | the goal is replaced; the learner can undo it while it is unchanged |
| Required objectives, grading standard | owner or admin (`POST /api/admin/workspaces/:id/supervision/requests/:requestId/decision`) | the decision is recorded for the course authors; Core never edits a published release |
| A higher paid ceiling | owner or admin | the learner's AI spending limit is raised |

The decider applies the change under their own authority in the decision's transaction;
the job then resumes on the new state and records that it finished. A rejection ends the
job. Decisions are audited (`supervisor.authority_decided`).

## Workspace settings (Q08, B09)

Owners and admins (`supervision.settings`) set, in the admin **AI supervision** area:

- **Autonomy** (`supervision_settings.autonomy_level`): `recommend_only` (recommendations
  are recorded, nothing starts, scheduled follow-ups end), `propose_only` (work starts,
  but a plan that would change the learner's teaching is refused at verification;
  proposals the learner reviews still go on), `apply_verified_personal` (default).
- **Permitted tool families**: the tool loop is offered, and the host accepts, only tools
  of permitted families.
- **A learner's daily and per-lesson AI spending limits** (UTC days), wired to
  `configureSupervisorPeriodBudget`; a lesson limit above the daily one is refused.

`GET/PUT /api/admin/workspaces/:id/supervision/settings` (revision-checked, audited as
`supervision.settings_changed`), `POST .../settings/preview` (what a choice would change,
saves nothing; the page requires it before saving), `GET/PUT
.../supervision/enrollments/:enrollmentId/budget` (audited as `supervision.budget_changed`).

## Course-declared strategies (B08)

A course package may declare SDK 0.5 `agentStrategies`. A declaration is data, never
code: Core binds it to its own strategy for the same role and lets it only narrow that
strategy (catalog tools the course also declares with Core's contract, fewer tool calls,
a smaller output allowance, fewer retries, a subset of proposal kinds, autonomy
`propose_only` or the same). Anything wider refuses the package at inspection and install
(`PACKAGE_AGENT_STRATEGY_REFUSED`) and is ignored at runtime. A propose-only tool loop that
would deliver a teaching change ends with the refusal `autonomy_exceeded`.

## Declared profile and provenance (C01, C06)

The learner's declared facts and preferences add languages (BCP 47 tags), experience,
depth, a weekly time budget and accessibility needs; direct edits take effect at once
and override inferred preferences. Each skill-projection evidence reference names its
evaluator, who decided it (`automatic_check`, `staff_review`, `second_opinion`,
`staff_regrade`; never a staff identity) and when it was recorded.

## Limits

- Real teaching quality of the planner, builders and evaluator needs live models; only
  scripted models were used.
- A follow-up job reads its outcome when it resumes; there is no learner notification
  (notifications follow explicit preferences, which Core does not collect yet).
- Session-ended (part of T10) is not emitted; review due is.
