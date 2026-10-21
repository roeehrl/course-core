# The supervision loop: teaching actions, follow-ups, roles and authority

Design §4 (requirements B02 to B06, B08, B09, N01, Q08, C01, C06). Teaching actions and
their follow-ups run only after the learner's course-scoped opt-in ("personal support"),
within the workspace's autonomy level, its permitted tool families and the paid limits.
Paid supervisor review itself is admitted by workspace policy and spending limits, also for
learners who have not opted in; for them it reads reduced context and can only prepare
suggestions for staff (requirement B06 governs what the supervisor may change, not whether a
paid analysis runs). Scripted models are
used in tests: they prove Core's orchestration and authority checks, not any model's
teaching quality.

## Observe, act, deliver, follow up

1. **Trigger table** (`teaching-triggers.ts`, T1 to T10). A learner signal (an answer,
   a companion question, a challenged grade, a review that came due, a study session that
   ended) yields recommendations. T10 has two sources: a review due comes from the
   retention wake-up (`wakeups.ts` calls `recordReviewDue`), and a session end from
   `learner-sessions.ts` (below). Either prepares the next review or lesson within budget;
   a second one for the same objectives inside the recommendation cooldown is skipped.
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

## Study sessions and "session ended" (T10, B03)

A study session is a run of the learner's own learning events. Migration 108 keeps one row
per enrollment (`learner_sessions`: start, last activity, end and reason, a session
counter; timestamps only), opened or extended by a database trigger on every learner event.
It ends at most once, in one guarded update, when:

- the learner app reports the learner left: `POST /api/enrollments/:id/session/end` (the
  enrollment's own learner only; empty body), sent as a keepalive request when the page is
  hidden for good and before signing out; or
- it was quiet for 30 minutes (`SESSION_IDLE_MS`): the wake-up scan ends it.

Repeats, other tabs and the scan then find nothing open. Each end appends `session.ended`
(learner or system). For an active enrollment with the learner's opt-in it is T10's
signal: Core starts `prepare_review` for the objectives of the first unfinished lesson,
within the usual action caps, and records restraints `notifications_follow_explicit_preferences`
and `one_preparation_per_session`. Nothing is inferred without the opt-in, nothing is
evidence, and no notification is sent. The row is in the learner's export
(`studySession`) and deleted by erasure.

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
- **A learner's daily and per-lesson AI spending limits**, wired to
  `configureSupervisorPeriodBudget`; a lesson limit above the daily one is refused. Days
  start at midnight in the course's policy time zone (`course_policy_settings`), else UTC
  (also for a zone the server does not know); the limits view reports `dayBoundary`
  (`utc` or `course_time_zone`) and `dayTimeZone`. Media counts toward both limits: media
  ledger rows name their lesson (migration 108), a media job or assistant call is refused
  (`MEDIA_BUDGET_EXHAUSTED`) when the learner's day or the lesson has too little left, and
  supervisor jobs see media charges the same way.

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

A course strategy is gated separately from Core's own (`AGENT_EVALS.md`): it is its own
role revision, and the provider gateway refuses it (`COURSE_STRATEGY_NOT_CHECKED`, nothing
sent) until that exact revision has a passing check or an owner's approval. Core's wider
strategy never runs in its place. Every dispatch records which strategy answered
(`provider_dispatches.strategy_id`, `strategy_version`, `strategy_source` core or course),
the role revision it ran as and its standing then (`passed`, `approved`, `not_checked`,
`unknown`); the run inspector shows it in plain words.

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
- A session that ends while the app is offline ends by the idle scan, up to 30 minutes
  later than the learner actually left.
