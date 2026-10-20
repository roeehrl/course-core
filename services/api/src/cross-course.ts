import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import type { CourseManifest } from '@course-core/sdk';
import {
  crossCourseConsentSchema, crossCourseDeliverySchema, crossCoursePlanSchema, uuid as uuidSchema,
  type CrossCourseConsent, type CrossCourseDelivery, type CrossCoursePlan, type CrossCourseReason,
} from '@course-core/supervisor';
import type { authService, Actor } from './auth.js';
import { transaction, type Database } from './database.js';
import { requireCondition } from './errors.js';
import { appendEvent } from './events.js';
import { gateFamilies, gateItemIds, gateObjectives } from './gates.js';
import { OPEN_DISPUTE } from './learner-model.js';
import { supervisionStateWithin } from './supervision-control.js';
import { activeMapping, canonicalPair, type MappingLink } from './concept-mappings.js';

/**
 * Cross-course coordination for one learner (design §4, B01).
 *
 * Privacy first:
 * - Nothing is shared between two of a learner's enrollments unless the learner opted in for that
 *   exact pair (cross_course_consents). The opt-in is off by default, per pair, and revocable.
 *   Revocation deletes every suggestion derived from the pair and stops the coordinator; nothing is
 *   planned from the pair afterwards. Erasure of either enrollment deletes the pair, its history and
 *   its suggestions (eraseCrossCourseWithin).
 * - What crosses is only whether an objective is demonstrated under the source course's own gate
 *   rule, without evidence the learner excluded from AI context or is disputing. Never answers,
 *   companion text, the learner model's notes or the profile goal.
 * - Everything here is learner-private ('cross-course' in learner-privacy.ts): staff routes, the
 *   read-only learner view and staff exports never read it.
 *
 * Authority:
 * - Suggestions follow staff-authored mappings only (concept-mappings.ts); nothing is inferred.
 * - The coordinator proposes; verifyCrossCourseSuggestion re-derives each claim from stored state
 *   (opt-in revision, mapping version, the learner's evidence) before it is stored, and again when the
 *   learner confirms it. A suggestion grants nothing: no evidence, mastery, placement or gate. A
 *   confirmation becomes a learner event in the course it is about, supervised like any other, so the
 *   enrollment's own supervisor (with its own verifier and the course's own assessments) decides
 *   whether anything changes there.
 * - Budget: no provider is called. Each learner gets at most DAILY_SUGGESTIONS new suggestions per
 *   UTC day (then `budget_wait`), each enrollment at most PENDING_PER_ENROLLMENT pending, signals
 *   are coalesced into one pass, and an enrollment whose supervision staff paused or stopped gets none.
 */
export const DAILY_SUGGESTIONS = 6;
export const PENDING_PER_ENROLLMENT = 5;
const MAX_PAIRS_PER_PASS = 20;
const MAX_DELIVERY_ATTEMPTS = 8;
const VERIFIER = 'cross-course-host-v1';
export type SuggestionKind = 'prerequisite_reminder' | 'shown_elsewhere' | 'pacing';
const key = z.string().regex(/^[A-Za-z0-9:_-]{8,200}$/);
const consentInput = z.strictObject({ otherEnrollmentId: z.uuid(), granted: z.boolean(), idempotencyKey: key });
const decisionInput = z.strictObject({ action: z.enum(['confirm', 'dismiss']), idempotencyKey: key });
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  requireCondition(parsed.success, 'INVALID_REQUEST');
  return parsed.data;
}

interface EnrollmentRow { id: string; workspace_id: string; user_id: string; status: string; course_release_id: string; current_episode_id: string | null }
interface Course { id: string; digest: string; title: string; version: string; server_bundle: CourseManifest }
interface ConsentRow { id: string; user_id: string; a_enrollment_id: string; b_enrollment_id: string; state: 'granted' | 'revoked'; revision: number; updated_at: Date }

async function enrollmentOf(client: PoolClient | Database, id: string) {
  return (await client.query<EnrollmentRow>('SELECT id,workspace_id,user_id,status,course_release_id,current_episode_id FROM enrollments WHERE id=$1', [id])).rows[0];
}
async function courseOf(client: PoolClient | Database, releaseId: string) {
  return (await client.query<Course>(`SELECT id,digest,version,learner_bundle->>'title' AS title,server_bundle FROM course_releases WHERE id=$1`, [releaseId])).rows[0]!;
}
const member = async (client: PoolClient, workspaceId: string, userId: string) =>
  ((await client.query('SELECT 1 FROM memberships WHERE workspace_id=$1 AND user_id=$2', [workspaceId, userId])).rowCount ?? 0) > 0;

/** Bumps the learner's consent epoch (creating the row) under its lock. */
async function bumpLearner(client: PoolClient, userId: string) {
  return (await client.query<{ revision: number }>(`INSERT INTO cross_course_learners(user_id,revision) VALUES($1,1)
    ON CONFLICT (user_id) DO UPDATE SET revision=cross_course_learners.revision+1 RETURNING revision`, [userId])).rows[0]!.revision;
}
/** Queues (or coalesces into the open) wake-up of a learner's coordinator. */
export async function queueCrossCourseWakeup(client: PoolClient, userId: string, reason: CrossCourseReason) {
  await client.query(`INSERT INTO cross_course_wakeups(id,user_id,reason) VALUES($1,$2,$3)
    ON CONFLICT (user_id) WHERE delivered_at IS NULL AND abandoned_at IS NULL AND lease_token IS NULL DO NOTHING`, [randomUUID(), userId, reason]);
}

// ---------------------------------------------------------------------------------------------
// What crosses: demonstration under the source course's own gate rule.

const objectivesOf = (course: Course) => new Map((course.server_bundle.objectives ?? []).map(o => [o.id, o]));
const gateOf = (course: Course, objectiveId: string) => (course.server_bundle.gates ?? []).find(g => gateObjectives(g).includes(objectiveId));
function episodeObjectives(course: Course, episodeId: string | null): { episodeId: string | null; objectiveIds: string[] } {
  const episodes = (course.server_bundle.chapters ?? []).flatMap(ch => ch.episodes ?? []);
  const episode = (episodeId ? episodes.find(e => e.id === episodeId) : undefined) ?? (episodeId ? undefined : episodes[0]);
  return { episodeId: episode?.id ?? null, objectiveIds: episode?.objectiveIds ?? [] };
}
interface Demonstration { demonstrated: boolean; families: number; required: number; evidenceDigest: string | null }
/**
 * Whether each objective is demonstrated in this enrollment by its course's gate rule: independent,
 * unassisted, passed answers to the gate's own items in the pinned course version, from enough
 * question families. Evidence the learner excluded from AI context or is disputing never counts
 * here, and an objective with an open dispute or appeal is not shared as demonstrated.
 */
async function demonstrations(client: PoolClient, enrollment: EnrollmentRow, course: Course, objectiveIds: string[]) {
  const result = new Map<string, Demonstration>();
  const ids = [...new Set(objectiveIds)].filter(id => objectivesOf(course).has(id));
  if (!ids.length) return result;
  const rows = (await client.query<{ objective_id: string; assessment_id: string; family_id: string; evidence_id: string }>(
    `SELECT e.objective_id,a.assessment_id,a.family_id,e.id AS evidence_id FROM evidence e JOIN attempts a ON a.id=e.attempt_id AND a.enrollment_id=e.enrollment_id
      WHERE e.enrollment_id=$1 AND e.objective_id=ANY($2::text[]) AND e.independent AND e.invalidated_at IS NULL
        AND e.result->'passed'='true'::jsonb AND a.result->'passed'='true'::jsonb AND a.assistance='none' AND a.mode IN ('independent','placement') AND a.course_digest=$3
        AND NOT EXISTS (SELECT 1 FROM learner_evidence_controls c WHERE c.evidence_id=e.id AND c.enrollment_id=e.enrollment_id AND c.kind='exclude' AND c.ended_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM learner_evidence_controls c WHERE c.evidence_id=e.id AND c.enrollment_id=e.enrollment_id AND ${OPEN_DISPUTE})
      ORDER BY e.objective_id,e.id LIMIT 5000`, [enrollment.id, ids, course.digest])).rows;
  const disputed = new Set((await client.query<{ objective_id: string }>(`SELECT DISTINCT e.objective_id FROM rubric_appeals p JOIN evidence e ON e.attempt_id=p.attempt_id AND e.enrollment_id=p.enrollment_id
      WHERE p.enrollment_id=$1 AND p.state='open' AND e.objective_id=ANY($2::text[])
    UNION SELECT DISTINCT e.objective_id FROM learner_evidence_controls c JOIN evidence e ON e.id=c.evidence_id AND e.enrollment_id=c.enrollment_id
      WHERE c.enrollment_id=$1 AND e.objective_id=ANY($2::text[]) AND ${OPEN_DISPUTE}`, [enrollment.id, ids])).rows.map(r => r.objective_id));
  for (const id of ids) {
    const gate = gateOf(course, id);
    if (!gate) { result.set(id, { demonstrated: false, families: 0, required: 0, evidenceDigest: null }); continue; }
    const items = new Set(gateItemIds(gate));
    const usable = rows.filter(r => r.objective_id === id && items.has(r.assessment_id));
    const families = new Set(usable.map(r => r.family_id)).size, required = gateFamilies(gate);
    result.set(id, { demonstrated: !disputed.has(id) && families >= required, families, required,
      evidenceDigest: usable.length ? sha(usable.map(r => r.evidence_id).sort().join(',')) : null });
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// Proposals and their verifier.

interface Side { enrollment: EnrollmentRow; course: Course }
interface Pair { consent: ConsentRow; sides: [Side, Side]; mapping: NonNullable<Awaited<ReturnType<typeof activeMapping>>> }
export interface Candidate {
  kind: SuggestionKind; source: Side; target: Side; objectiveId: string | null; sourceObjectiveIds: string[];
  relation: MappingLink['relation'] | null; episodeId: string | null;
}
/** The two objectives of a link as seen from `source` → `target`, or null when it runs the other way. */
function orient(link: MappingLink, source: Side, target: Side) {
  const s = source.course.id, t = target.course.id;
  if (link.from.releaseId === s && link.to.releaseId === t) return { sourceObjective: link.from.objectiveId, targetObjective: link.to.objectiveId, forward: true };
  if (link.from.releaseId === t && link.to.releaseId === s) return { sourceObjective: link.to.objectiveId, targetObjective: link.from.objectiveId, forward: false };
  return null;
}
async function candidatesFor(client: PoolClient, pair: Pair, source: Side, target: Side): Promise<Candidate[]> {
  const links = pair.mapping.links;
  const sourceIds: string[] = [], targetIds: string[] = [];
  for (const link of links) { const o = orient(link, source, target); if (o) { sourceIds.push(o.sourceObjective); targetIds.push(o.targetObjective); } }
  const [shown, here] = [await demonstrations(client, source.enrollment, source.course, sourceIds), await demonstrations(client, target.enrollment, target.course, targetIds)];
  const current = episodeObjectives(target.course, target.enrollment.current_episode_id);
  const out: Candidate[] = [], gaps: string[] = [];
  for (const link of links) {
    const o = orient(link, source, target);
    if (!o || here.get(o.targetObjective)?.demonstrated) continue;
    if ((link.relation === 'equivalent' || link.relation === 'overlaps') && shown.get(o.sourceObjective)?.demonstrated)
      out.push({ kind: 'shown_elsewhere', source, target, objectiveId: o.targetObjective, sourceObjectiveIds: [o.sourceObjective], relation: link.relation, episodeId: null });
    // "from is a prerequisite of to": the source objective is the prerequisite of what the learner is on now.
    if (link.relation === 'prerequisite_of' && o.forward && current.objectiveIds.includes(o.targetObjective) && !shown.get(o.sourceObjective)?.demonstrated) {
      out.push({ kind: 'prerequisite_reminder', source, target, objectiveId: o.targetObjective, sourceObjectiveIds: [o.sourceObjective], relation: link.relation, episodeId: current.episodeId });
      gaps.push(o.sourceObjective);
    }
  }
  // Pacing across courses: the current lesson here leans on objectives not yet shown in the other course.
  if (gaps.length && source.enrollment.status === 'active')
    out.push({ kind: 'pacing', source, target, objectiveId: null, sourceObjectiveIds: [...new Set(gaps)].sort().slice(0, 20), relation: null, episodeId: current.episodeId });
  return out;
}
const dedupeKey = (c: Candidate, mappingId: string) => sha(JSON.stringify([c.kind, c.target.enrollment.id, c.objectiveId, c.sourceObjectiveIds, c.relation, c.episodeId, mappingId]));

/**
 * The host verifier for one proposal. It re-derives the claim from stored state instead of trusting
 * the planner: the opt-in is granted at `consentRevision`, the mapping version still contains the
 * link, both objectives exist in the pinned releases, the target enrollment is active and not paused
 * or stopped, and the evidence claim (shown / not shown) still holds. Returns the verification
 * record stored with the suggestion, or a refusal code. It never grants anything.
 */
export async function verifyCrossCourseSuggestion(client: PoolClient, c: Candidate, pair: Pair, consentRevision: number):
  Promise<{ ok: true; record: Record<string, unknown> } | { ok: false; code: string }> {
  const consent = (await client.query<ConsentRow>('SELECT * FROM cross_course_consents WHERE id=$1', [pair.consent.id])).rows[0];
  if (consent?.state !== 'granted') return { ok: false, code: 'CROSS_COURSE_CONSENT_REQUIRED' };
  const learner = (await client.query<{ revision: number }>('SELECT revision FROM cross_course_learners WHERE user_id=$1', [consent.user_id])).rows[0];
  if (!learner || learner.revision !== consentRevision) return { ok: false, code: 'CROSS_COURSE_CONSENT_CHANGED' };
  const mapping = await activeMapping(client, c.source.course.id, c.target.course.id);
  if (!mapping || mapping.id !== pair.mapping.id) return { ok: false, code: 'CONCEPT_MAPPING_CHANGED' };
  for (const side of [c.source, c.target]) {
    const now = await enrollmentOf(client, side.enrollment.id);
    if (now?.status !== 'active' || now.user_id !== consent.user_id || now.course_release_id !== side.course.id || !(await member(client, now.workspace_id, now.user_id)))
      return { ok: false, code: 'ENROLLMENT_NOT_ACTIVE' };
  }
  if (await supervisionStateWithin(client, c.target.enrollment.id, false) !== 'active') return { ok: false, code: 'SUPERVISION_NOT_ACTIVE' };
  const linked = (sourceObjective: string, relation: MappingLink['relation']) => mapping.links.some(link => {
    const o = orient(link, c.source, c.target);
    return o && link.relation === relation && o.sourceObjective === sourceObjective && (c.objectiveId === null || o.targetObjective === c.objectiveId)
      && (relation !== 'prerequisite_of' || o.forward);
  });
  if (!c.sourceObjectiveIds.every(id => linked(id, c.relation ?? 'prerequisite_of'))) return { ok: false, code: 'CONCEPT_MAPPING_LINK_MISSING' };
  if (c.objectiveId && !objectivesOf(c.target.course).has(c.objectiveId)) return { ok: false, code: 'OBJECTIVE_OUT_OF_SCOPE' };
  const shown = await demonstrations(client, c.source.enrollment, c.source.course, c.sourceObjectiveIds);
  const here = c.objectiveId ? await demonstrations(client, c.target.enrollment, c.target.course, [c.objectiveId]) : new Map<string, Demonstration>();
  if (c.objectiveId && here.get(c.objectiveId)?.demonstrated) return { ok: false, code: 'ALREADY_DEMONSTRATED_HERE' };
  if (c.kind === 'shown_elsewhere' && !shown.get(c.sourceObjectiveIds[0]!)?.demonstrated) return { ok: false, code: 'SOURCE_NOT_DEMONSTRATED' };
  if (c.kind !== 'shown_elsewhere' && c.sourceObjectiveIds.some(id => shown.get(id)?.demonstrated)) return { ok: false, code: 'PREREQUISITE_ALREADY_SHOWN' };
  return { ok: true, record: {
    verifier: VERIFIER, consentRevision, mappingRevision: mapping.revision, linksDigest: mapping.links_digest,
    // Counts and a digest only: the other course's evidence identifiers never leave it.
    source: c.sourceObjectiveIds.map(id => ({ objectiveId: id, demonstrated: shown.get(id)?.demonstrated ?? false, families: shown.get(id)?.families ?? 0,
      required: shown.get(id)?.required ?? 0, evidenceDigest: shown.get(id)?.evidenceDigest ?? null })),
    grantsMastery: false, grantsEvidence: false, changesGates: false,
  } };
}

/** Granted pairs of this learner whose two enrollments are active, in authorized workspaces, with an
 * active mapping between their releases. */
async function grantedPairs(client: PoolClient, userId: string, workspaces: readonly string[], limit = MAX_PAIRS_PER_PASS): Promise<Pair[]> {
  const consents = (await client.query<ConsentRow>(`SELECT * FROM cross_course_consents WHERE user_id=$1 AND state='granted' ORDER BY id LIMIT $2`, [userId, limit])).rows;
  const pairs: Pair[] = [];
  for (const consent of consents) {
    const sides: Side[] = [];
    for (const id of [consent.a_enrollment_id, consent.b_enrollment_id]) {
      const enrollment = await enrollmentOf(client, id);
      if (!enrollment || enrollment.status !== 'active' || enrollment.user_id !== userId || !workspaces.includes(enrollment.workspace_id)
        || !(await member(client, enrollment.workspace_id, userId))) break;
      sides.push({ enrollment, course: await courseOf(client, enrollment.course_release_id) });
    }
    if (sides.length !== 2) continue;
    const mapping = await activeMapping(client, sides[0]!.course.id, sides[1]!.course.id);
    if (mapping) pairs.push({ consent, sides: [sides[0]!, sides[1]!], mapping });
  }
  return pairs;
}

/** Bridge RPC `crosscourse.consent`: may this learner's coordinator run at all? */
export async function crossCourseConsentFor(db: Database, workspaces: readonly string[], learnerId: string): Promise<CrossCourseConsent> {
  const userId = uuidSchema.parse(learnerId);
  return transaction(db, async client => {
    const revision = (await client.query<{ revision: number }>('SELECT revision FROM cross_course_learners WHERE user_id=$1', [userId])).rows[0]?.revision ?? 0;
    const active = (await grantedPairs(client, userId, workspaces, 1_000)).length > 0;
    return crossCourseConsentSchema.parse({ active, consentRevision: revision });
  });
}

/** Bridge RPC `crosscourse.plan`: one coordinator pass for one learner. */
export async function planCrossCourse(db: Database, workspaces: readonly string[], learnerId: string, _revision: number): Promise<CrossCoursePlan> {
  const userId = uuidSchema.parse(learnerId);
  return transaction(db, async client => {
    // Lock order everywhere: enrollments, then the learner row (erasure and consent changes do the same).
    const enrollments = (await client.query<{ id: string }>(`SELECT e.id FROM enrollments e WHERE e.id IN
      (SELECT a_enrollment_id FROM cross_course_consents WHERE user_id=$1 AND state='granted' UNION SELECT b_enrollment_id FROM cross_course_consents WHERE user_id=$1 AND state='granted')
      ORDER BY e.id LIMIT 100 FOR KEY SHARE`, [userId])).rows.map(r => r.id);
    const learner = (await client.query<{ revision: number }>('SELECT revision FROM cross_course_learners WHERE user_id=$1 FOR UPDATE', [userId])).rows[0];
    if (!learner) return crossCoursePlanSchema.parse({ status: 'no_consent', consentRevision: 0, created: 0 });
    const pairs = (await grantedPairs(client, userId, workspaces)).filter(p => p.sides.every(s => enrollments.includes(s.enrollment.id)));
    if (!pairs.length) return crossCoursePlanSchema.parse({ status: 'no_consent', consentRevision: learner.revision, created: 0 });
    const today = Number((await client.query<{ n: string }>(`SELECT count(*) AS n FROM cross_course_suggestions s JOIN cross_course_consents c ON c.id=s.consent_id
      WHERE c.user_id=$1 AND s.created_at>=date_trunc('day',clock_timestamp(),'UTC')`, [userId])).rows[0]!.n);
    const untilTomorrow = async () => Math.max(1_000, Math.min(86_400_000, Number((await client.query<{ ms: string }>(
      `SELECT ceil(extract(epoch FROM (date_trunc('day',clock_timestamp(),'UTC')+interval '1 day')-clock_timestamp())*1000)::bigint AS ms`)).rows[0]!.ms)));
    if (today >= DAILY_SUGGESTIONS) return crossCoursePlanSchema.parse({ status: 'budget_wait', consentRevision: learner.revision, created: 0, retryAfterMs: await untilTomorrow() });
    let created = 0;
    for (const pair of pairs) for (const [source, target] of [[pair.sides[0], pair.sides[1]], [pair.sides[1], pair.sides[0]]] as const) {
      for (const candidate of await candidatesFor(client, pair, source, target)) {
        if (today + created >= DAILY_SUGGESTIONS)
          return crossCoursePlanSchema.parse({ status: 'budget_wait', consentRevision: learner.revision, created, retryAfterMs: await untilTomorrow() });
        const pending = Number((await client.query<{ n: string }>(`SELECT count(*) AS n FROM cross_course_suggestions WHERE enrollment_id=$1 AND state='pending'`,
          [target.enrollment.id])).rows[0]!.n);
        if (pending >= PENDING_PER_ENROLLMENT) break;
        const dedupe = dedupeKey(candidate, pair.mapping.id);
        if ((await client.query('SELECT 1 FROM cross_course_suggestions WHERE consent_id=$1 AND dedupe_key=$2', [pair.consent.id, dedupe])).rowCount) continue;
        const verified = await verifyCrossCourseSuggestion(client, candidate, pair, learner.revision);
        if (!verified.ok) continue;
        const inserted = await client.query(`INSERT INTO cross_course_suggestions(id,consent_id,enrollment_id,workspace_id,source_enrollment_id,kind,objective_id,source_objective_ids,relation,
            mapping_id,mapping_revision,consent_revision,dedupe_key,verification) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT (consent_id,dedupe_key) DO NOTHING`,
        [randomUUID(), pair.consent.id, target.enrollment.id, target.enrollment.workspace_id, source.enrollment.id, candidate.kind, candidate.objectiveId,
          JSON.stringify(candidate.sourceObjectiveIds), candidate.relation, pair.mapping.id, pair.mapping.revision, learner.revision, dedupe, JSON.stringify(verified.record)]);
        created += inserted.rowCount ?? 0;
      }
    }
    return crossCoursePlanSchema.parse({ status: 'planned', consentRevision: learner.revision, created });
  });
}

/** Bridge RPC `crosscourse.observe`: an enrollment coordinator's job ended. Wakes the learner's
 * coordinator (queued, and returned for a direct signal) only while an opt-in covers the enrollment. */
export async function observeCrossCourseEnrollment(db: Database, workspaces: readonly string[], workspaceId: string, enrollmentId: string) {
  return transaction(db, async client => {
    const row = (await client.query<{ user_id: string }>(`SELECT c.user_id FROM cross_course_consents c JOIN enrollments e ON e.id=$1 AND e.workspace_id=$2
      WHERE c.state='granted' AND (c.a_enrollment_id=$1 OR c.b_enrollment_id=$1) AND e.workspace_id=ANY($3::uuid[]) AND e.status='active' LIMIT 1`,
    [uuidSchema.parse(enrollmentId), uuidSchema.parse(workspaceId), workspaces])).rows[0];
    if (!row) return { learnerId: null };
    await queueCrossCourseWakeup(client, row.user_id, 'enrollment_activity');
    return { learnerId: row.user_id };
  });
}

/** Bridge RPC `crosscourse.claim`: leases undelivered coordinator wake-ups of learners who belong to
 * an authorized workspace, with the opt-in state read now. */
export async function claimCrossCourseWakeups(db: Database, workspaces: readonly string[], ownerId: string, limit: number, leaseMs: number): Promise<CrossCourseDelivery[]> {
  uuidSchema.parse(ownerId);
  return transaction(db, async client => {
    const rows = (await client.query<{ id: string; user_id: string; reason: CrossCourseReason; attempts: number }>(
      `SELECT w.id,w.user_id,w.reason,w.attempts FROM cross_course_wakeups w
        WHERE w.delivered_at IS NULL AND w.abandoned_at IS NULL AND (w.claimed_until IS NULL OR w.claimed_until<=clock_timestamp())
          AND EXISTS (SELECT 1 FROM memberships m WHERE m.user_id=w.user_id AND m.workspace_id=ANY($1::uuid[]))
        ORDER BY w.created_at,w.id LIMIT $2 FOR UPDATE SKIP LOCKED`, [workspaces, limit])).rows;
    const result: CrossCourseDelivery[] = [];
    for (const row of rows) {
      if (row.attempts >= MAX_DELIVERY_ATTEMPTS) {
        // Only the wake-up is lost: the stored opt-in still governs every pass.
        await client.query('UPDATE cross_course_wakeups SET abandoned_at=clock_timestamp(),lease_token=NULL,claimed_until=NULL WHERE id=$1', [row.id]);
        continue;
      }
      const revision = (await client.query<{ revision: number }>('SELECT revision FROM cross_course_learners WHERE user_id=$1', [row.user_id])).rows[0]?.revision ?? 0;
      const active = (await grantedPairs(client, row.user_id, workspaces, 1_000)).length > 0;
      const leaseToken = randomUUID();
      await client.query(`UPDATE cross_course_wakeups SET attempts=attempts+1,lease_token=$2,claimed_until=clock_timestamp()+($3 * interval '1 millisecond') WHERE id=$1`,
        [row.id, leaseToken, leaseMs]);
      result.push(crossCourseDeliverySchema.parse({ wakeupId: row.id, leaseToken, attempts: row.attempts + 1, learnerId: row.user_id,
        consentRevision: revision, active, reason: row.reason }));
    }
    return result;
  });
}
/** Bridge RPC `crosscourse.ack`. A failed delivery is retried after a bounded backoff. */
export async function ackCrossCourseWakeup(db: Database, workspaces: readonly string[], wakeupId: string, leaseToken: string, delivered: boolean) {
  const result = await db.query(`UPDATE cross_course_wakeups w SET lease_token=NULL,
      delivered_at=CASE WHEN $3 THEN clock_timestamp() ELSE NULL END,
      claimed_until=CASE WHEN $3 THEN NULL ELSE clock_timestamp()+(least(60000,1000*power(2,attempts)) * interval '1 millisecond') END
    WHERE id=$1 AND lease_token=$2 AND claimed_until>clock_timestamp() AND delivered_at IS NULL AND abandoned_at IS NULL
      AND EXISTS (SELECT 1 FROM memberships m WHERE m.user_id=w.user_id AND m.workspace_id=ANY($4::uuid[]))`,
  [uuidSchema.parse(wakeupId), uuidSchema.parse(leaseToken), delivered, workspaces]);
  return result.rowCount === 1;
}

// ---------------------------------------------------------------------------------------------
// Erasure and export.

/** Erasure of one enrollment removes every cross-course link it is part of: the pairs, their
 * change history and every suggestion shown in it or derived from it, in either direction. The
 * affected learners' coordinators are woken so they re-check (and stop when nothing is left).
 * Runs inside eraseWithin, after the erasure marker is set. */
export async function eraseCrossCourseWithin(client: PoolClient, enrollmentId: string) {
  const consents = (await client.query<{ id: string; user_id: string }>(
    'SELECT id,user_id FROM cross_course_consents WHERE a_enrollment_id=$1 OR b_enrollment_id=$1 ORDER BY id', [enrollmentId])).rows;
  const users = [...new Set(consents.map(c => c.user_id))].sort();
  if (users.length) await client.query('SELECT 1 FROM cross_course_learners WHERE user_id=ANY($1::uuid[]) ORDER BY user_id FOR UPDATE', [users]);
  const ids = consents.map(c => c.id);
  const suggestions = (await client.query(`DELETE FROM cross_course_suggestions WHERE enrollment_id=$1 OR source_enrollment_id=$1 OR consent_id=ANY($2::uuid[])`, [enrollmentId, ids])).rowCount ?? 0;
  const changes = (await client.query('DELETE FROM cross_course_consent_changes WHERE consent_id=ANY($1::uuid[])', [ids])).rowCount ?? 0;
  const pairs = (await client.query('DELETE FROM cross_course_consents WHERE id=ANY($1::uuid[])', [ids])).rowCount ?? 0;
  for (const user of users) { await bumpLearner(client, user); await queueCrossCourseWakeup(client, user, 'erased'); }
  return { crossCourseSuggestions: suggestions, crossCourseConsentChanges: changes, crossCourseConsents: pairs };
}
/** The learner's own export of one enrollment: their sharing choices for it and its suggestions. */
export async function exportCrossCourse(client: PoolClient, enrollmentId: string) {
  return {
    consents: (await client.query(`SELECT c.id,CASE WHEN c.a_enrollment_id=$1 THEN c.b_enrollment_id ELSE c.a_enrollment_id END AS other_enrollment_id,c.state,c.revision,c.updated_at,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('revision',h.revision,'granted',h.granted,'createdAt',h.created_at) ORDER BY h.revision) FROM cross_course_consent_changes h WHERE h.consent_id=c.id),'[]') AS changes
      FROM cross_course_consents c WHERE c.a_enrollment_id=$1 OR c.b_enrollment_id=$1 ORDER BY c.id`, [enrollmentId])).rows,
    suggestions: (await client.query(`SELECT id,kind,objective_id,source_enrollment_id,source_objective_ids,relation,mapping_id,mapping_revision,state,created_at,decided_at
      FROM cross_course_suggestions WHERE enrollment_id=$1 ORDER BY created_at,id`, [enrollmentId])).rows,
  };
}

// ---------------------------------------------------------------------------------------------
// The learner's own routes. Staff never reach these: the record is private to the learner.

/** The enrollment, if it is the actor's own (404 for anyone else, staff included). */
async function ownEnrollment(client: PoolClient | Database, actor: Actor, enrollmentId: string) {
  const enrollment = await enrollmentOf(client, enrollmentId);
  requireCondition(enrollment && enrollment.user_id === actor.id && enrollment.status !== 'erased', 'ENROLLMENT_NOT_FOUND', 404);
  return enrollment;
}
async function learnerView(client: PoolClient, actor: Actor, enrollmentId: string) {
  const enrollment = await ownEnrollment(client, actor, enrollmentId);
  const here = await courseOf(client, enrollment.course_release_id);
  const others = (await client.query<EnrollmentRow>(`SELECT id,workspace_id,user_id,status,course_release_id,current_episode_id FROM enrollments
    WHERE user_id=$1 AND id<>$2 AND status<>'erased' ORDER BY started_at,id LIMIT 50`, [actor.id, enrollment.id])).rows;
  const pairs = [];
  for (const other of others) {
    if (!(await member(client, other.workspace_id, actor.id))) continue;
    const [a, b] = canonicalPair(enrollment.id, other.id);
    const consent = (await client.query<ConsentRow>('SELECT * FROM cross_course_consents WHERE a_enrollment_id=$1 AND b_enrollment_id=$2', [a, b])).rows[0];
    const mapping = await activeMapping(client, enrollment.course_release_id, other.course_release_id);
    if (!mapping && !consent) continue;
    const course = await courseOf(client, other.course_release_id);
    const count = (relation: string) => mapping?.links.filter(l => l.relation === relation).length ?? 0;
    pairs.push({ otherEnrollmentId: other.id, otherCourse: { title: course.title, version: course.version, status: other.status },
      mapping: mapping ? { id: mapping.id, revision: mapping.revision, links: mapping.links.length,
        relations: { equivalent: count('equivalent'), prerequisite_of: count('prerequisite_of'), overlaps: count('overlaps') } } : null,
      consent: { granted: consent?.state === 'granted', revision: consent?.revision ?? 0, changedAt: consent?.updated_at.toISOString() ?? null },
      // Granting needs both enrollments active and a mapping in force; revoking is always possible.
      canGrant: Boolean(mapping) && enrollment.status === 'active' && other.status === 'active' });
  }
  const rows = (await client.query<{ id: string; kind: SuggestionKind; objective_id: string | null; source_enrollment_id: string; source_objective_ids: string[]; relation: string | null;
    state: string; created_at: Date; decided_at: Date | null; release_id: string }>(
    `SELECT s.id,s.kind,s.objective_id,s.source_enrollment_id,s.source_objective_ids,s.relation,s.state,s.created_at,s.decided_at,e.course_release_id AS release_id
       FROM cross_course_suggestions s JOIN enrollments e ON e.id=s.source_enrollment_id WHERE s.enrollment_id=$1 ORDER BY (s.state='pending') DESC,s.created_at DESC,s.id LIMIT 20`,
  [enrollment.id])).rows;
  const describe = (course: Course, id: string | null) => {
    if (!id) return null;
    const objective = objectivesOf(course).get(id);
    return { id, description: objective?.description ?? id };
  };
  const suggestions = [];
  for (const row of rows) {
    const other = await courseOf(client, row.release_id);
    suggestions.push({ id: row.id, kind: row.kind, state: row.state, relation: row.relation, createdAt: row.created_at.toISOString(), decidedAt: row.decided_at?.toISOString() ?? null,
      objective: describe(here, row.objective_id), otherEnrollmentId: row.source_enrollment_id, otherCourseTitle: other.title,
      otherObjectives: row.source_objective_ids.map(id => describe(other, id)!), grantsMastery: false as const });
  }
  return { enrollmentId: enrollment.id, courseTitle: here.title, pairs, suggestions, limits: { dailySuggestions: DAILY_SUGGESTIONS, pendingPerEnrollment: PENDING_PER_ENROLLMENT },
    grantsMastery: false as const };
}

async function setConsent(client: PoolClient, actor: Actor, enrollmentId: string, raw: unknown) {
  const input = parse(consentInput, raw);
  requireCondition(input.otherEnrollmentId !== enrollmentId, 'INVALID_REQUEST');
  const [a, b] = canonicalPair(enrollmentId, input.otherEnrollmentId);
  // Lock order: both enrollments, then the learner row (as erasure and planning).
  const locked = (await client.query<EnrollmentRow>('SELECT id,workspace_id,user_id,status,course_release_id,current_episode_id FROM enrollments WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',
    [[a, b]])).rows;
  requireCondition(locked.length === 2 && locked.every(e => e.user_id === actor.id && e.status !== 'erased'), 'ENROLLMENT_NOT_FOUND', 404);
  for (const e of locked) requireCondition(await member(client, e.workspace_id, actor.id), 'ENROLLMENT_NOT_FOUND', 404);
  await client.query('INSERT INTO cross_course_learners(user_id) VALUES($1) ON CONFLICT DO NOTHING', [actor.id]);
  await client.query('SELECT 1 FROM cross_course_learners WHERE user_id=$1 FOR UPDATE', [actor.id]);
  let consent = (await client.query<ConsentRow>('SELECT * FROM cross_course_consents WHERE a_enrollment_id=$1 AND b_enrollment_id=$2 FOR UPDATE', [a, b])).rows[0];
  if (consent) {
    const prior = (await client.query<{ granted: boolean; revision: number }>('SELECT granted,revision FROM cross_course_consent_changes WHERE consent_id=$1 AND idempotency_key=$2',
      [consent.id, input.idempotencyKey])).rows[0];
    if (prior) {
      requireCondition(prior.granted === input.granted, 'IDEMPOTENCY_CONFLICT', 409);
      return { granted: consent.state === 'granted', revision: consent.revision, replayed: true };
    }
    if ((consent.state === 'granted') === input.granted) return { granted: input.granted, revision: consent.revision, replayed: false };
  }
  if (input.granted) {
    const [ea, eb] = [locked.find(e => e.id === a)!, locked.find(e => e.id === b)!];
    requireCondition(ea.status === 'active' && eb.status === 'active', 'ENROLLMENT_NOT_ACTIVE', 409);
    requireCondition(await activeMapping(client, ea.course_release_id, eb.course_release_id), 'CONCEPT_MAPPING_NOT_FOUND', 409);
  } else requireCondition(consent, 'CROSS_COURSE_CONSENT_NOT_FOUND', 404);
  if (!consent) consent = (await client.query<ConsentRow>(`INSERT INTO cross_course_consents(id,user_id,a_enrollment_id,b_enrollment_id,state,revision)
    VALUES($1,$2,$3,$4,'granted',1) RETURNING *`, [randomUUID(), actor.id, a, b])).rows[0]!;
  else consent = (await client.query<ConsentRow>(`UPDATE cross_course_consents SET state=$2,revision=revision+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING *`,
    [consent.id, input.granted ? 'granted' : 'revoked'])).rows[0]!;
  await client.query('INSERT INTO cross_course_consent_changes(id,consent_id,revision,granted,idempotency_key) VALUES($1,$2,$3,$4,$5)',
    [randomUUID(), consent.id, consent.revision, input.granted, input.idempotencyKey]);
  // Revocation removes what was shared through this pair, pending or decided: nothing derived from
  // it stays in either course. The coordinator is told, and the host refuses its next pass anyway.
  const removed = input.granted ? 0 : (await client.query('DELETE FROM cross_course_suggestions WHERE consent_id=$1', [consent.id])).rowCount ?? 0;
  await bumpLearner(client, actor.id);
  await queueCrossCourseWakeup(client, actor.id, input.granted ? 'consent_granted' : 'consent_revoked');
  return { granted: input.granted, revision: consent.revision, removedSuggestions: removed, replayed: false };
}

async function decide(client: PoolClient, actor: Actor, enrollmentId: string, suggestionId: string, raw: unknown) {
  const input = parse(decisionInput, raw);
  const enrollment = await ownEnrollment(client, actor, enrollmentId);
  await client.query('SELECT 1 FROM enrollments WHERE id=$1 FOR UPDATE', [enrollment.id]);
  const row = (await client.query<{ id: string; consent_id: string; kind: SuggestionKind; objective_id: string | null; source_enrollment_id: string; source_objective_ids: string[];
    relation: MappingLink['relation'] | null; state: string; decision_event_id: string | null; mapping_id: string }>(
    'SELECT * FROM cross_course_suggestions WHERE id=$1 AND enrollment_id=$2 FOR UPDATE', [suggestionId, enrollment.id])).rows[0];
  requireCondition(row, 'SUGGESTION_NOT_FOUND', 404);
  const target = input.action === 'confirm' ? 'confirmed' : 'dismissed';
  if (row.state !== 'pending') {
    requireCondition(row.state === target, 'SUGGESTION_ALREADY_DECIDED', 409);
    return { id: row.id, state: row.state, replayed: true, grantsMastery: false as const };
  }
  let eventId: string | null = null;
  if (input.action === 'confirm') {
    // Re-verify against current state: a changed mapping, opt-in or evidence withdraws the suggestion.
    const learner = (await client.query<{ revision: number }>('SELECT revision FROM cross_course_learners WHERE user_id=$1 FOR SHARE', [actor.id])).rows[0];
    const source = await enrollmentOf(client, row.source_enrollment_id);
    const consent = (await client.query<ConsentRow>('SELECT * FROM cross_course_consents WHERE id=$1', [row.consent_id])).rows[0];
    const sides = source && consent ? [{ enrollment: source, course: await courseOf(client, source.course_release_id) }, { enrollment, course: await courseOf(client, enrollment.course_release_id) }] as const : null;
    const mapping = sides ? await activeMapping(client, sides[0].course.id, sides[1].course.id) : null;
    const verdict = sides && mapping && consent && learner
      ? await verifyCrossCourseSuggestion(client, { kind: row.kind, source: sides[0], target: sides[1], objectiveId: row.objective_id, sourceObjectiveIds: row.source_objective_ids,
        relation: row.relation, episodeId: null }, { consent, sides: [sides[0], sides[1]], mapping }, learner.revision)
      : { ok: false as const, code: 'CROSS_COURSE_CONSENT_REQUIRED' };
    if (!verdict.ok) {
      await client.query('DELETE FROM cross_course_suggestions WHERE id=$1', [row.id]);
      return { id: row.id, state: 'withdrawn', reason: verdict.code, replayed: false, grantsMastery: false as const };
    }
    // The learner's confirmation is a learner event in this course, handled by this enrollment's own
    // supervisor like any other. Its payload names only this course's objective.
    eventId = (await appendEvent(client, { workspaceId: enrollment.workspace_id, enrollmentId: enrollment.id, actorId: actor.id, actorKind: 'learner',
      type: 'cross_course.suggestion_confirmed', payload: { suggestionId: row.id, kind: row.kind, objectiveId: row.objective_id, grantsMastery: false },
      idempotencyKey: `${enrollment.id}:cross-course:${row.id}`, supervise: true })).id;
  }
  await client.query(`UPDATE cross_course_suggestions SET state=$2,decided_at=clock_timestamp(),decision_event_id=$3 WHERE id=$1`, [row.id, target, eventId]);
  return { id: row.id, state: target, replayed: false, grantsMastery: false as const };
}

export function registerCrossCourseRoutes(app: FastifyInstance, db: Database, auth: ReturnType<typeof authService>) {
  const params = { type: 'object', additionalProperties: false, required: ['enrollmentId'], properties: { enrollmentId: { type: 'string', format: 'uuid' } } };
  const decisionParams = { type: 'object', additionalProperties: false, required: ['enrollmentId', 'suggestionId'],
    properties: { enrollmentId: { type: 'string', format: 'uuid' }, suggestionId: { type: 'string', format: 'uuid' } } };
  app.get('/api/enrollments/:enrollmentId/cross-course', { schema: { params } }, async request => {
    const actor = await auth.authenticate(request), { enrollmentId } = request.params as { enrollmentId: string };
    return transaction(db, async client => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      return learnerView(client, actor, enrollmentId);
    });
  });
  app.post('/api/enrollments/:enrollmentId/cross-course/consent', { schema: { params } }, async request => {
    const actor = await auth.authenticate(request), { enrollmentId } = request.params as { enrollmentId: string };
    return transaction(db, async client => {
      await ownEnrollment(client, actor, enrollmentId);
      return setConsent(client, actor, enrollmentId, request.body);
    });
  });
  app.post('/api/enrollments/:enrollmentId/cross-course/suggestions/:suggestionId/decision', { schema: { params: decisionParams } }, async request => {
    const actor = await auth.authenticate(request), { enrollmentId, suggestionId } = request.params as { enrollmentId: string; suggestionId: string };
    return transaction(db, client => decide(client, actor, enrollmentId, suggestionId, request.body));
  });
}
