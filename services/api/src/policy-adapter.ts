import type { CourseManifest, LearningPolicy } from '@course-core/sdk';
import { getEpisodeRequirement } from '@course-core/sdk';
import { checkAction, checkFeasibility, createPolicyState, previewCalendarRule, resolveCalendarWindow, resolveConstraints,
  type PolicyState, type ScopePolicy } from '@course-core/policy';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { ApiError, requireCondition } from './errors.js';
import { coreObjectiveIds, episodes } from './learning.js';
import type { Database } from './database.js';
import { policyEpisodeIdFor, type Enrollment } from './repository.js';

/** Host policy settings a release cannot author with SDK 0.5: the hard-deadline time zone,
 * DST disambiguation, extension approvals and offer limits, reserved core headroom, the
 * closed-course question budget and an optional study pace. A course row may override these
 * documented defaults; a new enrollment copies the values in force when it starts. */
const work = z.strictObject({ additionalMinutes: z.number().int().min(0).max(100_000), additionalEpisodes: z.number().int().min(0).max(1_000) });
const ianaZone = z.string().min(1).max(64).refine(zone => {
  if (/^[+\-\u2212]/u.test(zone)) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: zone }).format(0); return true; } catch { return false; }
}, 'Expected an IANA time zone');
export const coursePolicySettingsSchema = z.strictObject({
  timeZone: ianaZone,
  /** Relative windows (durations from an anchor). */
  disambiguation: z.enum(['reject', 'earlier', 'later', 'compatible']),
  /** Absolute hard deadlines and their extensions: a hard deadline never silently lands on a
   * shifted local time unless an administrator opts into another resolution. */
  hardDeadlineDisambiguation: z.enum(['reject', 'earlier', 'later', 'compatible']),
  extensions: z.strictObject({
    approval: z.enum(['learner', 'learner_and_admin']),
    offerCooldownHours: z.number().int().min(0).max(720),
    maxOutstandingOffersPerScope: z.number().int().min(1).max(10),
    maxOffersPerScope: z.number().int().min(1).max(100).nullable(),
  }),
  headroom: z.strictObject({ core: work, finalAssessment: work }),
  closedQuestionBudget: z.number().int().min(0).max(1_000),
  pacing: z.strictObject({
    minutesPerRequiredEpisode: z.number().int().min(1).max(1_440).nullable(),
    finalAssessmentMinutes: z.number().int().min(1).max(1_440).nullable(),
    studyMinutesPerDay: z.number().int().min(1).max(1_440).nullable(),
  }),
});
export type CoursePolicySettings = z.infer<typeof coursePolicySettingsSchema>;
export const DEFAULT_COURSE_POLICY_SETTINGS: CoursePolicySettings = Object.freeze({
  timeZone: 'UTC', disambiguation: 'compatible', hardDeadlineDisambiguation: 'reject',
  extensions: { approval: 'learner', offerCooldownHours: 24, maxOutstandingOffersPerScope: 1, maxOffersPerScope: null },
  headroom: { core: { additionalMinutes: 0, additionalEpisodes: 0 }, finalAssessment: { additionalMinutes: 0, additionalEpisodes: 0 } },
  closedQuestionBudget: 20,
  pacing: { minutesPerRequiredEpisode: null, finalAssessmentMinutes: null, studyMinutesPerDay: null },
}) as CoursePolicySettings;
/** The authority token an admin approval carries. The approving staff member is recorded on the audit event. */
export const ADMIN_APPROVAL = 'role:admin';

type Sql = Pick<PoolClient, 'query'> | Pick<Database, 'query'>;
export async function coursePolicySettings(client: Sql, workspaceId: string, courseKey: string) {
  const row = (await client.query<{ catalog_id: string; revision: number; settings: unknown; changed_at: Date }>(`SELECT s.catalog_id,s.revision,s.settings,s.changed_at
    FROM course_policy_settings s JOIN admin_course_catalog c ON c.id=s.catalog_id WHERE c.workspace_id=$1 AND c.course_key=$2`, [workspaceId, courseKey])).rows[0];
  if (!row) return { source: 'default' as const, revision: 0, settings: structuredClone(DEFAULT_COURSE_POLICY_SETTINGS), changedAt: null };
  return { source: 'configured' as const, revision: row.revision, settings: coursePolicySettingsSchema.parse(row.settings), changedAt: row.changed_at.toISOString() };
}
export async function releasePolicySettings(client: Sql, releaseId: string) {
  const row = (await client.query<{ workspace_id: string; course_key: string }>('SELECT workspace_id,course_key FROM course_releases WHERE id=$1', [releaseId])).rows[0];
  requireCondition(row, 'RELEASE_NOT_FOUND', 404);
  return coursePolicySettings(client, row.workspace_id, row.course_key);
}

/** Time zone of a scope's absolute deadline: its own relative window's zone, else the nearest
 * ancestor window's, else the course setting. Never an implicit server or device zone. */
function deadlineZone(policies: (LearningPolicy | undefined)[], settings: CoursePolicySettings) {
  for (const policy of [...policies].reverse()) if (policy?.window?.timeZone) return policy.window.timeZone;
  return settings.timeZone;
}

export function initialPolicy(course: CourseManifest, enrollmentId: string, learnerId: string, now: string,
  settings: CoursePolicySettings = DEFAULT_COURSE_POLICY_SETTINGS): PolicyState {
  const pools: PolicyState['pools'] = [];
  function scope(policy: LearningPolicy | undefined, ancestors: (LearningPolicy | undefined)[], id: string, parent: string | null, kind: ScopePolicy['kind']): ScopePolicy {
    const p = policy ?? { mode: 'open_ended' as const, existingMaterialAccess: 'read_only' as const };
    const value: ScopePolicy = { scopeId: id, parentScopeId: parent, policyId: `${id}@1`, kind, mode: p.mode, work: p.work ?? {}, existingMaterialAccess: p.existingMaterialAccess };
    if (p.targetDate) value.targetDate = p.targetDate;
    if (p.hardDeadline) value.hardDeadline = { at: p.hardDeadline, timeZone: deadlineZone([...ancestors, policy], settings), disambiguation: settings.hardDeadlineDisambiguation };
    if (p.window) {
      // Scope-start windows are anchored on activation, never reset by a reload.
      if (kind === 'course' || p.window.anchor === 'enrollment_started') {
        value.window = resolveCalendarWindow({ ...p.window, anchorId: p.window.anchor === 'enrollment_started' ? `enrollment:${enrollmentId}` : `course:${enrollmentId}:${p.window.anchor}`, anchorInstant: now, disambiguation: settings.disambiguation });
      } else if (!p.hardDeadline && !p.work) value.mode = 'open_ended';
    }
    if (p.extensions?.enabled) {
      const poolId = `${id}:calendar`, limits = settings.extensions;
      pools.push({ poolId, scopeIds: [id], unit: 'calendar_day', total: p.extensions.calendarDays, maxGrants: p.extensions.maxGrants, maxPerGrant: p.extensions.maxDaysPerGrant });
      value.extensions = { enabled: true, learnerAcceptanceRequired: true, poolIds: [poolId],
        requiredAuthorityIds: limits.approval === 'learner_and_admin' ? [ADMIN_APPROVAL] : [],
        offerCooldownHours: limits.offerCooldownHours, maxOutstandingOffersPerScope: limits.maxOutstandingOffersPerScope,
        maxOffersPerScope: limits.maxOffersPerScope ?? Math.max(1, p.extensions.maxGrants * 3) };
    }
    return value;
  }
  const scopes = [scope(course.policy, [], 'course', null, 'course')];
  for (const chapter of course.chapters) {
    const chapterId = `chapter:${chapter.id}`;
    scopes.push(scope(chapter.policy, [course.policy], chapterId, 'course', 'chapter'));
    for (const episode of chapter.episodes) scopes.push(scope(episode.policy, [course.policy, chapter.policy], `episode:${episode.id}`, chapterId, 'episode'));
  }
  const required = coreObjectiveIds(course);
  requireCondition(required.length, 'COURSE_REQUIRED_PATH_MISSING', 409);
  // Reserve core and final-assessment headroom in the course envelope before any enrichment.
  const headroom: { reservationId: string; scopeId: string; purpose: 'core' | 'final_assessment'; work: { additionalMinutes: number; additionalEpisodes: number } }[] = [];
  const caps = course.policy.work ?? {};
  for (const [purpose, amount] of [['core', settings.headroom.core], ['final_assessment', settings.headroom.finalAssessment]] as const) {
    const reserved = { additionalMinutes: caps.additionalMinutes === undefined ? 0 : amount.additionalMinutes, additionalEpisodes: caps.additionalEpisodes === undefined ? 0 : amount.additionalEpisodes };
    if (reserved.additionalMinutes || reserved.additionalEpisodes) headroom.push({ reservationId: `headroom:${purpose}`, scopeId: 'course', purpose, work: reserved });
  }
  return createPolicyState({ enrollmentId, learnerId, coreObjectiveIds: required, conceptIds: course.objectives.map(row => row.id), requiredConceptIds: required, scopes, pools,
    headroom, afterClosure: { questionBudget: settings.closedQuestionBudget } });
}

/** The fixed core path and final assessment a feasibility check must fit. */
export function requiredWork(course: CourseManifest, settings: CoursePolicySettings) {
  const required = episodes(course).filter(episode => getEpisodeRequirement(episode) === 'required');
  const estimate = settings.pacing.minutesPerRequiredEpisode ?? undefined, finalEstimate = settings.pacing.finalAssessmentMinutes ?? undefined;
  const items: { workId: string; scopeId: string; purpose: 'core' | 'final_assessment'; estimatedMinutes?: number }[] = required.map(episode => ({
    workId: `episode:${episode.id}`, scopeId: `episode:${episode.id}`, purpose: 'core' as const, ...(estimate === undefined ? {} : { estimatedMinutes: estimate }) }));
  const last = required.at(-1);
  if (last?.gateId) items.push({ workId: `gate:${last.gateId}`, scopeId: `episode:${last.id}`, purpose: 'final_assessment', ...(finalEstimate === undefined ? {} : { estimatedMinutes: finalEstimate }) });
  return items;
}
export function feasibilityFor(course: CourseManifest, policy: PolicyState, settings: CoursePolicySettings, now: string) {
  return checkFeasibility(policy, { now, requiredWork: requiredWork(course, settings),
    ...(settings.pacing.studyMinutesPerDay ? { pace: { studyMinutesPerDay: settings.pacing.studyMinutesPerDay } } : {}) });
}

/** A new enrollment's policy, refused with the disclosed issues and alternatives when the
 * required core path and final assessment cannot fit. A learner may knowingly continue with
 * documented gaps only while no binding deadline has already passed. */
export async function enrollmentPolicy(client: Sql, releaseId: string, course: CourseManifest, enrollmentId: string, learnerId: string, now: string,
  options: { acceptDocumentedGaps?: boolean } = {}) {
  const { settings, revision } = await releasePolicySettings(client, releaseId);
  const policy = initialPolicy(course, enrollmentId, learnerId, now, settings);
  const feasibility = feasibilityFor(course, policy, settings, now);
  if (!feasibility.feasible && !(options.acceptDocumentedGaps && feasibility.alternatives.includes('continue_with_documented_gaps')))
    throw new ApiError(409, 'ENROLLMENT_INFEASIBLE', 'ENROLLMENT_INFEASIBLE', { issues: feasibility.issues, alternatives: feasibility.alternatives, masteryCriteria: 'unchanged' });
  return { policy, feasibility, settingsRevision: revision };
}

/** Publication refuses a release whose required path cannot fit a learner enrolling now, and
 * previews DST effects of every calendar rule under the configured disambiguation. */
export async function publicationPolicyCheck(client: Sql, releaseId: string, course: CourseManifest, now: string, settingsOverride?: CoursePolicySettings) {
  const settings = settingsOverride ?? (await releasePolicySettings(client, releaseId)).settings;
  const policy = initialPolicy(course, '00000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-000000000001', now, settings);
  const feasibility = feasibilityFor(course, policy, settings, now);
  const until = new Date(Date.parse(now) + 400 * 86_400_000).toISOString();
  const calendar = policy.scopes.flatMap(scope => {
    const source = scope.scopeId === 'course' ? course.policy : course.chapters.find(c => `chapter:${c.id}` === scope.scopeId)?.policy
      ?? episodes(course).find(e => `episode:${e.id}` === scope.scopeId)?.policy;
    const rows = [];
    if (source?.window) rows.push({ scopeId: scope.scopeId, rule: 'window' as const, ...previewCalendarRule({ timeZone: source.window.timeZone, calendarDays: source.window.calendarDays,
      disambiguation: settings.disambiguation, from: now, until }) });
    if (scope.hardDeadline) {
      const pool = policy.pools.find(p => scope.extensions?.poolIds.includes(p.poolId));
      rows.push({ scopeId: scope.scopeId, rule: 'absolute' as const, ...previewCalendarRule({ timeZone: scope.hardDeadline.timeZone, calendarDays: 0,
        disambiguation: settings.hardDeadlineDisambiguation, from: now, until, absoluteAt: scope.hardDeadline.at, maxExtensionDays: pool?.maxPerGrant ?? 0 }) });
    }
    return rows;
  });
  return { feasibility, calendar, settings };
}
export async function assertPublishable(client: Sql, releaseId: string, course: CourseManifest, now = new Date().toISOString()) {
  const check = await publicationPolicyCheck(client, releaseId, course, now);
  if (!check.feasibility.feasible) throw new ApiError(409, 'PUBLISH_INFEASIBLE', 'PUBLISH_INFEASIBLE',
    { issues: check.feasibility.issues, alternatives: check.feasibility.alternatives, masteryCriteria: 'unchanged' });
  return check;
}

export async function loadPolicy(client: PoolClient, enrollmentId: string): Promise<PolicyState> {
  const row = (await client.query<{ snapshot: PolicyState }>('SELECT snapshot FROM policy_states WHERE enrollment_id=$1', [enrollmentId])).rows[0];
  requireCondition(row, 'POLICY_STATE_MISSING', 500);
  return row.snapshot;
}

export async function assertPolicyAction(client: PoolClient, enrollmentId: string, episodeId: string, kind: 'submit' | 'plan' | 'read', now: string) {
  const state = await loadPolicy(client, enrollmentId);
  const result = checkAction(state, { scopeId: `episode:${episodeId}`, kind, now, expectedPolicyRevision: state.policyRevision });
  if (!result.allowed) throw new ApiError(409, result.violations[0]!.code);
  return result.snapshot;
}

export async function activateWindows(client: PoolClient, course: CourseManifest, enrollmentId: string, episodeId: string, now: string, trigger: 'scope_started' | 'scope_assigned' = 'scope_started') {
  const state = await loadPolicy(client, enrollmentId);
  const chapter = course.chapters.find(row => row.episodes.some(episode => episode.id === episodeId))!;
  const episode = chapter.episodes.find(row => row.id === episodeId)!;
  let changed = false;
  for (const [id, policy] of [[`chapter:${chapter.id}`, chapter.policy], [`episode:${episodeId}`, episode.policy]] as const) {
    const value = state.scopes.find(row => row.scopeId === id)!;
    if (policy?.window && policy.window.anchor === trigger && !value.window) {
      // A window activated later uses the rule this enrollment already resolves windows with
      // (the course setting at enrollment), so one enrollment never mixes rules.
      const disambiguation = state.scopes.find(row => row.window)?.window?.disambiguation
        ?? (await releasePolicySettingsForEnrollment(client, enrollmentId)).disambiguation;
      value.window = resolveCalendarWindow({ ...policy.window, anchorId: `${enrollmentId}:${id}:${policy.window.anchor}`, anchorInstant: now, disambiguation });
      value.mode = policy.mode;
      await client.query('INSERT INTO scope_anchors (enrollment_id,scope_id,anchor_kind,anchored_at,resolved_deadline) VALUES ($1,$2,$3,$4,$5)', [enrollmentId, id, trigger, now, value.window.resolvedDeadline]);
      changed = true;
    }
  }
  if (changed) {
    state.policyRevision += 1;
    // Validate the entire persisted state before writing it.
    resolveConstraints(state, `episode:${episodeId}`);
    await client.query('UPDATE policy_states SET policy_revision=$2,snapshot=$3,updated_at=now() WHERE enrollment_id=$1', [enrollmentId, state.policyRevision, JSON.stringify(state)]);
    await client.query('UPDATE enrollments SET policy_revision=$2 WHERE id=$1', [enrollmentId, state.policyRevision]);
  }
  return state;
}

async function releasePolicySettingsForEnrollment(client: PoolClient, enrollmentId: string) {
  const row = (await client.query<{ course_release_id: string }>('SELECT course_release_id FROM enrollments WHERE id=$1', [enrollmentId])).rows[0];
  requireCondition(row, 'ENROLLMENT_NOT_FOUND', 404);
  return (await releasePolicySettings(client, row.course_release_id)).settings;
}

/** Grading an on-time submission may finish after the cutoff or after closure (P08). It
 * records evidence without reopening the enrollment; a late submission is never graded. */
export async function assertGradeAllowed(client: PoolClient, input: { enrollmentId: string; attemptId: string; episodeId: string; submittedAt: Date | string }, now: string) {
  const enrollment = (await client.query<Enrollment>('SELECT * FROM enrollments WHERE id=$1', [input.enrollmentId])).rows[0];
  requireCondition(enrollment, 'ENROLLMENT_NOT_FOUND', 404);
  const state = await loadPolicy(client, input.enrollmentId), scopeId = `episode:${await policyEpisodeIdFor(client, enrollment, input.episodeId)}`;
  const submittedAt = new Date(input.submittedAt).toISOString();
  const result = checkAction(state, { scopeId, kind: 'grade', now, expectedPolicyRevision: state.policyRevision,
    submissionReceipt: { receiptId: input.attemptId, enrollmentId: input.enrollmentId, scopeId, attemptId: input.attemptId, submittedAt, eligible: true, policyRevision: state.policyRevision } });
  if (!result.allowed) throw new ApiError(409, result.violations[0]!.code);
  return result.snapshot;
}
