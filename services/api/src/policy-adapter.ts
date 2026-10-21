import type { CourseManifest, LearningPolicy } from '@course-core/sdk';
import { getEpisodeRequirement } from '@course-core/sdk';
import { checkAction, checkFeasibility, createPolicyState, poolBalances, previewCalendarRule, resolveCalendarWindow, resolveConstraints,
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
const isoInstant = z.iso.datetime({ offset: true });
/** An extension allowance an administrator adds on top of what the course release declares.
 * `shared` is one balance for every scope it covers; `per_scope` gives each scope its own.
 * Units are named: calendar days move a deadline, planned minutes and episodes raise a work
 * cap. A learner may draw from several pools in one request. */
export const extensionPoolConfigSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
  unit: z.enum(['calendar_day', 'planned_minute', 'episode']),
  appliesTo: z.enum(['course', 'every_chapter', 'every_episode']),
  sharing: z.enum(['shared', 'per_scope']),
  total: z.number().int().min(1).max(100_000),
  maxPerGrant: z.number().int().min(1).max(100_000),
  maxGrants: z.number().int().min(1).max(100),
}).refine(pool => pool.maxPerGrant <= pool.total, { message: 'maxPerGrant cannot exceed total', path: ['maxPerGrant'] });
export type ExtensionPoolConfig = z.infer<typeof extensionPoolConfigSchema>;
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
    /** An ultimate ceiling on the course end: no extension, accommodation or exception made
     * at a lower level can move the course past it. */
    ultimateDeadline: isoInstant.nullable().default(null),
  }),
  extensionPools: z.array(extensionPoolConfigSchema).max(10).default([])
    .refine(pools => new Set(pools.map(p => p.id)).size === pools.length, 'Pool names must be unique'),
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
  extensions: { approval: 'learner', offerCooldownHours: 24, maxOutstandingOffersPerScope: 1, maxOffersPerScope: null, ultimateDeadline: null },
  extensionPools: [],
  headroom: { core: { additionalMinutes: 0, additionalEpisodes: 0 }, finalAssessment: { additionalMinutes: 0, additionalEpisodes: 0 } },
  closedQuestionBudget: 20,
  pacing: { minutesPerRequiredEpisode: null, finalAssessmentMinutes: null, studyMinutesPerDay: null },
}) as CoursePolicySettings;
/** Organization ceilings: the outermost policy level, set per workspace. Every level below
 * may only tighten them. Absent ceilings bound nothing (the organization level is then open). */
export const organizationCeilingsSchema = z.strictObject({
  timeZone: ianaZone,
  /** No enrollment in this organization runs past this instant. */
  hardDeadline: isoInstant.nullable(),
  /** The longest any enrollment may run, in calendar days from its start. */
  maxEnrollmentDays: z.number().int().min(1).max(3_660).nullable(),
  work: z.strictObject({
    additionalMinutes: z.number().int().min(0).max(1_000_000).nullable(),
    additionalEpisodes: z.number().int().min(0).max(10_000).nullable(),
    remediationCyclesPerConcept: z.number().int().min(0).max(100).nullable(),
  }),
  /** Off: no course in this organization may offer extensions. */
  extensionsAllowed: z.boolean(),
  /** Whether finished learners keep reading their course material. */
  existingMaterialAccess: z.enum(['read_only', 'closed']),
});
export type OrganizationCeilings = z.infer<typeof organizationCeilingsSchema>;
export const DEFAULT_ORGANIZATION_CEILINGS: OrganizationCeilings = Object.freeze({
  timeZone: 'UTC', hardDeadline: null, maxEnrollmentDays: null,
  work: { additionalMinutes: null, additionalEpisodes: null, remediationCyclesPerConcept: null },
  extensionsAllowed: true, existingMaterialAccess: 'read_only',
}) as OrganizationCeilings;
export async function organizationCeilings(client: Sql, workspaceId: string) {
  const row = (await client.query<{ revision: number; ceilings: unknown; changed_at: Date }>(
    'SELECT revision,ceilings,changed_at FROM organization_policy_ceilings WHERE workspace_id=$1', [workspaceId])).rows[0];
  if (!row) return { source: 'default' as const, revision: 0, ceilings: structuredClone(DEFAULT_ORGANIZATION_CEILINGS), changedAt: null };
  return { source: 'configured' as const, revision: row.revision, ceilings: organizationCeilingsSchema.parse(row.ceilings), changedAt: row.changed_at.toISOString() };
}

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
  const course = await coursePolicySettings(client, row.workspace_id, row.course_key);
  const organization = await organizationCeilings(client, row.workspace_id);
  return { ...course, ceilings: organization.ceilings, ceilingsRevision: organization.revision };
}

/** Time zone of a scope's absolute deadline: its own relative window's zone, else the nearest
 * ancestor window's, else the course setting. Never an implicit server or device zone. */
function deadlineZone(policies: (LearningPolicy | undefined)[], settings: CoursePolicySettings) {
  for (const policy of [...policies].reverse()) if (policy?.window?.timeZone) return policy.window.timeZone;
  return settings.timeZone;
}

/** The organization level of a new enrollment from the workspace's ceilings. */
function organizationScope(ceilings: OrganizationCeilings, settings: CoursePolicySettings, enrollmentId: string, now: string): ScopePolicy {
  const work = Object.fromEntries(Object.entries(ceilings.work).filter(([, v]) => v !== null)) as ScopePolicy['work'];
  const scope: ScopePolicy = { scopeId: 'organization', parentScopeId: null, policyId: 'organization@1', kind: 'organization',
    mode: ceilings.hardDeadline || ceilings.maxEnrollmentDays || Object.keys(work).length ? 'bounded' : 'open_ended',
    work, existingMaterialAccess: ceilings.existingMaterialAccess };
  if (ceilings.hardDeadline) scope.hardDeadline = { at: new Date(ceilings.hardDeadline).toISOString(), timeZone: ceilings.timeZone, disambiguation: settings.hardDeadlineDisambiguation };
  if (ceilings.maxEnrollmentDays) scope.window = resolveCalendarWindow({ anchorId: `enrollment:${enrollmentId}`, anchor: 'enrollment_started', anchorInstant: now,
    calendarDays: ceilings.maxEnrollmentDays, timeZone: ceilings.timeZone, disambiguation: settings.disambiguation, pauseRule: 'never' });
  if (!ceilings.extensionsAllowed) scope.extensions = { enabled: false, learnerAcceptanceRequired: true, poolIds: [], requiredAuthorityIds: [],
    offerCooldownHours: 0, maxOutstandingOffersPerScope: 1, maxOffersPerScope: 1 };
  return scope;
}

/** A new enrollment's policy hierarchy: organization → course → enrollment → chapter → episode.
 * The organization level carries the workspace ceilings, the course level the release's policy
 * and the course settings, and the enrollment level starts empty for this learner's own
 * tighter terms (set later through an audited migration). Each level only tightens its parent. */
export function initialPolicy(course: CourseManifest, enrollmentId: string, learnerId: string, now: string,
  settings: CoursePolicySettings = DEFAULT_COURSE_POLICY_SETTINGS, ceilings: OrganizationCeilings = DEFAULT_ORGANIZATION_CEILINGS): PolicyState {
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
  const organization = organizationScope(ceilings, settings, enrollmentId, now);
  const courseScope = scope(course.policy, [], 'course', 'organization', 'course');
  if (settings.extensions.ultimateDeadline) courseScope.ultimateDeadline = new Date(settings.extensions.ultimateDeadline).toISOString();
  const enrollmentScope: ScopePolicy = { scopeId: 'enrollment', parentScopeId: 'course', policyId: 'enrollment@1', kind: 'enrollment',
    mode: courseScope.mode === 'bounded' || organization.mode === 'bounded' ? 'bounded' : 'open_ended', work: {}, existingMaterialAccess: 'read_only' };
  const scopes = [organization, courseScope, enrollmentScope];
  for (const chapter of course.chapters) {
    const chapterId = `chapter:${chapter.id}`;
    scopes.push(scope(chapter.policy, [course.policy], chapterId, 'enrollment', 'chapter'));
    for (const episode of chapter.episodes) scopes.push(scope(episode.policy, [course.policy, chapter.policy], `episode:${episode.id}`, chapterId, 'episode'));
  }
  addConfiguredPools(scopes, pools, settings);
  const required = coreObjectiveIds(course);
  requireCondition(required.length, 'COURSE_REQUIRED_PATH_MISSING', 409);
  // Reserve core and final-assessment headroom in the course envelope before any enrichment.
  const headroom: { reservationId: string; scopeId: string; purpose: 'core' | 'final_assessment'; work: { additionalMinutes: number; additionalEpisodes: number } }[] = [];
  const caps = course.policy.work ?? {};
  for (const [purpose, amount] of [['core', settings.headroom.core], ['final_assessment', settings.headroom.finalAssessment]] as const) {
    const reserved = { additionalMinutes: caps.additionalMinutes === undefined ? 0 : amount.additionalMinutes, additionalEpisodes: caps.additionalEpisodes === undefined ? 0 : amount.additionalEpisodes };
    // Reserved in the enrollment envelope, so it counts against every organization, course and enrollment cap.
    if (reserved.additionalMinutes || reserved.additionalEpisodes) headroom.push({ reservationId: `headroom:${purpose}`, scopeId: 'enrollment', purpose, work: reserved });
  }
  return createPolicyState({ enrollmentId, learnerId, coreObjectiveIds: required, conceptIds: course.objectives.map(row => row.id), requiredConceptIds: required, scopes, pools,
    headroom, afterClosure: { questionBudget: settings.closedQuestionBudget } });
}

/** Adds administrator-configured allowance pools. A scope the course release explicitly closed
 * to extensions stays closed; a scope with no extension terms of its own gets the course
 * settings' approval, cooldown and offer limits. */
function addConfiguredPools(scopes: ScopePolicy[], pools: PolicyState['pools'], settings: CoursePolicySettings) {
  const limits = settings.extensions;
  for (const config of settings.extensionPools) {
    const covered = scopes.filter(s => config.appliesTo === 'course' ? s.kind === 'course' : config.appliesTo === 'every_chapter' ? s.kind === 'chapter' : s.kind === 'episode')
      .filter(s => s.extensions?.enabled !== false);
    if (!covered.length) continue;
    const groups = config.sharing === 'shared' ? [covered] : covered.map(s => [s]);
    for (const group of groups) {
      const poolId = config.sharing === 'shared' ? `admin:${config.id}` : `admin:${config.id}:${group[0]!.scopeId}`;
      pools.push({ poolId, scopeIds: group.map(s => s.scopeId), unit: config.unit, total: config.total, maxPerGrant: config.maxPerGrant, maxGrants: config.maxGrants });
      for (const scope of group) {
        scope.extensions ??= { enabled: true, learnerAcceptanceRequired: true, poolIds: [],
          requiredAuthorityIds: limits.approval === 'learner_and_admin' ? [ADMIN_APPROVAL] : [],
          offerCooldownHours: limits.offerCooldownHours, maxOutstandingOffersPerScope: limits.maxOutstandingOffersPerScope,
          maxOffersPerScope: limits.maxOffersPerScope ?? Math.max(1, config.maxGrants * 3) };
        scope.extensions.poolIds.push(poolId);
      }
    }
  }
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
  const { settings, revision, ceilings } = await releasePolicySettings(client, releaseId);
  const policy = initialPolicy(course, enrollmentId, learnerId, now, settings, ceilings);
  const feasibility = feasibilityFor(course, policy, settings, now);
  if (!feasibility.feasible && !(options.acceptDocumentedGaps && feasibility.alternatives.includes('continue_with_documented_gaps')))
    throw new ApiError(409, 'ENROLLMENT_INFEASIBLE', 'ENROLLMENT_INFEASIBLE', { issues: feasibility.issues, alternatives: feasibility.alternatives, masteryCriteria: 'unchanged' });
  return { policy, feasibility, settingsRevision: revision };
}

/** Publication refuses a release whose required path cannot fit a learner enrolling now, and
 * previews DST effects of every calendar rule under the configured disambiguation. */
export async function publicationPolicyCheck(client: Sql, releaseId: string, course: CourseManifest, now: string, settingsOverride?: CoursePolicySettings,
  ceilingsOverride?: OrganizationCeilings) {
  const stored = await releasePolicySettings(client, releaseId);
  const settings = settingsOverride ?? stored.settings, ceilings = ceilingsOverride ?? stored.ceilings;
  const policy = initialPolicy(course, '00000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-000000000001', now, settings, ceilings);
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
  const source = (scopeId: string) => scopeId === 'course' ? course.policy : course.chapters.find(c => `chapter:${c.id}` === scopeId)?.policy
    ?? episodes(course).find(e => `episode:${e.id}` === scopeId)?.policy;
  return { feasibility, calendar, settings, ceilings, pools: poolCoverage(policy, id => Boolean(source(id)?.window)) };
}

/** What each configured allowance pool can actually do for a new enrollment: the scopes it
 * covers and, per unit, whether those scopes have something to extend. A day pool on a scope
 * with no deadline, or a minute/episode pool on a scope with no work cap, can never be used. */
export function poolCoverage(policy: PolicyState, deferredWindow: (scopeId: string) => boolean = () => false) {
  return policy.pools.map(pool => {
    const unusable = pool.scopeIds.filter(id => {
      const scope = policy.scopes.find(s => s.scopeId === id)!;
      // A window that starts when the chapter or episode starts is a deadline too, once it starts.
      if (pool.unit === 'calendar_day' || pool.unit === 'scope_calendar_day') return !scope.hardDeadline && !scope.window && !deferredWindow(id);
      return scope.work[pool.unit === 'planned_minute' ? 'additionalMinutes' : 'additionalEpisodes'] === undefined;
    });
    return { poolId: pool.poolId, unit: pool.unit, total: pool.total, maxPerGrant: pool.maxPerGrant, maxGrants: pool.maxGrants,
      scopeIds: pool.scopeIds, unusableScopeIds: unusable, source: pool.poolId.startsWith('admin:') ? 'admin' as const : 'course' as const };
  });
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

/** What an extension request asks for, in named units, and optionally which pools pay. */
export const extensionAmountsSchema = z.strictObject({
  days: z.number().int().min(1).max(366).optional(),
  minutes: z.number().int().min(1).max(100_000).optional(),
  episodes: z.number().int().min(1).max(1_000).optional(),
  poolIds: z.array(z.string().min(1).max(256)).min(1).max(10).optional(),
});
export type ExtensionAmounts = z.infer<typeof extensionAmountsSchema>;
const UNIT_POOLS = { days: ['calendar_day', 'scope_calendar_day'], minutes: ['planned_minute'], episodes: ['episode'] } as const;
/** Turns days, planned minutes and episodes into an exact extension change with one pool debit
 * per unit. Each unit is paid by one pool enabled at this scope: the one the caller names, else
 * the most specific (fewest scopes, then name) that can fund it. The policy still checks every
 * balance, per-grant maximum and ancestor cap, so a request can never overdraw a pool. */
export function extensionRequest(state: PolicyState, scopeId: string, amounts: ExtensionAmounts) {
  const scope = state.scopes.find(row => row.scopeId === scopeId);
  requireCondition(scope, 'UNKNOWN_SCOPE', 404);
  requireCondition(amounts.days || amounts.minutes || amounts.episodes, 'INVALID_REQUEST');
  requireCondition(scope.extensions?.enabled, 'EXTENSIONS_DISABLED', 409);
  const debits: { poolId: string; amount: number }[] = [];
  const balances = new Map(poolBalances(state).map(b => [b.poolId, b]));
  for (const unit of ['days', 'minutes', 'episodes'] as const) {
    const amount = amounts[unit];
    if (!amount) continue;
    const candidates = state.pools
      .filter(p => scope.extensions!.poolIds.includes(p.poolId) && (UNIT_POOLS[unit] as readonly string[]).includes(p.unit) && (!amounts.poolIds || amounts.poolIds.includes(p.poolId)))
      .sort((a, b) => a.scopeIds.length - b.scopeIds.length || (a.poolId < b.poolId ? -1 : a.poolId > b.poolId ? 1 : 0));
    requireCondition(candidates.length, unit === 'days' ? 'EXTENSIONS_DISABLED' : 'NO_POOL_FOR_UNIT', 409);
    const funded = candidates.find(p => { const b = balances.get(p.poolId)!; return amount <= p.maxPerGrant && amount <= b.remaining && b.grantsRemaining > 0; });
    // None can fund it: let the policy explain why with the first candidate's limits.
    debits.push({ poolId: (funded ?? candidates[0]!).poolId, amount });
  }
  if (amounts.days) requireCondition(scope.window || scope.hardDeadline, 'NO_DEADLINE_TO_EXTEND', 409);
  const work = { ...(amounts.minutes ? { additionalMinutes: amounts.minutes } : {}), ...(amounts.episodes ? { additionalEpisodes: amounts.episodes } : {}) };
  return { scopeId, change: { ...(amounts.days ? { deadline: { kind: scope.window ? 'window' as const : 'absolute' as const, calendarDays: amounts.days } } : {}),
    ...(Object.keys(work).length ? { work } : {}) },
    addedWork: { additionalMinutes: 0, additionalEpisodes: 0, remediation: [] }, poolDebits: debits };
}
