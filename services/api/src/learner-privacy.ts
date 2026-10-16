import { roleCan } from './course-access.js';
import { auditPayload } from './workspace-audit.js';

/**
 * One privacy rule for a learner's own space, shared by every staff-facing read
 * (the learner-model API, the read-only "view as learner" and staff data
 * exports). Course administration alone does not grant access to the learner's
 * private conversation or to their own notes about themselves; staff see what
 * the learner did and the evidence it produced, never what the learner wrote
 * about themselves for themselves. The learner always sees everything, and
 * sees every staff view and staff download of their record.
 *
 * There is no learner sharing control yet, so nothing grants staff more.
 * The enrollment profile (name, learning goal, pace) is not part of the
 * learner's private space: staff who may read the enrollment see it through
 * enrollmentProfileFor().
 * New staff-facing reads must take their audience from audienceOf() and drop
 * every category below for 'staff' instead of deciding per route.
 */

/** Workspace roles that may read some of an enrollment as staff. Which routes
 * each role may use is decided by the route (instructors, for example, get the
 * learner-model understanding but not the whole learner view or an export);
 * what any of them may see is decided here. */
export const STAFF_READ_ROLES = ['owner', 'admin', 'instructor'] as const;

export type LearnerDataAudience = 'learner' | 'staff';

/** The enrollment's own learner reads as 'learner'; anyone else is 'staff'. */
export function audienceOf(actorId: string, enrollment: { user_id: string }): LearnerDataAudience {
  return enrollment.user_id === actorId ? 'learner' : 'staff';
}

/** Parts of the learner's space that are private to them. Each staff surface
 * reports this list as `withheld` so staff and the learner can see the rule. */
export const WITHHELD_FROM_STAFF = [
  { id: 'companion', label: 'Companion conversation', reason: 'Private between the learner and their companion.' },
  {
    id: 'learner-model',
    label: 'Learner model (preferences, prior knowledge, thoughts, proposals, change log, question history)',
    reason: "The learner's own notes about themselves are private to them.",
  },
  { id: 'drafts', label: 'Unsent answer and message drafts', reason: "Drafts stay on the learner's device and are never sent to the server." },
  {
    id: 'gate-review-reason',
    label: "The learner's own words in gate review requests",
    reason: 'Written for the reviewer who decides the request, and shown to staff only where they decide it.',
  },
  {
    id: 'written-answer-appeal-reason',
    label: "The learner's own words asking for a second opinion on a written answer",
    reason: 'Written for the second reviewer who decides the appeal, and shown to staff only where they decide it.',
  },
  {
    id: 'evidence-dispute-reason',
    label: "The learner's own words disputing a piece of their evidence",
    reason: 'Staff see that a result is disputed and review the evidence; the explanation stays with the learner.',
  },
  {
    id: 'activity-work',
    label: 'Work saved inside interactive activities (unsubmitted values) and what an activity reported',
    reason: "Saved as the learner works, including values they never submitted. Staff see that an activity was done and what a registered evaluator concluded, not the learner's work.",
  },
] as const;

export type WithheldCategory = (typeof WITHHELD_FROM_STAFF)[number]['id'];
export const isWithheldFromStaff = (category: WithheldCategory) => WITHHELD_FROM_STAFF.some(row => row.id === category);

/**
 * Gate review requests (decision surfaces vs. record copies). Staff must read a
 * request to decide it, so the review queue (GET /api/admin/courses/:id/gate-reviews)
 * and the per-gate request list for enrollment staff keep the learner's reason.
 * Everything else about a request is staff-visible everywhere: the gate, the
 * decision under review, its state, the reviewer's note and any exception.
 * Copies of the learner's record made for staff (the read-only learner view and
 * staff data exports) follow this rule and omit the reason ('gate-review-reason').
 *
 * Written-answer appeals ("second opinion") follow the same rule. The appeal
 * queue (GET /api/admin/courses/:id/rubric-appeals), where a second reviewer
 * decides the appeal, keeps the learner's reason. The read-only learner view
 * and staff data exports keep the appeal, its state, the second decision, its
 * findings and the reviewer's note, but report the reason as null
 * ('written-answer-appeal-reason'). The learner's own reviews and download
 * keep it.
 */

/**
 * Classification of every free-text field a learner writes that a staff route
 * can reach. Withheld fields are dropped for 'staff' on every surface except the
 * decision surface named; the others are staff-visible by design.
 *
 * Withheld from staff copies (learner view, staff exports, learner-model API):
 * - companion_messages.content (learner turns): 'companion'. Never read for staff.
 * - learner_model_profiles / _changes / _proposals (self-report, preferences,
 *   prior knowledge, thoughts, question history): 'learner-model'.
 * - Unsent answer and message drafts: 'drafts'. Never sent to the server.
 * - gate_review_requests.reason: 'gate-review-reason'. Decision surface: the
 *   gate review queue and the enrollment's per-gate request list.
 * - rubric_appeals.reason: 'written-answer-appeal-reason'. Decision surface:
 *   the written-answer appeal queue.
 * - learner_evidence_controls.reason: 'evidence-dispute-reason'. No staff
 *   surface reads it: staff see which evidence is disputed (the learner-model
 *   understanding marks it, and the course's disputed-evidence queue,
 *   GET /api/admin/courses/:id/evidence-disputes, lists state, objective,
 *   evidence reference and age) and close the dispute by reviewing the evidence.
 *   Whether the learner excluded evidence from AI context is part of
 *   'learner-model' and is not shown to staff either.
 *
 * Staff-visible by design (assessment evidence and the shared enrollment record):
 * - attempts.response: every answer, including written answers, replies to a
 *   reviewer's clarification request (continues_attempt_id) and placement
 *   answers and their clarification replies. Answers are the evidence staff
 *   review and decide on, so they appear in review queues, evidence views, the
 *   learner view and exports.
 * - enrollments.profile (displayName, goal, pace): the enrollment's profile,
 *   including the learner's profile goal. Every staff surface reads it through
 *   enrollmentProfileFor() below, so it is shown to exactly the roles that may
 *   read the enrollment. It is not the learner model; the copy of goal and
 *   pace the learner model keeps as its own preferences (which the learner can
 *   change in their memory panel) stays under 'learner-model'.
 * - Learning events: identity (type, actor kind, time) is staff-visible; payloads follow
 *   eventPayloadFor() below on every staff read.
 */

/**
 * The enrollment profile on staff reads: display name, learning goal and pace.
 * It is what the learner set up when they enrolled (and what owners and admins
 * can correct in enrollment administration), and it is shown, goal included, to
 * every staff role that may read the enrollment (permission 'enrollment.read'):
 * enrollment administration, the read-only learner view, staff data exports and
 * the staff learner-model read. A role without that permission (an observer, an
 * author) never receives it. The learner always reads their own profile as stored.
 */
export const STAFF_VISIBLE_PROFILE = {
  id: 'enrollment-profile',
  label: 'Enrollment profile (display name, learning goal, pace)',
  reason: 'The profile the learner set up when enrolling; staff who can read the enrollment see it.',
} as const;
export type StaffProfile = { displayName: string; goal: string; pace: string };
/** The enrollment profile `audience` (with `role`, for staff) may read, or null when
 * the role may not read the enrollment. Staff get exactly the three profile fields. */
export function enrollmentProfileFor(audience: LearnerDataAudience, role: string | null | undefined, stored: unknown): Record<string, unknown> | StaffProfile | null {
  const profile = stored && typeof stored === 'object' ? stored as Record<string, unknown> : {};
  if (audience === 'learner') return profile;
  if (!roleCan(role, 'enrollment.read')) return null;
  const text = (value: unknown, fallback: string) => (typeof value === 'string' ? value : fallback);
  return { displayName: text(profile.displayName, 'Learner'), goal: text(profile.goal, ''), pace: text(profile.pace, 'steady') };
}

/** Learner-model fields and sub-routes that belong to the 'learner-model'
 * category. Staff get the evidence-derived understanding only. */
export const LEARNER_MODEL_WITHHELD_FROM_STAFF = ['selfReport', 'suggestions', 'changes', 'history'] as const;

/**
 * Learning-event payloads on staff reads (the enrollment event feed and the workspace audit
 * log). Learner and agent events can carry what the learner wrote or what an agent inferred
 * about them, so staff never read their payloads. Staff and system events show a payload only
 * when their type is in the audit allowlist (workspace-audit.ts AUDIT_PAYLOAD_PROJECTIONS),
 * through its projection; any other type is withheld. The learner reads every payload of their
 * own record. Event identity (type, actor kind, time, correlation) stays visible to both.
 */
export const STAFF_EVENT_PAYLOAD_RULE = {
  id: 'event-payloads',
  label: 'Payloads of learner and agent events, and of staff/system event types outside the audit allowlist',
  reason: 'Event payloads can carry what the learner wrote or what an agent inferred about them.',
} as const;
export function eventPayloadFor(audience: LearnerDataAudience, actorKind: string, type: string, payload: unknown) {
  if (audience === 'learner') return { payload, payloadWithheld: false };
  const projected = auditPayload(actorKind, type, payload);
  return { payload: projected, payloadWithheld: projected === null };
}

/** Whether `audience` may read a category of the learner's own space. */
export function mayRead(audience: LearnerDataAudience, category: WithheldCategory) {
  return audience === 'learner' || !isWithheldFromStaff(category);
}

/**
 * Supervisor run payloads (the debug inspector's run.payload reveal, run-inspector.ts). Run views
 * are metadata only. An owner or admin may reveal one run's payload for a stated reason. The reveal
 * writes an audit receipt on the enrollment's record (run.payload_revealed, so the learner sees who
 * looked) and a copy without learner content in the workspace audit log (run.payload_reveal_audited,
 * kept through erasure), in the same transaction, before anything is returned.
 *
 * What a reveal shows is an allowlist: input references, identifiers, states, counts and the
 * structure of tool arguments, results and stored outputs (for example block kinds and counts).
 * Model- or learner-written prose (plan and proposal summaries, generated teaching text, notes,
 * any other free text) is never shown: only its length and a fingerprint keyed by a secret of that
 * one reveal. Any key outside the allowlist is dropped. Withheld entirely: the companion conversation
 * (companion replies, history reads), the learner model (profile reads, model sources and
 * suggestions, and evidence reads, which show what the learner excluded from AI context) and
 * teaching-hypothesis tool calls. Digests of withheld content are not returned, by the reveal or by a
 * replay, so they cannot confirm a guess.
 */
export const RUN_PAYLOAD_RULE = {
  id: 'run-payloads',
  label: 'Supervisor run payloads',
  reason: 'Owners and admins may reveal a run\'s structure on an audited request. Model-written text is shown only as its length; the companion conversation, the learner model and hypothesis tool text stay withheld.',
  withheld: ['companion', 'learner-model', 'hypothesis-tool-text', 'model-text'],
} as const;
