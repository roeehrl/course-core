import type { CourseManifest, LearningPolicy } from '@course-core/sdk';
import { checkAction, createPolicyState, resolveCalendarWindow, resolveConstraints, type PolicyState, type ScopePolicy } from '@course-core/policy';
import type { PoolClient } from 'pg';
import { ApiError, requireCondition } from './errors.js';
import { coreObjectiveIds } from './learning.js';

export function initialPolicy(course: CourseManifest, enrollmentId: string, learnerId: string, now: string): PolicyState {
  const pools: PolicyState['pools'] = [];
  function scope(policy: LearningPolicy | undefined, id: string, parent: string | null, kind: ScopePolicy['kind']): ScopePolicy {
    const p = policy ?? { mode: 'open_ended' as const, existingMaterialAccess: 'read_only' as const };
    const value: ScopePolicy = { scopeId: id, parentScopeId: parent, policyId: `${id}@1`, kind, mode: p.mode, work: p.work ?? {}, existingMaterialAccess: p.existingMaterialAccess };
    if (p.targetDate) value.targetDate = p.targetDate;
    if (p.hardDeadline) value.hardDeadline = { at: p.hardDeadline, timeZone: 'UTC', disambiguation: 'reject' };
    if (p.window) {
      // Scope-start windows are anchored on activation, never reset by a reload.
      if (kind === 'course' || p.window.anchor === 'enrollment_started') {
        value.window = resolveCalendarWindow({ ...p.window, anchorId: p.window.anchor === 'enrollment_started' ? `enrollment:${enrollmentId}` : `course:${enrollmentId}:${p.window.anchor}`, anchorInstant: now, disambiguation: 'compatible' });
      } else if (!p.hardDeadline && !p.work) value.mode = 'open_ended';
    }
    if (p.extensions?.enabled) {
      const poolId = `${id}:calendar`;
      pools.push({ poolId, scopeIds: [id], unit: 'calendar_day', total: p.extensions.calendarDays, maxGrants: p.extensions.maxGrants, maxPerGrant: p.extensions.maxDaysPerGrant });
      value.extensions = { enabled: true, learnerAcceptanceRequired: true, poolIds: [poolId], requiredAuthorityIds: [], offerCooldownHours: 24, maxOutstandingOffersPerScope: 1, maxOffersPerScope: Math.max(1, p.extensions.maxGrants * 3) };
    }
    return value;
  }
  const scopes = [scope(course.policy, 'course', null, 'course')];
  for (const chapter of course.chapters) {
    const chapterId = `chapter:${chapter.id}`;
    scopes.push(scope(chapter.policy, chapterId, 'course', 'chapter'));
    for (const episode of chapter.episodes) scopes.push(scope(episode.policy, `episode:${episode.id}`, chapterId, 'episode'));
  }
  const required = coreObjectiveIds(course);
  requireCondition(required.length, 'COURSE_REQUIRED_PATH_MISSING', 409);
  return createPolicyState({ enrollmentId, learnerId, coreObjectiveIds: required, conceptIds: course.objectives.map(row => row.id), requiredConceptIds: required, scopes, pools });
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
      value.window = resolveCalendarWindow({ ...policy.window, anchorId: `${enrollmentId}:${id}:${policy.window.anchor}`, anchorInstant: now, disambiguation: 'compatible' });
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
