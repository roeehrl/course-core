/**
 * Moving enrolled learners to a newer version of their course (requirement K13).
 *
 * A learner normally stays on the release they enrolled in: publishing a new version changes what
 * new learners get, never existing ones (publishImpact, release-editing.ts). Staff can move one
 * learner, or everyone active or paused on one version, to a newer published version of the same
 * course. The rules:
 *
 * - Preview first. The preview runs the learner engine (learningSnapshot) on each learner's own
 *   progress and evidence against both versions and says, per learner, which completed lessons
 *   stay completed, which checkpoints must be passed again, which lessons are no longer in the
 *   course, which are new, how much evidence stays behind with the old version, what work is
 *   open, and what happens to their deadlines and limits. Confirming needs the digest of exactly
 *   that preview, a reason, and an explicit acknowledgement when anyone loses credit.
 * - Evidence stays bound to the version it was earned on. Attempts, evidence, progress rows, gate
 *   decisions and activity state are never rewritten; the new version's checkpoints count only
 *   evidence earned on it, so a passed checkpoint whose evidence belongs to the old version must
 *   be passed again (the lessons after it count again once it is). Except: a passed checkpoint
 *   whose rules, items, answer keys or rubrics, and evaluators are byte-identical in both versions
 *   carries over (carried-checkpoints.ts); the preview says, per checkpoint, which carry and why.
 * - Policy: every existing scope, anchor, deadline, grant and ledger entry is kept unchanged. The
 *   new version's added chapters and lessons get scopes of their own through the policy package's
 *   reviewed migration (applyPolicyChange, the same transition the cohort policy migration uses),
 *   so nothing is reset or silently shortened. Their extension terms are not carried: an
 *   allowance pool belongs to the scopes it was created for.
 * - Unsafe moves are refused, with a code: an enrollment that is not active or paused, a learner
 *   already enrolled in the target version, personal changes (they are built on the old version
 *   and cannot follow it; the learner is offered the move instead, see below), a learner in a research study (the study is of one release), a move
 *   already waiting, or a policy the package refuses. The target must be a newer, published,
 *   runnable version of the same course.
 * - Safe boundary: a learner with a question open, an activity being worked on (changed in the
 *   last ten minutes), a placement run in progress or the AI supervisor mid-run is not moved
 *   then. Their move waits and is retried (runWaitingMoves) until they reach a boundary, as long as
 *   what it costs them is unchanged; otherwise, or after seven days, it is cancelled with a code.
 * - Undo, where safe: a moved learner goes back to the version they came from only while they
 *   have done nothing on the new one (the enrollment revision is the one the move left) and are
 *   not enrolled in the old version again. Scopes the move added stay in their policy: they govern
 *   lessons the old version does not have, so they are inert there.
 * - Personal changes: a learner who has them is refused, and offered the move in the app ("moving
 *   keeps your progress where it can, but drops your personal changes"). Accepting makes the move
 *   wait for a safe boundary like any other; declining keeps them where they are. An owner or admin
 *   may force the move for a learner who did not accept, with a reason. Either way the personal
 *   changes are archived, not lost (personal_change_archives, still in the learner's record and
 *   export), the learner is told, and an undo restores them.
 * - Every confirmation, move, undo, cancellation, offer decision and forced move is audited
 *   (workspace audit log and the learner's own record).
 */
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { applyPolicyChange, previewPolicyChange, validateScopePolicy, type PolicyState, type ScopePolicy } from '@course-core/policy';
import type { CourseManifest } from '@course-core/sdk';
import { transaction, type Database } from './database.js';
import { ApiError, requireCondition } from './errors.js';
import { appendEvent } from './events.js';
import { compareSemver, isSemver } from './course-package.js';
import { episodes, learningSnapshot, type EvidenceRow, type ProgressRow } from './learning.js';
import { attemptSignals, digestJson } from './repository.js';
import { releaseDiff } from './release-safety.js';
import { initialPolicy, loadPolicy, releasePolicySettings } from './policy-adapter.js';
import { savePolicy } from './admin-routes.js';
import { notifyUser } from './notifications.js';
import { resolveRole, roleCan } from './course-access.js';
import { assertCourseRunnable, prepareCourseRunnable, type RuntimeExtension } from './publication.js';
import { effectiveDigestSql, planCarryOver, withCarried, type AttemptProvenance, type CarryCode } from './carried-checkpoints.js';

type Sql = Database | PoolClient;
export const MOVE_COHORT_LIMIT = 500;
export const MOVE_PREVIEW_MINUTES = 15;
export const MOVE_WAIT_DAYS = 7;
/** Lists in a learner's preview are cut at this length; their counts are always exact. */
const LIST_LIMIT = 50;
const MOVABLE = ['active', 'paused'];

export interface MoveRelease { id: string; workspace_id: string; course_key: string; version: string; status: string; digest: string; server_bundle: CourseManifest; created_at: Date }
interface EnrollmentRow { id: string; user_id: string; status: string; revision: number; started_at: Date; current_episode_id: string | null; course_release_id: string; policy: unknown }
export type RefusalCode = 'MOVE_ENROLLMENT_NOT_ACTIVE' | 'MOVE_ALREADY_ON_TARGET' | 'MOVE_PERSONAL_CHANGES' | 'MOVE_IN_STUDY' | 'MOVE_ALREADY_WAITING'
  | 'MOVE_POLICY_REFUSED' | 'MOVE_SHORTENS_GRANTS';
export type WaitCode = 'ATTEMPT_IN_PROGRESS' | 'ACTIVITY_IN_PROGRESS' | 'PLACEMENT_IN_PROGRESS' | 'SUPERVISOR_WORKING';
export interface Lesson { id: string; title: string }
const list = (items: Lesson[]) => ({ count: items.length, items: items.slice(0, LIST_LIMIT) });
export interface LearnerImpact {
  enrollmentId: string;
  status: string;
  outcome: 'ready' | 'waits' | 'refused';
  refusal: RefusalCode | null;
  /** The policy package's own code when it refused the policy change. */
  policyCode: string | null;
  wait: WaitCode | null;
  progress: {
    completeBefore: boolean; completeAfter: boolean;
    creditedBefore: number; creditedAfter: number;
    /** Completed or placed lessons that stay so. */
    kept: number;
    /** Completed lessons whose content the new version changed; they stay completed. */
    changedKept: ReturnType<typeof list>;
    /** Lessons whose checkpoint must be passed again: its evidence belongs to the old version. */
    checkpointsAgain: ReturnType<typeof list>;
    /** Completed lessons that count again once the checkpoints before them are passed again. */
    onHold: ReturnType<typeof list>;
    /** Lessons the learner completed or started that the new version no longer has. */
    removed: ReturnType<typeof list>;
    nextBefore: Lesson | null; nextAfter: Lesson | null;
  };
  evidence: { records: number };
  openWork: { questions: number; activities: number };
  personalChanges: number;
  policy: { addedScopes: string[]; keptScopes: number };
  /** Checkpoints passed on the old version: which carry over unchanged, and why the others do not. */
  carryOver: { carried: ReturnType<typeof gateList>; notCarried: ReturnType<typeof gateList> };
  /** The personal changes a move would drop (lesson and kind), for the learner's offer. */
  personalChangeList: ReturnType<typeof changeList>;
  /** The move drops the learner's personal changes (they accepted it, or staff forced it). */
  dropsPersonalChanges: boolean;
  /** What the move costs this learner; a waiting move proceeds only while it is unchanged. */
  costDigest: string;
}
export interface CheckpointLine extends Lesson { gateId: string; code: CarryCode; items: number }
const gateList = (items: CheckpointLine[]) => ({ count: items.length, items: items.slice(0, LIST_LIMIT) });
export interface PersonalChangeLine { episodeId: string; title: string; kind: string }
const changeList = (items: PersonalChangeLine[]) => ({ count: items.length, items: items.slice(0, 20) });

/** The personal changes a learner has on their current version: live applied changes (one line per
 * operation) and changes waiting for a safe boundary. Lesson ids, titles and kinds only. */
export async function personalChangeLines(client: Sql, enrollmentId: string, release: { id: string; server_bundle: CourseManifest }): Promise<PersonalChangeLine[]> {
  const titles = new Map(episodes(release.server_bundle).map(e => [e.id, e.title.slice(0, 200)]));
  const applied = (await client.query<{ operations: { type: string; episodeId?: string; artifactId?: string }[] | null; artifacts: { id: string; title?: string }[] | null }>(
    `SELECT p.body->'operations' AS operations,p.body->'artifacts' AS artifacts FROM adaptation_applications x
       JOIN adaptation_proposals p ON p.id=x.proposal_id AND p.enrollment_id=x.enrollment_id
      WHERE x.enrollment_id=$1 AND p.course_release_id=$2
        AND NOT EXISTS(SELECT 1 FROM adaptation_reverts r WHERE r.enrollment_id=x.enrollment_id AND r.proposal_id=x.proposal_id)
      ORDER BY x.plan_revision LIMIT 200`, [enrollmentId, release.id])).rows;
  const lines: PersonalChangeLine[] = [];
  for (const row of applied) for (const op of row.operations ?? []) {
    const episodeId = op.type === 'insert_episode' ? op.artifactId ?? '' : op.episodeId ?? '';
    const added = op.type === 'insert_episode' ? (row.artifacts ?? []).find(a => a.id === op.artifactId)?.title : undefined;
    lines.push({ episodeId, title: (titles.get(episodeId) ?? added ?? episodeId).slice(0, 200), kind: op.type.slice(0, 64) });
  }
  const pending = (await client.query<{ episode_id: string; artifact_kind: string }>(
    "SELECT episode_id,artifact_kind FROM adaptation_pending_changes WHERE enrollment_id=$1 AND status='waiting' ORDER BY created_at LIMIT 50", [enrollmentId])).rows;
  for (const row of pending) lines.push({ episodeId: row.episode_id, title: titles.get(row.episode_id) ?? row.episode_id, kind: `waiting_${row.artifact_kind}` });
  return lines;
}

/** A release of the catalog's course, or 404. */
export async function moveRelease(client: Sql, catalog: { workspace_id: string; course_key: string }, releaseId: string): Promise<MoveRelease> {
  const row = (await client.query<MoveRelease>('SELECT id,workspace_id,course_key,version,status,digest,server_bundle,created_at FROM course_releases WHERE id=$1 AND workspace_id=$2 AND course_key=$3',
    [releaseId, catalog.workspace_id, catalog.course_key])).rows[0];
  requireCondition(row, 'RELEASE_NOT_FOUND', 404);
  return row;
}

/** Refuses a target that is not a newer, published, runnable version of the same course. */
export async function assertMoveTarget(from: MoveRelease, to: MoveRelease, installed: RuntimeExtension[]) {
  requireCondition(from.id !== to.id, 'MOVE_SAME_VERSION', 409);
  requireCondition(to.status === 'published', 'MOVE_TARGET_NOT_PUBLISHED', 409);
  if (!isSemver(to.version) || !isSemver(from.version) || compareSemver(to.version, from.version) <= 0)
    throw new ApiError(409, 'MOVE_TARGET_NOT_NEWER', 'MOVE_TARGET_NOT_NEWER', { from: from.version.slice(0, 128), to: to.version.slice(0, 128) });
  try {
    await prepareCourseRunnable(to.server_bundle, installed);
    assertCourseRunnable(to.server_bundle, installed);
  } catch (error) {
    if (error instanceof ApiError) throw new ApiError(409, 'MOVE_TARGET_NOT_RUNNABLE', 'MOVE_TARGET_NOT_RUNNABLE', { reason: error.code });
    throw error;
  }
}

/** The scopes the learner's policy has after the move: all of today's, unchanged, plus one for
 * each chapter and lesson the new version adds (anchored at the learner's own enrollment start). */
function movedScopes(state: PolicyState, to: MoveRelease, enrollment: EnrollmentRow, settings: Awaited<ReturnType<typeof releasePolicySettings>>): { scopes: ScopePolicy[]; added: string[] } {
  const fresh = initialPolicy(to.server_bundle, enrollment.id, enrollment.user_id, new Date(enrollment.started_at).toISOString(), settings.settings, settings.ceilings);
  const existing = new Set(state.scopes.map(scope => scope.scopeId));
  const added = fresh.scopes.filter(scope => !existing.has(scope.scopeId)).map(scope => {
    const { extensions: _pooled, ...rest } = scope;
    return validateScopePolicy(rest);
  });
  return { scopes: [...structuredClone(state.scopes), ...added], added: added.map(scope => scope.scopeId) };
}

/** Whether the learner is at a safe boundary for the whole course, or what they are in the middle of. */
export async function moveBoundary(client: Sql, enrollmentId: string): Promise<WaitCode | null> {
  const row = (await client.query<{ question: boolean; activity: boolean; placement: boolean; supervisor: boolean }>(`SELECT
      EXISTS(SELECT 1 FROM assessment_challenges WHERE enrollment_id=$1 AND attempt_id IS NULL AND expires_at>clock_timestamp()) AS question,
      EXISTS(SELECT 1 FROM activity_instances WHERE enrollment_id=$1 AND satisfied_at IS NULL AND state_revision>1 AND updated_at>clock_timestamp()-interval '10 minutes') AS activity,
      EXISTS(SELECT 1 FROM placement_runs WHERE enrollment_id=$1 AND state='in_progress') AS placement,
      EXISTS(SELECT 1 FROM supervisor_jobs WHERE enrollment_id=$1 AND state IN ('running','verifying')) AS supervisor`, [enrollmentId])).rows[0]!;
  return row.question ? 'ATTEMPT_IN_PROGRESS' : row.activity ? 'ACTIVITY_IN_PROGRESS' : row.placement ? 'PLACEMENT_IN_PROGRESS' : row.supervisor ? 'SUPERVISOR_WORKING' : null;
}

type MoveContext = { changedEpisodes: Set<string>; settings: Awaited<ReturnType<typeof releasePolicySettings>>; installed: readonly RuntimeExtension[];
  ignoreWaitingMoveId?: string; dropsPersonalChanges?: boolean };
/** A carried attempt: which checkpoint carries it. */
export interface CarriedAttempt { attemptId: string; gateId: string }

/** What moving one enrollment from `from` to `to` does to that learner. Reads only. */
export async function learnerImpact(client: PoolClient, enrollment: EnrollmentRow, from: MoveRelease, to: MoveRelease, context: MoveContext): Promise<LearnerImpact> {
  return (await assessLearner(client, enrollment, from, to, context)).impact;
}
async function assessLearner(client: PoolClient, enrollment: EnrollmentRow, from: MoveRelease, to: MoveRelease, context: MoveContext): Promise<{ impact: LearnerImpact; carried: CarriedAttempt[] }> {
  const id = enrollment.id;
  const progress = (await client.query<ProgressRow>('SELECT * FROM episode_progress WHERE enrollment_id=$1', [id])).rows;
  const evidence = (await client.query<EvidenceRow>(
    `SELECT e.id,e.attempt_id,e.objective_id,e.independent,e.result,e.created_at,a.family_id,a.assessment_id,${effectiveDigestSql()} AS course_digest,a.mode
     FROM evidence e JOIN attempts a ON a.id=e.attempt_id AND a.enrollment_id=e.enrollment_id WHERE e.enrollment_id=$1 AND e.invalidated_at IS NULL`, [id])).rows;
  const signals = await attemptSignals(client, id);
  const attempts = (await client.query<AttemptProvenance>(
    `SELECT a.id,a.assessment_id,${effectiveDigestSql()} AS course_digest,a.item_digest,a.answer_key_digest,a.evaluator_digest FROM attempts a WHERE a.enrollment_id=$1`, [id])).rows;
  const counts = (await client.query<{ questions: number; activities: number; personal: number; pending: number; study: boolean; on_target: boolean; waiting: boolean }>(`SELECT
      (SELECT count(*)::int FROM assessment_challenges WHERE enrollment_id=$1 AND attempt_id IS NULL AND expires_at>clock_timestamp()) AS questions,
      (SELECT count(*)::int FROM activity_instances WHERE enrollment_id=$1 AND course_digest=$2 AND satisfied_at IS NULL AND state_revision>1) AS activities,
      (SELECT count(*)::int FROM adaptation_states WHERE enrollment_id=$1) AS personal,
      (SELECT count(*)::int FROM adaptation_pending_changes WHERE enrollment_id=$1 AND status='waiting') AS pending,
      EXISTS(SELECT 1 FROM study_participants WHERE enrollment_id=$1 AND consent='consented') AS study,
      EXISTS(SELECT 1 FROM enrollments WHERE course_release_id=$3 AND user_id=$4) AS on_target,
      EXISTS(SELECT 1 FROM course_version_move_entries WHERE enrollment_id=$1 AND state='waiting' AND move_id IS DISTINCT FROM $5::uuid) AS waiting`,
  [id, from.digest, to.id, enrollment.user_id, context.ignoreWaitingMoveId ?? null])).rows[0]!;

  const fromLessons = new Map(episodes(from.server_bundle).map(e => [e.id, e])), toLessons = new Map(episodes(to.server_bundle).map(e => [e.id, e]));
  const lesson = (lessonId: string, course: 'from' | 'to'): Lesson => ({ id: lessonId, title: ((course === 'to' ? toLessons : fromLessons).get(lessonId)?.title ?? lessonId).slice(0, 200) });
  // Unchanged checkpoints carry over: their attempts count on the new version too.
  const carry = planCarryOver(from, to, context.installed, { evidence, signals, attempts });
  const carried = carry.filter(c => c.code === 'CARRIED').flatMap(c => c.attempts.map(attemptId => ({ attemptId, gateId: c.gateId })));
  const carriedIds = new Set(carried.map(c => c.attemptId));
  const before = learningSnapshot(from.server_bundle, from.digest, progress, evidence, { signals });
  const after = learningSnapshot(to.server_bundle, to.digest, progress, withCarried(evidence, row => row.attempt_id, carriedIds, to.digest),
    { signals: withCarried(signals, row => row.id, carriedIds, to.digest) });
  const credited = (snapshot: typeof before) => new Set(snapshot.lessons.filter(l => l.status === 'completed' || l.status === 'placed').map(l => l.id));
  const was = credited(before), now = credited(after);
  const afterById = new Map(after.lessons.map(l => [l.id, l]));
  const changedKept: Lesson[] = [], checkpointsAgain: Lesson[] = [], onHold: Lesson[] = [], removed: Lesson[] = [];
  for (const row of before.lessons) {
    const started = progress.some(p => p.episode_id === row.id && p.state === 'started');
    if (!toLessons.has(row.id)) { if (was.has(row.id) || started) removed.push(lesson(row.id, 'from')); continue; }
    if (!was.has(row.id)) continue;
    if (now.has(row.id)) { if (context.changedEpisodes.has(row.id)) changedKept.push(lesson(row.id, 'to')); continue; }
    const gate = afterById.get(row.id)?.gate;
    (gate && !gate.passed ? checkpointsAgain : onHold).push(lesson(row.id, 'to'));
  }

  const movable = MOVABLE.includes(enrollment.status);
  const state = movable ? await loadPolicy(client, id) : null;
  let policyCode: string | null = null, added: string[] = [], shortened = 0;
  if (state) try {
    const moved = movedScopes(state, to, enrollment, context.settings);
    added = moved.added;
    if (added.length) shortened = previewPolicyChange(state, { scopes: moved.scopes }).shortenedGrants.length;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code !== 'string') throw error;
    policyCode = /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'POLICY_REFUSED';
  }
  const refusal: RefusalCode | null = !movable ? 'MOVE_ENROLLMENT_NOT_ACTIVE'
    : counts.on_target ? 'MOVE_ALREADY_ON_TARGET'
    : (counts.personal || counts.pending) && !context.dropsPersonalChanges ? 'MOVE_PERSONAL_CHANGES'
    : counts.study ? 'MOVE_IN_STUDY'
    : counts.waiting ? 'MOVE_ALREADY_WAITING'
    : policyCode ? 'MOVE_POLICY_REFUSED'
    : shortened ? 'MOVE_SHORTENS_GRANTS' : null;
  const wait = refusal ? null : await moveBoundary(client, id);
  const next = (snapshot: typeof before, course: 'from' | 'to') => snapshot.nextEpisodeId ? lesson(snapshot.nextEpisodeId, course) : null;
  const ids = (items: Lesson[]) => items.map(item => item.id);
  const dropsPersonalChanges = Boolean(context.dropsPersonalChanges && (counts.personal || counts.pending));
  const changes = counts.personal || counts.pending ? await personalChangeLines(client, id, from) : [];
  const checkpoint = (c: (typeof carry)[number]): CheckpointLine => ({ ...lesson(c.lessonId ?? c.gateId, toLessons.has(c.lessonId ?? '') ? 'to' : 'from'), gateId: c.gateId, code: c.code, items: c.items });
  const costDigest = digestJson({ refusal, policyCode, checkpointsAgain: ids(checkpointsAgain), onHold: ids(onHold), removed: ids(removed), added, to: to.id,
    carried: carried.map(c => c.attemptId).sort(), dropsPersonalChanges });
  const impact: LearnerImpact = {
    enrollmentId: id, status: enrollment.status,
    outcome: refusal ? 'refused' : wait ? 'waits' : 'ready', refusal, policyCode, wait,
    progress: { completeBefore: before.complete, completeAfter: after.complete, creditedBefore: was.size, creditedAfter: now.size,
      kept: [...was].filter(lessonId => now.has(lessonId)).length,
      changedKept: list(changedKept), checkpointsAgain: list(checkpointsAgain), onHold: list(onHold), removed: list(removed),
      nextBefore: next(before, 'from'), nextAfter: next(after, 'to') },
    evidence: { records: evidence.filter(row => row.course_digest === from.digest).length },
    openWork: { questions: counts.questions, activities: counts.activities },
    personalChanges: counts.personal + counts.pending,
    policy: { addedScopes: added.slice(0, LIST_LIMIT * 4), keptScopes: state?.scopes.length ?? 0 },
    carryOver: { carried: gateList(carry.filter(c => c.code === 'CARRIED').map(checkpoint)), notCarried: gateList(carry.filter(c => c.code !== 'CARRIED').map(checkpoint)) },
    personalChangeList: changeList(changes), dropsPersonalChanges,
    costDigest,
  };
  return { impact, carried };
}

const losesCredit = (impact: LearnerImpact) => impact.outcome !== 'refused'
  && (impact.progress.checkpointsAgain.count + impact.progress.onHold.count + impact.progress.removed.count > 0);

/** The enrollments a move covers, locked when `lock`. */
async function moveEnrollments(client: PoolClient, from: MoveRelease, enrollmentId: string | null, lock: boolean) {
  const rows = (await client.query<EnrollmentRow>(
    `SELECT id,user_id,status,revision,started_at,current_episode_id,course_release_id,policy FROM enrollments
      WHERE course_release_id=$1 AND ($2::uuid IS NULL OR id=$2) AND ($2::uuid IS NOT NULL OR status IN ('active','paused'))
      ORDER BY id LIMIT ${MOVE_COHORT_LIMIT + 1} ${lock ? 'FOR UPDATE' : ''}`, [from.id, enrollmentId])).rows;
  requireCondition(rows.length <= MOVE_COHORT_LIMIT, 'MOVE_COHORT_TOO_LARGE', 409);
  return rows;
}

/** Course-level facts shared by every learner's preview. */
async function moveContext(client: PoolClient, from: MoveRelease, to: MoveRelease, installed: readonly RuntimeExtension[]) {
  const diff = releaseDiff(from, to);
  const changedEpisodes = new Set([...(diff.kinds.episodes?.changed ?? [])]);
  return { diff, changedEpisodes, settings: await releasePolicySettings(client, to.id), installed };
}
function diffSummary(diff: ReturnType<typeof releaseDiff>, to: MoveRelease) {
  const titles = new Map(episodes(to.server_bundle).map(e => [e.id, e.title.slice(0, 200)]));
  const added = diff.kinds.episodes?.added ?? [];
  return {
    from: diff.from, to: diff.to, changes: diff.changes,
    lessons: { added: added.length, removed: diff.kinds.episodes?.removed.length ?? 0, changed: diff.kinds.episodes?.changed.length ?? 0, unchanged: diff.kinds.episodes?.unchanged ?? 0 },
    questions: { added: diff.kinds.assessments?.added.length ?? 0, removed: diff.kinds.assessments?.removed.length ?? 0, changed: diff.kinds.assessments?.changed.length ?? 0 },
    newLessons: added.slice(0, LIST_LIMIT).map(id => ({ id, title: titles.get(id) ?? id })),
  };
}

/** Previews a move and stores it (with its digest) for confirmation within MOVE_PREVIEW_MINUTES. */
export async function previewMove(client: PoolClient, catalog: { id: string; workspace_id: string; course_key: string }, actorId: string,
  input: { fromReleaseId: string; toReleaseId: string; enrollmentId?: string | undefined }, installed: RuntimeExtension[]) {
  const from = await moveRelease(client, catalog, input.fromReleaseId), to = await moveRelease(client, catalog, input.toReleaseId);
  await assertMoveTarget(from, to, installed);
  const rows = await moveEnrollments(client, from, input.enrollmentId ?? null, false);
  if (input.enrollmentId) requireCondition(rows.length === 1, 'ENROLLMENT_NOT_FOUND', 404);
  const context = await moveContext(client, from, to, installed);
  const learners: LearnerImpact[] = [];
  for (const row of rows) learners.push(await learnerImpact(client, row, from, to, context));
  const body = {
    courseId: catalog.id, scope: input.enrollmentId ? 'learner' as const : 'cohort' as const, enrollmentId: input.enrollmentId ?? null,
    from: { releaseId: from.id, version: from.version }, to: { releaseId: to.id, version: to.version },
    content: diffSummary(context.diff, to),
    totals: { learners: learners.length, ready: learners.filter(l => l.outcome === 'ready').length, waits: learners.filter(l => l.outcome === 'waits').length,
      refused: learners.filter(l => l.outcome === 'refused').length, losingCredit: learners.filter(losesCredit).length,
      carriedCheckpoints: learners.reduce((n, l) => n + l.carryOver.carried.count, 0),
      offered: learners.filter(l => l.refusal === 'MOVE_PERSONAL_CHANGES').length },
    learners,
    rules: { evidenceStaysWithVersion: true as const, unchangedCheckpointsCarry: true as const, personalChangesOffered: true as const, policyKept: true as const, waitsAtMostDays: MOVE_WAIT_DAYS },
  };
  const previewDigest = digestJson(body), moveId = randomUUID(), expiresAt = new Date(Date.now() + MOVE_PREVIEW_MINUTES * 60_000);
  await client.query(`INSERT INTO course_version_moves(id,catalog_id,workspace_id,actor_id,from_release_id,to_release_id,scope,enrollment_id,preview,preview_digest,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [moveId, catalog.id, catalog.workspace_id, actorId, from.id, to.id, body.scope, input.enrollmentId ?? null,
    JSON.stringify(body), previewDigest, expiresAt]);
  return { ...body, moveId, previewDigest, expiresAt: expiresAt.toISOString() };
}

interface MoveRow { id: string; catalog_id: string; workspace_id: string; actor_id: string; from_release_id: string; to_release_id: string; scope: 'learner' | 'cohort';
  enrollment_id: string | null; preview: { learners: LearnerImpact[]; from: { version: string }; to: { version: string } }; preview_digest: string; state: 'previewed' | 'confirmed';
  reason: string | null; expires_at: Date; confirmed_at: Date | null; created_at: Date }

/** Sets the learner's personal changes aside before a move that drops them: the adaptation state
 * and the list they were shown go to personal_change_archives (an undo restores the state); changes
 * still waiting for a safe boundary are declined. Proposals, applications and artifacts are
 * immutable history and stay. Returns how many changes were archived. */
async function archivePersonalChanges(client: PoolClient, move: MoveRow, enrollment: EnrollmentRow, from: MoveRelease, how: 'accepted' | 'forced') {
  const changes = await personalChangeLines(client, enrollment.id, from);
  const state = (await client.query<{ base_digest: string; ledger_revision: number; plan_revision: number; plan_digest: string; snapshot: unknown }>(
    'SELECT base_digest,ledger_revision,plan_revision,plan_digest,snapshot FROM adaptation_states WHERE enrollment_id=$1 FOR UPDATE', [enrollment.id])).rows[0];
  const declined = (await client.query("UPDATE adaptation_pending_changes SET status='declined',resolved_at=clock_timestamp() WHERE enrollment_id=$1 AND status='waiting'", [enrollment.id])).rowCount ?? 0;
  await client.query(`INSERT INTO personal_change_archives(id,move_id,enrollment_id,workspace_id,from_release_id,how,changes,state,pending_declined) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [randomUUID(), move.id, enrollment.id, move.workspace_id, from.id, how, JSON.stringify(changes), state ? JSON.stringify(state) : null, declined]);
  if (state) await client.query('DELETE FROM adaptation_states WHERE enrollment_id=$1', [enrollment.id]);
  return changes.length;
}

/** Moves one locked enrollment now. The caller has checked the boundary and the cost. Checkpoints
 * that carry over are recorded; personal changes are archived when the move drops them. */
async function moveNow(client: PoolClient, move: MoveRow, enrollment: EnrollmentRow, from: MoveRelease, to: MoveRelease, settings: Awaited<ReturnType<typeof releasePolicySettings>>, actorId: string,
  assessed: { carried: CarriedAttempt[]; dropsPersonalChanges: boolean }) {
  const now = new Date().toISOString();
  const offer = assessed.dropsPersonalChanges
    ? (await client.query<{ state: string }>('SELECT state FROM course_version_move_offers WHERE move_id=$1 AND enrollment_id=$2', [move.id, enrollment.id])).rows[0] : undefined;
  const how = offer?.state === 'forced' ? 'forced' as const : 'accepted' as const;
  const archived = assessed.dropsPersonalChanges ? await archivePersonalChanges(client, move, enrollment, from, how) : 0;
  for (const c of assessed.carried) await client.query(`INSERT INTO carried_checkpoint_attempts(move_id,enrollment_id,attempt_id,gate_id,from_course_digest,course_digest)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`, [move.id, enrollment.id, c.attemptId, c.gateId, from.digest, to.digest]);
  const event = await appendEvent(client, { workspaceId: move.workspace_id, enrollmentId: enrollment.id, actorId, actorKind: 'staff', type: 'course_version.moved',
    payload: { moveId: move.id, fromReleaseId: from.id, toReleaseId: to.id, fromVersion: from.version, toVersion: to.version,
      carriedCheckpoints: new Set(assessed.carried.map(c => c.gateId)).size, personalChangesArchived: archived, ...(assessed.dropsPersonalChanges ? { personalChanges: how } : {}) },
    idempotencyKey: `course-version-move:${move.id}:${enrollment.id}` });
  const state = await loadPolicy(client, enrollment.id);
  const moved = movedScopes(state, to, enrollment, settings);
  if (moved.added.length) {
    const preview = previewPolicyChange(state, { scopes: moved.scopes });
    requireCondition(preview.shortenedGrants.length === 0, 'MOVE_SHORTENS_GRANTS', 409);
    const root = state.scopes.find(scope => scope.parentScopeId === null)!.scopeId;
    const transition = applyPolicyChange(state, { scopes: moved.scopes, now, migrationId: `version-move:${move.id}:${enrollment.id}`, reasonRef: event.id,
      previewDigest: preview.previewDigest, acknowledgedShortenedGrantIds: [], expectedPolicyRevision: state.policyRevision, expectedLedgerRevision: state.ledgerRevision,
      idempotencyKey: `version-move:${move.id}`,
      authorityReceipt: { receiptId: event.id, actorId, enrollmentId: enrollment.id, scopeId: root, permission: 'migrate_policy', termsDigest: preview.previewDigest, authorizedAt: now } });
    await savePolicy(client, enrollment.id, transition);
  }
  const keepsPlace = enrollment.current_episode_id !== null && episodes(to.server_bundle).some(e => e.id === enrollment.current_episode_id);
  const updated = (await client.query<{ revision: number }>(`UPDATE enrollments SET course_release_id=$2,policy=$3,current_episode_id=$4,revision=revision+1
      WHERE id=$1 AND course_release_id=$5 RETURNING revision`,
  [enrollment.id, to.id, JSON.stringify(to.server_bundle.policy), keepsPlace ? enrollment.current_episode_id : null, from.id])).rows[0];
  requireCondition(updated, 'STALE_PREVIEW', 409);
  await notifyUser(client, { workspaceId: move.workspace_id, userId: enrollment.user_id, audience: 'learner', kind: 'course_updated', enrollmentId: enrollment.id,
    params: { fromVersion: from.version.slice(0, 40), toVersion: to.version.slice(0, 40) }, link: `/enrollments/${enrollment.id}`, dedupeKey: `course-updated:${move.id}:${enrollment.id}` });
  await client.query(`UPDATE course_version_move_entries SET state='moved',code=NULL,before=$3,moved_revision=$4,moved_at=clock_timestamp(),updated_at=clock_timestamp()
    WHERE move_id=$1 AND enrollment_id=$2`, [move.id, enrollment.id,
    JSON.stringify({ releaseId: from.id, currentEpisodeId: enrollment.current_episode_id, policy: enrollment.policy }), updated.revision]);
}

/** Confirms a previewed move: moves every learner at a safe boundary now, records the others as
 * waiting, and records refusals. The previewed cohort and each learner's cost must be unchanged. */
export async function confirmMove(client: PoolClient, catalog: { id: string; workspace_id: string; course_key: string }, actorId: string,
  input: { moveId: string; previewDigest: string; reason: string; acknowledgeLostCredit: boolean }, installed: RuntimeExtension[]) {
  const move = (await client.query<MoveRow>('SELECT * FROM course_version_moves WHERE id=$1 AND catalog_id=$2 AND actor_id=$3 FOR UPDATE', [input.moveId, catalog.id, actorId])).rows[0];
  requireCondition(move, 'STALE_PREVIEW', 409);
  if (move.state === 'confirmed') {
    requireCondition(move.preview_digest === input.previewDigest, 'IDEMPOTENCY_CONFLICT', 409);
    return { ...(await moveDetail(client, move.id)), replayed: true };
  }
  requireCondition(move.preview_digest === input.previewDigest && move.expires_at.getTime() > Date.now(), 'STALE_PREVIEW', 409);
  const previewed = move.preview.learners;
  // A learner refused for personal changes is offered the move, so confirming still does something.
  requireCondition(previewed.some(l => l.outcome !== 'refused' || l.refusal === 'MOVE_PERSONAL_CHANGES'), 'MOVE_NOBODY_TO_MOVE', 409);
  requireCondition(input.acknowledgeLostCredit || !previewed.some(losesCredit), 'MOVE_LOST_CREDIT_UNACKNOWLEDGED', 409);
  const from = await moveRelease(client, catalog, move.from_release_id), to = await moveRelease(client, catalog, move.to_release_id);
  await assertMoveTarget(from, to, installed);
  const rows = await moveEnrollments(client, from, move.enrollment_id, true);
  requireCondition(digestJson(rows.map(r => r.id).sort()) === digestJson(previewed.map(l => l.enrollmentId).sort()), 'STALE_PREVIEW', 409);
  const context = await moveContext(client, from, to, installed);
  const current = new Map<string, Awaited<ReturnType<typeof assessLearner>>>();
  for (const row of rows) {
    const assessed = await assessLearner(client, row, from, to, context);
    // Whether someone is at a boundary may change; what the move costs them may not.
    requireCondition(assessed.impact.costDigest === previewed.find(l => l.enrollmentId === row.id)!.costDigest, 'STALE_PREVIEW', 409);
    current.set(row.id, assessed);
  }
  await client.query("UPDATE course_version_moves SET state='confirmed',confirmed_at=clock_timestamp(),reason=$2 WHERE id=$1", [move.id, input.reason]);
  for (const row of rows) {
    const { impact, carried } = current.get(row.id)!;
    await client.query(`INSERT INTO course_version_move_entries(move_id,enrollment_id,state,code,cost_digest) VALUES($1,$2,$3,$4,$5)`,
      [move.id, row.id, impact.outcome === 'refused' ? 'refused' : 'waiting', impact.refusal ?? impact.wait, impact.costDigest]);
    if (impact.outcome === 'ready') await moveNow(client, move, row, from, to, context.settings, actorId, { carried, dropsPersonalChanges: false });
    // Personal changes refuse the move; the learner is offered it instead (they may accept or decline).
    if (impact.refusal === 'MOVE_PERSONAL_CHANGES') await offerMove(client, move, row, from, to);
  }
  const totals = await entryTotals(client, move.id);
  await appendEvent(client, { workspaceId: catalog.workspace_id, actorId, actorKind: 'staff', type: 'course_version.move_confirmed',
    payload: { moveId: move.id, catalogId: catalog.id, courseKey: catalog.course_key, scope: move.scope, fromReleaseId: from.id, toReleaseId: to.id,
      fromVersion: from.version, toVersion: to.version, previewDigest: move.preview_digest, reason: input.reason, acknowledgedLostCredit: input.acknowledgeLostCredit, ...totals },
    idempotencyKey: `course-version-move:${move.id}:confirmed` });
  return { ...(await moveDetail(client, move.id)), replayed: false };
}

/** Offers the move to a learner it refused for personal changes. A newer offer replaces an open one. */
async function offerMove(client: PoolClient, move: MoveRow, enrollment: EnrollmentRow, from: MoveRelease, to: MoveRelease) {
  await client.query("UPDATE course_version_move_offers SET state='withdrawn',code='SUPERSEDED',decided_at=clock_timestamp() WHERE enrollment_id=$1 AND state='offered'", [enrollment.id]);
  await client.query('INSERT INTO course_version_move_offers(move_id,enrollment_id) VALUES($1,$2)', [move.id, enrollment.id]);
  await appendEvent(client, { workspaceId: move.workspace_id, enrollmentId: enrollment.id, actorKind: 'system', type: 'course_version.move_offered',
    payload: { moveId: move.id, fromReleaseId: from.id, toReleaseId: to.id, fromVersion: from.version, toVersion: to.version },
    idempotencyKey: `course-version-move:${move.id}:${enrollment.id}:offered` });
}

/**
 * The learner's open offer to move to a newer version, as the staff preview described it for them:
 * the versions, the personal changes the move drops, and what it keeps. Null when there is none or
 * it no longer applies (they are on another version now).
 */
export async function learnerMoveOffer(client: Sql, enrollmentId: string, releaseId: string) {
  const row = (await client.query<{ move_id: string; created_at: Date; preview: MoveRow['preview'] }>(
    `SELECT o.move_id,o.created_at,m.preview FROM course_version_move_offers o JOIN course_version_moves m ON m.id=o.move_id
      WHERE o.enrollment_id=$1 AND o.state='offered' AND m.from_release_id=$2 AND m.state='confirmed'`, [enrollmentId, releaseId])).rows[0];
  if (!row) return null;
  const impact = row.preview.learners.find(l => l.enrollmentId === enrollmentId);
  if (!impact) return null;
  return { moveId: row.move_id, offeredAt: row.created_at.toISOString(), fromVersion: row.preview.from.version, toVersion: row.preview.to.version,
    personalChanges: impact.personalChangeList ?? { count: impact.personalChanges, items: [] },
    keeps: { lessons: impact.progress.kept, checkpointsCarried: impact.carryOver?.carried.count ?? 0, checkpointsAgain: impact.progress.checkpointsAgain.count,
      removed: impact.progress.removed.count } };
}

/** Accepts the learner's offer (their personal changes are archived when the move runs), with
 * `actor` the decider: the learner (accepted) or an owner or admin with a reason (forced). The move
 * then runs at the next safe boundary, now if the learner is at one. */
async function takeOffer(client: PoolClient, move: MoveRow, enrollmentId: string, decision: { state: 'accepted' | 'forced'; actorId: string; reason?: string }, installed: RuntimeExtension[]) {
  const offer = (await client.query<{ state: string }>('SELECT state FROM course_version_move_offers WHERE move_id=$1 AND enrollment_id=$2 FOR UPDATE', [move.id, enrollmentId])).rows[0];
  requireCondition(offer && (offer.state === 'offered' || (decision.state === 'forced' && offer.state === 'declined')), 'MOVE_OFFER_NOT_OPEN', 409);
  const entry = (await client.query<{ state: string; code: string | null }>('SELECT state,code FROM course_version_move_entries WHERE move_id=$1 AND enrollment_id=$2 FOR UPDATE', [move.id, enrollmentId])).rows[0];
  requireCondition(entry?.state === 'refused' && entry.code === 'MOVE_PERSONAL_CHANGES', 'MOVE_OFFER_NOT_OPEN', 409);
  const withdraw = async (code: string) => {
    await client.query("UPDATE course_version_move_offers SET state='withdrawn',code=$3,decided_at=clock_timestamp() WHERE move_id=$1 AND enrollment_id=$2", [move.id, enrollmentId, code]);
    return { status: 'withdrawn' as const, code };
  };
  const catalog = { id: move.catalog_id, workspace_id: move.workspace_id, course_key: (await client.query<{ course_key: string }>('SELECT course_key FROM admin_course_catalog WHERE id=$1', [move.catalog_id])).rows[0]!.course_key };
  const from = await moveRelease(client, catalog, move.from_release_id), to = await moveRelease(client, catalog, move.to_release_id);
  try { await assertMoveTarget(from, to, installed); } catch (error) { if (error instanceof ApiError) return withdraw(error.code); throw error; }
  const enrollment = (await client.query<EnrollmentRow>('SELECT id,user_id,status,revision,started_at,current_episode_id,course_release_id,policy FROM enrollments WHERE id=$1 FOR UPDATE', [enrollmentId])).rows[0];
  if (!enrollment || enrollment.course_release_id !== from.id) return withdraw('MOVE_ENROLLMENT_CHANGED');
  const context = await moveContext(client, from, to, installed);
  const { impact, carried } = await assessLearner(client, enrollment, from, to, { ...context, dropsPersonalChanges: true });
  if (impact.refusal) return withdraw(impact.refusal);
  await client.query('UPDATE course_version_move_offers SET state=$3,decided_by=$4,force_reason=$5,decided_at=clock_timestamp() WHERE move_id=$1 AND enrollment_id=$2',
    [move.id, enrollmentId, decision.state, decision.actorId, decision.reason ?? null]);
  await client.query("UPDATE course_version_move_entries SET state='waiting',code=$3,cost_digest=$4,drops_personal_changes=true,updated_at=clock_timestamp() WHERE move_id=$1 AND enrollment_id=$2",
    [move.id, enrollmentId, impact.wait, impact.costDigest]);
  const forced = decision.state === 'forced';
  await appendEvent(client, { workspaceId: move.workspace_id, enrollmentId, actorId: decision.actorId, actorKind: forced ? 'staff' : 'learner',
    type: forced ? 'course_version.move_forced' : 'course_version.move_offer_accepted',
    payload: { moveId: move.id, fromVersion: from.version, toVersion: to.version, personalChanges: impact.personalChangeList.count, ...(forced ? { reason: decision.reason } : {}) },
    idempotencyKey: `course-version-move:${move.id}:${enrollmentId}:${decision.state}` });
  if (impact.wait) return { status: 'waiting' as const, code: impact.wait };
  await moveNow(client, move, enrollment, from, to, context.settings, forced ? decision.actorId : move.actor_id, { carried, dropsPersonalChanges: impact.dropsPersonalChanges });
  return { status: 'moved' as const, code: null };
}
async function confirmedMove(client: PoolClient, moveId: string) {
  const move = (await client.query<MoveRow>("SELECT * FROM course_version_moves WHERE id=$1 AND state='confirmed' FOR UPDATE", [moveId])).rows[0];
  requireCondition(move, 'MOVE_OFFER_NOT_OPEN', 409);
  return move;
}

/** The learner accepts or declines the offer on their own enrollment (the caller authorized them). */
export async function decideMoveOffer(client: PoolClient, enrollment: { id: string; user_id: string; workspace_id: string }, actorId: string,
  input: { moveId: string; accept: boolean }, installed: RuntimeExtension[]) {
  requireCondition(enrollment.user_id === actorId, 'LEARNER_ONLY', 403);
  const move = await confirmedMove(client, input.moveId);
  requireCondition(move.workspace_id === enrollment.workspace_id, 'MOVE_OFFER_NOT_OPEN', 409);
  if (input.accept) return takeOffer(client, move, enrollment.id, { state: 'accepted', actorId }, installed);
  const declined = (await client.query("UPDATE course_version_move_offers SET state='declined',decided_by=$3,decided_at=clock_timestamp() WHERE move_id=$1 AND enrollment_id=$2 AND state='offered'",
    [move.id, enrollment.id, actorId])).rowCount;
  requireCondition(declined, 'MOVE_OFFER_NOT_OPEN', 409);
  await appendEvent(client, { workspaceId: move.workspace_id, enrollmentId: enrollment.id, actorId, actorKind: 'learner', type: 'course_version.move_offer_declined',
    payload: { moveId: move.id, fromVersion: move.preview.from.version, toVersion: move.preview.to.version }, idempotencyKey: `course-version-move:${move.id}:${enrollment.id}:declined` });
  return { status: 'declined' as const, code: null };
}

/** An owner or admin moves a learner who did not accept the offer (open or declined), with a
 * reason. Audited on the workspace and on the learner's record; their personal changes are archived. */
export async function forceMove(client: PoolClient, catalog: { id: string; workspace_id: string; course_key: string }, actorId: string,
  input: { moveId: string; enrollmentId: string; reason: string }, installed: RuntimeExtension[]) {
  const move = (await client.query<MoveRow>("SELECT * FROM course_version_moves WHERE id=$1 AND catalog_id=$2 AND state='confirmed' FOR UPDATE", [input.moveId, catalog.id])).rows[0];
  requireCondition(move, 'MOVE_NOT_FOUND', 404);
  const result = await takeOffer(client, move, input.enrollmentId, { state: 'forced', actorId, reason: input.reason }, installed);
  await appendEvent(client, { workspaceId: catalog.workspace_id, actorId, actorKind: 'staff', type: 'course_version.move_forced',
    payload: { moveId: move.id, catalogId: catalog.id, enrollmentId: input.enrollmentId, reason: input.reason, outcome: result.status, code: result.code },
    idempotencyKey: `course-version-move:${move.id}:${input.enrollmentId}:forced:audit` });
  return { ...result, move: await moveDetail(client, move.id) };
}

async function entryTotals(client: Sql, moveId: string) {
  const rows = (await client.query<{ state: string; n: number }>('SELECT state,count(*)::int AS n FROM course_version_move_entries WHERE move_id=$1 GROUP BY state', [moveId])).rows;
  const n = (state: string) => rows.find(r => r.state === state)?.n ?? 0;
  return { moved: n('moved'), waiting: n('waiting'), refused: n('refused'), undone: n('undone'), cancelled: n('cancelled') };
}

/** Why a moved learner cannot go back now, or null when an undo is safe. */
async function undoRefusal(client: PoolClient, move: MoveRow, entry: { state: string; moved_revision: number | null; before: { releaseId: string } | null }, enrollment: EnrollmentRow | undefined) {
  if (entry.state !== 'moved' || !enrollment) return 'UNDO_NOT_MOVED';
  if (enrollment.course_release_id !== move.to_release_id || enrollment.revision !== entry.moved_revision) return 'UNDO_LEARNER_CONTINUED';
  const blocked = (await client.query<{ again: boolean; work: boolean; personal: boolean }>(`SELECT
      EXISTS(SELECT 1 FROM enrollments WHERE course_release_id=$2 AND user_id=$3) AS again,
      EXISTS(SELECT 1 FROM assessment_challenges c JOIN course_releases r ON r.id=$4 WHERE c.enrollment_id=$1 AND c.course_digest=r.digest) AS work,
      EXISTS(SELECT 1 FROM adaptation_states WHERE enrollment_id=$1) AS personal`, [enrollment.id, move.from_release_id, enrollment.user_id, move.to_release_id])).rows[0]!;
  return blocked.again ? 'UNDO_ALREADY_ON_OLD_VERSION' : blocked.work ? 'UNDO_LEARNER_CONTINUED' : blocked.personal ? 'UNDO_PERSONAL_CHANGES' : null;
}

/** Puts back the adaptation state a move archived (the learner is on the old version again). */
async function restorePersonalChanges(client: PoolClient, moveId: string, enrollmentId: string, workspaceId: string) {
  const archive = (await client.query<{ id: string; state: { base_digest: string; ledger_revision: number; plan_revision: number; plan_digest: string; snapshot: unknown } | null }>(
    'SELECT id,state FROM personal_change_archives WHERE move_id=$1 AND enrollment_id=$2 AND restored_at IS NULL FOR UPDATE', [moveId, enrollmentId])).rows[0];
  if (!archive) return;
  if (archive.state?.snapshot && Object.keys(archive.state.snapshot as object).length)
    await client.query('INSERT INTO adaptation_states(enrollment_id,workspace_id,base_digest,ledger_revision,plan_revision,plan_digest,snapshot) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [enrollmentId, workspaceId, archive.state.base_digest, archive.state.ledger_revision, archive.state.plan_revision, archive.state.plan_digest, JSON.stringify(archive.state.snapshot)]);
  await client.query('UPDATE personal_change_archives SET restored_at=clock_timestamp() WHERE id=$1', [archive.id]);
}

/** Moves learners of a confirmed move back where it is safe; reports a code for each one it cannot. */
export async function undoMove(client: PoolClient, catalog: { id: string; workspace_id: string; course_key: string }, actorId: string,
  input: { moveId: string; reason: string; enrollmentIds?: string[] | undefined }) {
  const move = (await client.query<MoveRow>("SELECT * FROM course_version_moves WHERE id=$1 AND catalog_id=$2 AND state='confirmed' FOR UPDATE", [input.moveId, catalog.id])).rows[0];
  requireCondition(move, 'MOVE_NOT_FOUND', 404);
  const entries = (await client.query<{ enrollment_id: string; state: string; moved_revision: number | null; before: { releaseId: string; currentEpisodeId: string | null; policy: unknown } | null }>(
    "SELECT enrollment_id,state,moved_revision,before FROM course_version_move_entries WHERE move_id=$1 AND state='moved' AND ($2::uuid[] IS NULL OR enrollment_id=ANY($2::uuid[])) ORDER BY enrollment_id",
    [move.id, input.enrollmentIds ?? null])).rows;
  requireCondition(entries.length, 'UNDO_NOTHING_TO_UNDO', 409);
  const undone: string[] = [], refused: { enrollmentId: string; code: string }[] = [];
  for (const entry of entries) {
    const enrollment = (await client.query<EnrollmentRow>('SELECT id,user_id,status,revision,started_at,current_episode_id,course_release_id,policy FROM enrollments WHERE id=$1 FOR UPDATE', [entry.enrollment_id])).rows[0];
    const code = await undoRefusal(client, move, entry, enrollment);
    if (code) { refused.push({ enrollmentId: entry.enrollment_id, code }); continue; }
    await appendEvent(client, { workspaceId: move.workspace_id, enrollmentId: entry.enrollment_id, actorId, actorKind: 'staff', type: 'course_version.move_undone',
      payload: { moveId: move.id, fromReleaseId: move.to_release_id, toReleaseId: move.from_release_id }, idempotencyKey: `course-version-move:${move.id}:${entry.enrollment_id}:undone` });
    await client.query('UPDATE enrollments SET course_release_id=$2,policy=$3,current_episode_id=$4,revision=revision+1 WHERE id=$1',
      [entry.enrollment_id, move.from_release_id, JSON.stringify(entry.before!.policy), entry.before!.currentEpisodeId]);
    await client.query("UPDATE course_version_move_entries SET state='undone',undone_at=clock_timestamp(),code=NULL,updated_at=clock_timestamp() WHERE move_id=$1 AND enrollment_id=$2", [move.id, entry.enrollment_id]);
    // Carried checkpoints count on the old version again only; archived personal changes come back.
    await client.query('UPDATE carried_checkpoint_attempts SET undone_at=clock_timestamp() WHERE move_id=$1 AND enrollment_id=$2 AND undone_at IS NULL', [move.id, entry.enrollment_id]);
    await restorePersonalChanges(client, move.id, entry.enrollment_id, move.workspace_id);
    undone.push(entry.enrollment_id);
  }
  if (undone.length) await appendEvent(client, { workspaceId: catalog.workspace_id, actorId, actorKind: 'staff', type: 'course_version.move_undone',
    payload: { moveId: move.id, catalogId: catalog.id, reason: input.reason, undone: undone.length, refused: refused.map(r => r.code) },
    idempotencyKey: `course-version-move:${move.id}:undo:${randomUUID()}` });
  return { moveId: move.id, undone, refused };
}

/** Cancels every move of a confirmed move that is still waiting for a safe boundary. */
export async function cancelWaiting(client: PoolClient, catalog: { id: string; workspace_id: string }, actorId: string, moveId: string) {
  const move = (await client.query<{ id: string }>("SELECT id FROM course_version_moves WHERE id=$1 AND catalog_id=$2 AND state='confirmed' FOR UPDATE", [moveId, catalog.id])).rows[0];
  requireCondition(move, 'MOVE_NOT_FOUND', 404);
  const cancelled = (await client.query("UPDATE course_version_move_entries SET state='cancelled',code='CANCELLED_BY_STAFF',updated_at=clock_timestamp() WHERE move_id=$1 AND state='waiting' RETURNING enrollment_id", [moveId])).rowCount ?? 0;
  requireCondition(cancelled, 'MOVE_NOTHING_WAITING', 409);
  await appendEvent(client, { workspaceId: catalog.workspace_id, actorId, actorKind: 'staff', type: 'course_version.move_cancelled', payload: { moveId, catalogId: catalog.id, cancelled },
    idempotencyKey: `course-version-move:${moveId}:cancel:${randomUUID()}` });
  return { moveId, cancelled };
}

/**
 * Retries waiting moves (at most `limit`, oldest first). Each learner is handled in its own
 * transaction: moved once at a safe boundary with an unchanged cost, cancelled when the cost
 * changed, the move became unsafe, the confirming person may no longer move learners, or it has
 * waited MOVE_WAIT_DAYS. Single-flight across processes (advisory lock).
 */
export async function runWaitingMoves(db: Database, options: { installed?: RuntimeExtension[]; now?: Date; limit?: number } = {}) {
  const lock = await db.connect();
  try {
    if (!(await lock.query<{ locked: boolean }>("SELECT pg_try_advisory_lock(hashtext('course-core:version-moves')) AS locked")).rows[0]!.locked) return { ran: false, moved: 0, cancelled: 0 };
    try {
      const due = (await db.query<{ move_id: string; enrollment_id: string }>(
        "SELECT move_id,enrollment_id FROM course_version_move_entries WHERE state='waiting' ORDER BY updated_at LIMIT $1", [options.limit ?? 50])).rows;
      let moved = 0, cancelled = 0;
      for (const item of due) {
        const outcome = await transaction(db, client => retryWaiting(client, item.move_id, item.enrollment_id, options.installed ?? [], options.now ?? new Date()));
        if (outcome === 'moved') moved += 1; else if (outcome === 'cancelled') cancelled += 1;
      }
      return { ran: true, moved, cancelled };
    } finally { await lock.query("SELECT pg_advisory_unlock(hashtext('course-core:version-moves'))"); }
  } finally { lock.release(); }
}

async function retryWaiting(client: PoolClient, moveId: string, enrollmentId: string, installed: RuntimeExtension[], now: Date): Promise<'moved' | 'waiting' | 'cancelled' | 'gone'> {
  const move = (await client.query<MoveRow>('SELECT * FROM course_version_moves WHERE id=$1 FOR UPDATE', [moveId])).rows[0]!;
  const entry = (await client.query<{ state: string; cost_digest: string; drops_personal_changes: boolean }>(
    'SELECT state,cost_digest,drops_personal_changes FROM course_version_move_entries WHERE move_id=$1 AND enrollment_id=$2 FOR UPDATE', [moveId, enrollmentId])).rows[0];
  if (entry?.state !== 'waiting') return 'gone';
  const cancel = async (code: string) => {
    await client.query("UPDATE course_version_move_entries SET state='cancelled',code=$3,updated_at=clock_timestamp() WHERE move_id=$1 AND enrollment_id=$2", [moveId, enrollmentId, code]);
    await appendEvent(client, { workspaceId: move.workspace_id, actorKind: 'system', type: 'course_version.move_cancelled', payload: { moveId, catalogId: move.catalog_id, cancelled: 1, code },
      idempotencyKey: `course-version-move:${moveId}:${enrollmentId}:cancelled` });
    return 'cancelled' as const;
  };
  if (now.getTime() - move.confirmed_at!.getTime() > MOVE_WAIT_DAYS * 86_400_000) return cancel('WAIT_EXPIRED');
  const role = await resolveRole(client, { id: move.actor_id }, move.workspace_id, move.catalog_id);
  if (!roleCan(role, 'policy.write') || !roleCan(role, 'enrollment.write')) return cancel('MOVE_ACTOR_FORBIDDEN');
  const catalog = { id: move.catalog_id, workspace_id: move.workspace_id, course_key: (await client.query<{ course_key: string }>('SELECT course_key FROM admin_course_catalog WHERE id=$1', [move.catalog_id])).rows[0]!.course_key };
  const from = await moveRelease(client, catalog, move.from_release_id), to = await moveRelease(client, catalog, move.to_release_id);
  try { await assertMoveTarget(from, to, installed); } catch (error) { if (error instanceof ApiError) return cancel(error.code); throw error; }
  const enrollment = (await client.query<EnrollmentRow>('SELECT id,user_id,status,revision,started_at,current_episode_id,course_release_id,policy FROM enrollments WHERE id=$1 FOR UPDATE', [enrollmentId])).rows[0];
  if (!enrollment || enrollment.course_release_id !== from.id) return cancel('MOVE_ENROLLMENT_CHANGED');
  const context = await moveContext(client, from, to, installed);
  const { impact, carried } = await assessLearner(client, enrollment, from, to, { ...context, ignoreWaitingMoveId: moveId, dropsPersonalChanges: entry.drops_personal_changes });
  if (impact.refusal) return cancel(impact.refusal);
  if (impact.costDigest !== entry.cost_digest) return cancel('IMPACT_CHANGED');
  if (impact.wait) {
    await client.query('UPDATE course_version_move_entries SET code=$3,updated_at=clock_timestamp() WHERE move_id=$1 AND enrollment_id=$2', [moveId, enrollmentId, impact.wait]);
    return 'waiting';
  }
  const forcedBy = entry.drops_personal_changes ? (await client.query<{ decided_by: string | null; state: string }>(
    'SELECT decided_by,state FROM course_version_move_offers WHERE move_id=$1 AND enrollment_id=$2', [moveId, enrollmentId])).rows[0] : undefined;
  await moveNow(client, move, enrollment, from, to, context.settings, forcedBy?.state === 'forced' && forcedBy.decided_by ? forcedBy.decided_by : move.actor_id,
    { carried, dropsPersonalChanges: impact.dropsPersonalChanges });
  return 'moved';
}

/** A move with its entries, learners named by their enrollment display name and, for moved ones,
 * whether going back is safe now. */
export async function moveDetail(client: PoolClient, moveId: string) {
  const move = (await client.query<MoveRow>('SELECT * FROM course_version_moves WHERE id=$1', [moveId])).rows[0];
  requireCondition(move, 'MOVE_NOT_FOUND', 404);
  const entries = (await client.query<{ enrollment_id: string; state: string; code: string | null; moved_revision: number | null; before: { releaseId: string } | null;
    moved_at: Date | null; undone_at: Date | null; display_name: string | null; drops_personal_changes: boolean;
    offer_state: string | null; offer_code: string | null; force_reason: string | null; offer_decided_at: Date | null } & EnrollmentRow>(
    `SELECT x.enrollment_id,x.state,x.code,x.moved_revision,x.before,x.moved_at,x.undone_at,x.drops_personal_changes,e.profile->>'displayName' AS display_name,
       e.id,e.user_id,e.status,e.revision,e.started_at,e.current_episode_id,e.course_release_id,e.policy,
       o.state AS offer_state,o.code AS offer_code,o.force_reason,o.decided_at AS offer_decided_at
     FROM course_version_move_entries x JOIN enrollments e ON e.id=x.enrollment_id
     LEFT JOIN course_version_move_offers o ON o.move_id=x.move_id AND o.enrollment_id=x.enrollment_id
     WHERE x.move_id=$1 ORDER BY x.enrollment_id`, [moveId])).rows;
  const learners = [];
  for (const row of entries) {
    const undo = row.state === 'moved' ? await undoRefusal(client, move, row, row) : null;
    learners.push({ enrollmentId: row.enrollment_id, displayName: (row.display_name ?? '').slice(0, 100) || null, state: row.state, code: row.code,
      movedAt: row.moved_at?.toISOString() ?? null, undoneAt: row.undone_at?.toISOString() ?? null,
      undo: row.state === 'moved' ? (undo ? { possible: false, code: undo } : { possible: true, code: null }) : null,
      dropsPersonalChanges: row.drops_personal_changes,
      // The learner's offer when the move refused them for personal changes: open, accepted, declined,
      // forced (with the staff reason) or withdrawn (with a code). Staff may force an open or declined one.
      offer: row.offer_state ? { state: row.offer_state, code: row.offer_code, reason: row.force_reason, decidedAt: row.offer_decided_at?.toISOString() ?? null,
        forcible: row.state === 'refused' && (row.offer_state === 'offered' || row.offer_state === 'declined') } : null });
  }
  return {
    moveId: move.id, scope: move.scope, state: move.state, reason: move.reason,
    from: { releaseId: move.from_release_id, version: move.preview.from.version }, to: { releaseId: move.to_release_id, version: move.preview.to.version },
    createdAt: move.created_at.toISOString(), confirmedAt: move.confirmed_at?.toISOString() ?? null,
    totals: await entryTotals(client, move.id), learners,
  };
}

/** The course's versions with how many learners are active or paused on each, the newer published
 * versions each can move to, and recent confirmed moves. */
export async function versionMovesView(client: PoolClient, catalog: { id: string; workspace_id: string; course_key: string }) {
  const releases = (await client.query<{ id: string; version: string; status: string; created_at: Date; learners: number }>(
    `SELECT r.id,r.version,r.status,r.created_at,(SELECT count(*)::int FROM enrollments e WHERE e.course_release_id=r.id AND e.status IN ('active','paused')) AS learners
       FROM course_releases r WHERE r.workspace_id=$1 AND r.course_key=$2 AND r.status IN ('published','archived') ORDER BY r.created_at DESC LIMIT 100`,
    [catalog.workspace_id, catalog.course_key])).rows;
  const versions = releases.map(release => ({
    releaseId: release.id, version: release.version, status: release.status, learners: release.learners,
    newer: releases.filter(other => other.status === 'published' && isSemver(other.version) && isSemver(release.version) && compareSemver(other.version, release.version) > 0)
      .sort((a, b) => compareSemver(b.version, a.version)).map(other => ({ releaseId: other.id, version: other.version })),
  }));
  const moves = (await client.query<{ id: string }>("SELECT id FROM course_version_moves WHERE catalog_id=$1 AND state='confirmed' ORDER BY confirmed_at DESC LIMIT 20", [catalog.id])).rows;
  const recent = [];
  for (const move of moves) {
    const detail = await moveDetail(client, move.id);
    recent.push({ ...detail, learners: undefined, undoable: detail.learners.filter(l => l.undo?.possible).length });
  }
  return { versions, moves: recent };
}

/** Learners on a version, for choosing one to move (names only from the enrollment profile). */
export async function versionLearners(client: PoolClient, catalog: { workspace_id: string; course_key: string }, releaseId: string) {
  await moveRelease(client, catalog, releaseId);
  return (await client.query<{ enrollmentId: string; displayName: string | null; status: string }>(
    `SELECT id AS "enrollmentId",left(profile->>'displayName',100) AS "displayName",status FROM enrollments WHERE course_release_id=$1 AND status IN ('active','paused')
      ORDER BY profile->>'displayName' NULLS LAST,id LIMIT ${MOVE_COHORT_LIMIT}`, [releaseId])).rows;
}

/** Names for a preview's learners, read when it is returned (never stored with the preview). */
export async function withNames<T extends { learners: { enrollmentId: string }[] }>(client: PoolClient, body: T) {
  const ids = body.learners.map(l => l.enrollmentId);
  const names = new Map((await client.query<{ id: string; name: string | null }>("SELECT id,left(profile->>'displayName',100) AS name FROM enrollments WHERE id=ANY($1::uuid[])", [ids])).rows.map(r => [r.id, r.name]));
  return { ...body, learners: body.learners.map(l => ({ ...l, displayName: names.get(l.enrollmentId) ?? null })) };
}
