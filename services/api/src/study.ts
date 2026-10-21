import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { CourseManifest } from '@course-core/sdk';
import type { Database } from './database.js';
import { requireCondition } from './errors.js';
import { appendEvent } from './events.js';

type Sql = Database | PoolClient;

/**
 * Educational evaluation studies (W01, P15): pre-test, post-test, transfer and delayed instrument
 * sets over a release's existing assessment items, enrollment-level arms that change behaviour
 * through the existing switches, explicit learner consent separate from enrollment, and a
 * pseudonymous research export.
 *
 * Arms reuse existing controls rather than adding a parallel path:
 * - supervision: the supervisor bridge consumes an event whose role the arm does not offer with
 *   disposition 'study_arm', next to the staff stop control (supervision_stopped), and treats a
 *   running job of such a role as cancelled at its next transition;
 * - companion availability: the companion route refuses a question in an arm without the
 *   companion, and the learner snapshot says the companion is off so the app hides it;
 * - adaptive teaching (supervisor_permissions): set off on joining an arm without supervision, and
 *   the learner cannot switch it on while in that arm;
 * - placement: a course-level setting (placement_settings), so it is the same in every arm.
 *
 * Withdrawal stops data inclusion and lifts the arm's restrictions at once (the learner returns to
 * the course as everyone else has it). The assignment itself is kept unchanged so the allocation
 * sequence stays auditable and a learner who consents again returns to the same arm.
 */
export const ARM_BEHAVIOURS = ['fixed', 'chat_only', 'supervisor'] as const;
export type ArmBehaviour = (typeof ARM_BEHAVIOURS)[number];
export const INSTRUMENT_SETS = ['pre', 'post', 'transfer', 'delayed'] as const;
export type InstrumentSet = (typeof INSTRUMENT_SETS)[number];
/** Supervisor roles each behaviour offers. 'reviewer' drafts notes for a human grader on the
 * learner's separate consent; it is assessment infrastructure, not tutoring, so chat-only keeps it. */
const ROLES: Record<ArmBehaviour, readonly string[]> = {
  fixed: [],
  chat_only: ['companion', 'reviewer'],
  supervisor: ['companion', 'reviewer', 'supervisor', 'research'],
};
export const armOffersRole = (behaviour: ArmBehaviour, role: string) => ROLES[behaviour].includes(role);
/** Plain-language description of what each version means for the learner. */
export const ARM_EXPLANATIONS: Record<ArmBehaviour, string> = {
  fixed: 'The fixed lesson path: the AI companion and personal AI supervision are off for you.',
  chat_only: 'The lessons with the AI companion you can ask questions; personal AI supervision (adjusted plans, suggested resources, generated media) is off for you.',
  supervisor: 'The full course: the AI companion and personal AI supervision, as usual.',
};

const slug = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/);
const itemId = z.string().min(1).max(200);
export const armSchema = z.strictObject({
  id: slug, label: z.string().trim().min(1).max(60), behaviour: z.enum(ARM_BEHAVIOURS),
});
export const instrumentsSchema = z.strictObject({
  pre: z.array(itemId).max(50), post: z.array(itemId).max(50), transfer: z.array(itemId).max(50), delayed: z.array(itemId).max(50),
});
export type StudyArm = z.infer<typeof armSchema>;
export type Instruments = z.infer<typeof instrumentsSchema>;
export const definitionSchema = z.strictObject({
  title: z.string().trim().min(3).max(120),
  purpose: z.string().trim().min(20).max(2000),
  arms: z.array(armSchema).min(2).max(6),
  instruments: instrumentsSchema,
  minCellSize: z.number().int().min(3).max(100),
});
export type StudyDefinition = z.infer<typeof definitionSchema>;

export interface StudyRow {
  id: string; workspace_id: string; course_release_id: string; title: string; purpose: string; state: 'draft' | 'recruiting' | 'closed';
  arms: StudyArm[]; instruments: Instruments; min_cell_size: number; allocation_seed: Buffer; seed_digest: string; pseudonym_salt: Buffer;
  next_allocation: number; revision: number; created_by: string; created_at: Date; updated_at: Date; opened_at: Date | null; closed_at: Date | null;
}

/** Study warning codes; the admin app words each (apps/admin studies namespace, warning.<code>). */
export const STUDY_WARNING_CODES = ['TRANSFER_ROLE_UNDECLARED', 'ITEM_COUNTS_TOWARD_GATE', 'PRE_POST_UNMATCHED'] as const;
/** A warning staff see on a study, as a code the admin app words (studies namespace, warning.<code>). */
export type StudyWarning =
  | { code: 'TRANSFER_ROLE_UNDECLARED'; params: { item: string } }
  | { code: 'ITEM_COUNTS_TOWARD_GATE'; params: { item: string; set: 'pre' | 'post' | 'transfer' } }
  | { code: 'PRE_POST_UNMATCHED' };
/** Problems that refuse a definition, and warnings shown to staff. Uses the SDK 0.5 assessment
 * `role` where the author declared one, and the course's retention policy for delayed checks. */
export function validateDefinition(course: CourseManifest, definition: StudyDefinition, opening = false) {
  const errors: string[] = [], warnings: StudyWarning[] = [];
  const ids = definition.arms.map((a) => a.id);
  if (new Set(ids).size !== ids.length) errors.push('STUDY_ARM_DUPLICATE');
  const items = new Map(course.assessments.map((a) => [a.id, a]));
  const seen = new Map<string, InstrumentSet>();
  for (const set of INSTRUMENT_SETS) {
    const list = definition.instruments[set];
    if (new Set(list).size !== list.length) errors.push('STUDY_ITEM_REPEATED');
    for (const id of list) {
      if (!items.has(id)) errors.push('STUDY_ITEM_UNKNOWN');
      // An item answered in two sets would be a repeat, not a new measurement.
      if (seen.has(id) && seen.get(id) !== set) errors.push('STUDY_ITEM_IN_TWO_SETS');
      seen.set(id, set);
    }
  }
  for (const id of definition.instruments.transfer) {
    const role = items.get(id)?.role;
    if (role !== undefined && role !== 'transfer') errors.push('STUDY_TRANSFER_ROLE');
    if (role === undefined && items.has(id)) warnings.push({ code: 'TRANSFER_ROLE_UNDECLARED', params: { item: id } });
  }
  const retention = new Set(course.retention?.assessmentIds ?? []);
  // Delayed checks are scheduled by the course's retention policy, so only its held-out items qualify.
  for (const id of definition.instruments.delayed) if (!retention.has(id)) errors.push('STUDY_DELAYED_NOT_RETENTION');
  const gated = new Set(course.gates.flatMap((g) => ('assessmentIds' in g && Array.isArray(g.assessmentIds) ? g.assessmentIds : [])));
  for (const set of ['pre', 'post', 'transfer'] as const)
    for (const id of definition.instruments[set]) if (gated.has(id)) warnings.push({ code: 'ITEM_COUNTS_TOWARD_GATE', params: { item: id, set } });
  const objectives = (set: InstrumentSet) => new Set(definition.instruments[set].flatMap((id) => items.get(id)?.objectiveIds ?? []));
  const pre = objectives('pre'), post = objectives('post');
  if (pre.size && post.size && (pre.size !== post.size || [...pre].some((o) => !post.has(o))))
    warnings.push({ code: 'PRE_POST_UNMATCHED' });
  if (opening) {
    if (!definition.instruments.pre.length) errors.push('STUDY_PRE_REQUIRED');
    if (!definition.instruments.post.length) errors.push('STUDY_POST_REQUIRED');
  }
  const unique = new Map(warnings.map((w) => [JSON.stringify(w), w]));
  return { errors: [...new Set(errors)], warnings: [...unique.values()] };
}

/**
 * Permuted-block allocation. Allocation index n (consent order within the study) falls in block
 * floor(n/k) of k arms; each block is a Fisher-Yates permutation of the arms driven by
 * HMAC-SHA256(seed, "block:<b>"). Deterministic for a seed and index, so it can be recomputed
 * and audited; within every complete block each arm appears once, so arm sizes never differ by
 * more than one among assignments made.
 */
export function allocateArm(seed: Buffer, index: number, armIds: readonly string[]): string {
  requireCondition(Number.isSafeInteger(index) && index >= 0 && armIds.length >= 2 && armIds.length <= 6, 'STUDY_ALLOCATION_INVALID', 500);
  const k = armIds.length, order = [...armIds];
  const digest = createHmac('sha256', seed).update(`block:${Math.floor(index / k)}`).digest();
  for (let i = k - 1, offset = 0; i > 0; i--, offset += 4) {
    const j = digest.readUInt32BE(offset) % (i + 1);
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  return order[index % k]!;
}
/** The participant code: shown to the learner, used as the export pseudonym. Salted per study. */
export const pseudonym = (salt: Buffer, enrollmentId: string) =>
  'P' + createHmac('sha256', salt).update(enrollmentId).digest('hex').slice(0, 10).toUpperCase();

/** What the learner is asked to agree to: the study's text and the versions they may be placed in.
 * The client returns this digest, so consent always names the text the learner saw. */
export function consentDigest(study: Pick<StudyRow, 'id' | 'title' | 'purpose' | 'arms'>) {
  return createHash('sha256').update(JSON.stringify({ id: study.id, title: study.title, purpose: study.purpose,
    versions: study.arms.map((a) => ARM_EXPLANATIONS[a.behaviour]) })).digest('hex');
}

export function newStudySecrets() {
  const seed = randomBytes(32);
  return { seed, seedDigest: createHash('sha256').update(seed).digest('hex'), salt: randomBytes(32) };
}

export interface ActiveArm { studyId: string; armId: string; label: string; behaviour: ArmBehaviour }
/** The arm in force for an enrollment: a consented participant of a recruiting study, or null. */
export async function studyArmWithin(client: Sql, enrollmentId: string): Promise<ActiveArm | null> {
  const row = (await client.query<{ study_id: string; arm_id: string; arms: StudyArm[] }>(
    `SELECT p.study_id,p.arm_id,s.arms FROM study_participants p JOIN studies s ON s.id=p.study_id AND s.workspace_id=p.workspace_id
      WHERE p.enrollment_id=$1 AND p.consent='consented' AND s.state='recruiting' LIMIT 1`, [enrollmentId])).rows[0];
  if (!row) return null;
  const arm = row.arms.find((a) => a.id === row.arm_id);
  // A definition is frozen once recruiting, so the arm exists; fail closed (no AI) if it did not.
  return { studyId: row.study_id, armId: row.arm_id, label: arm?.label ?? row.arm_id, behaviour: arm?.behaviour ?? 'fixed' };
}

/** The study a learner on this release may join or has joined (draft studies are not shown). */
export async function learnerStudyView(client: Sql, enrollment: { id: string; course_release_id: string }) {
  const study = (await client.query<StudyRow>(
    `SELECT * FROM studies WHERE course_release_id=$1 AND state<>'draft' ORDER BY (state='recruiting') DESC,opened_at DESC LIMIT 1`,
    [enrollment.course_release_id])).rows[0];
  if (!study) return { study: null, participation: null };
  const participant = (await client.query<{ arm_id: string; consent: string; consented_at: Date; withdrawn_at: Date | null }>(
    'SELECT arm_id,consent,consented_at,withdrawn_at FROM study_participants WHERE study_id=$1 AND enrollment_id=$2', [study.id, enrollment.id])).rows[0];
  // A closed study the learner never joined has nothing to show.
  if (study.state === 'closed' && !participant) return { study: null, participation: null };
  const arm = participant ? study.arms.find((a) => a.id === participant.arm_id) : undefined;
  const consented = participant?.consent === 'consented';
  return {
    study: {
      id: study.id, title: study.title, purpose: study.purpose, state: study.state, consentDigest: consentDigest(study),
      versions: [...new Set(study.arms.map((a) => a.behaviour))].map((behaviour) => ARM_EXPLANATIONS[behaviour]),
      collected: ['your study code (not your name or email)', 'which version of the course you used',
        'your scores on the study\'s check questions, and when you answered them', 'how many lessons you completed'],
      neverCollected: ['your name, email or profile', 'anything you write in answers or messages', 'your conversations with the AI companion'],
    },
    participation: participant ? {
      consent: participant.consent as 'consented' | 'withdrawn',
      participantCode: pseudonym(study.pseudonym_salt, enrollment.id),
      consentedAt: participant.consented_at.toISOString(), withdrawnAt: participant.withdrawn_at?.toISOString() ?? null,
      // What changes for the learner now: nothing after withdrawal or once the study has closed.
      version: consented && study.state === 'recruiting' && arm ? { label: arm.label, behaviour: arm.behaviour, explanation: ARM_EXPLANATIONS[arm.behaviour] } : null,
    } : null,
  };
}

/** Joins (or rejoins) the study inside an enrollment command that holds the enrollment lock. */
export async function consentWithin(client: PoolClient, input: { enrollment: { id: string; workspace_id: string; course_release_id: string; status: string };
  actorId: string; studyId: string; consentDigest: string; idempotencyKey: string }) {
  const study = (await client.query<StudyRow>('SELECT * FROM studies WHERE id=$1 AND workspace_id=$2 FOR UPDATE',
    [input.studyId, input.enrollment.workspace_id])).rows[0];
  requireCondition(study && study.course_release_id === input.enrollment.course_release_id, 'STUDY_NOT_FOUND', 404);
  requireCondition(study.state === 'recruiting', 'STUDY_NOT_RECRUITING', 409);
  requireCondition(input.enrollment.status === 'active', 'ENROLLMENT_INACTIVE', 409);
  // The learner agrees to the text they were shown; a changed text needs a fresh read.
  requireCondition(input.consentDigest === consentDigest(study), 'STUDY_CONSENT_TEXT_CHANGED', 409);
  const prior = (await client.query<{ arm_id: string; consent: string; consent_revision: number }>(
    'SELECT arm_id,consent,consent_revision FROM study_participants WHERE study_id=$1 AND enrollment_id=$2 FOR UPDATE', [study.id, input.enrollment.id])).rows[0];
  if (prior?.consent === 'consented') return { armId: prior.arm_id, changed: false };
  let armId: string, revision: number;
  if (prior) {
    // Rejoining keeps the original assignment.
    armId = prior.arm_id; revision = prior.consent_revision + 1;
    await client.query(`UPDATE study_participants SET consent='consented',consent_revision=$3,consent_digest=$4,consented_at=clock_timestamp(),withdrawn_at=NULL
      WHERE study_id=$1 AND enrollment_id=$2`, [study.id, input.enrollment.id, revision, input.consentDigest]);
  } else {
    const index = study.next_allocation;
    armId = allocateArm(study.allocation_seed, index, study.arms.map((a) => a.id)); revision = 1;
    await client.query(`INSERT INTO study_participants(study_id,enrollment_id,workspace_id,allocation_index,arm_id,consent,consent_digest)
      VALUES($1,$2,$3,$4,$5,'consented',$6)`, [study.id, input.enrollment.id, input.enrollment.workspace_id, index, armId, input.consentDigest]);
    await client.query('UPDATE studies SET next_allocation=next_allocation+1 WHERE id=$1', [study.id]);
  }
  await client.query(`INSERT INTO study_consent_changes(id,study_id,enrollment_id,workspace_id,action,consent_revision,consent_digest)
    VALUES($1,$2,$3,$4,'consented',$5,$6)`, [randomUUID(), study.id, input.enrollment.id, input.enrollment.workspace_id, revision, input.consentDigest]);
  const behaviour = study.arms.find((a) => a.id === armId)!.behaviour;
  if (behaviour !== 'supervisor') {
    // The existing adaptive-teaching switch goes off: this arm offers no personal supervision.
    await client.query(`UPDATE supervisor_permissions SET adaptive_teaching=false,revision=revision+1,changed_by=$2,updated_at=clock_timestamp()
      WHERE enrollment_id=$1 AND adaptive_teaching`, [input.enrollment.id, input.actorId]);
    // Running jobs of roles this arm does not offer end at their next transition (the bridge also
    // treats them as cancelled while the arm applies).
    await client.query(`UPDATE supervisor_jobs SET cancellation_requested=true WHERE enrollment_id=$1 AND workspace_id=$2
      AND state NOT IN ('applied','cancelled','failed') AND NOT cancellation_requested AND NOT (role = ANY($3::text[]))`,
    [input.enrollment.id, input.enrollment.workspace_id, ROLES[behaviour]]);
  }
  await client.query('UPDATE enrollments SET revision=revision+1 WHERE id=$1', [input.enrollment.id]);
  await appendEvent(client, { workspaceId: input.enrollment.workspace_id, enrollmentId: input.enrollment.id, actorId: input.actorId, actorKind: 'learner',
    type: 'study.consented', payload: { studyId: study.id, consentRevision: revision }, idempotencyKey: `${input.enrollment.id}:${input.idempotencyKey}` });
  return { armId, changed: true };
}

/** Withdraws consent inside an enrollment command. Data inclusion stops and the arm's
 * restrictions lift at once; the assignment row stays as it was. */
export async function withdrawWithin(client: PoolClient, input: { enrollment: { id: string; workspace_id: string }; actorId: string; studyId: string; idempotencyKey: string }) {
  const participant = (await client.query<{ consent: string; consent_revision: number; consent_digest: string }>(
    'SELECT consent,consent_revision,consent_digest FROM study_participants WHERE study_id=$1 AND enrollment_id=$2 FOR UPDATE',
    [input.studyId, input.enrollment.id])).rows[0];
  requireCondition(participant, 'STUDY_NOT_JOINED', 404);
  if (participant.consent === 'withdrawn') return { changed: false };
  const revision = participant.consent_revision + 1;
  await client.query(`UPDATE study_participants SET consent='withdrawn',consent_revision=$3,withdrawn_at=clock_timestamp() WHERE study_id=$1 AND enrollment_id=$2`,
    [input.studyId, input.enrollment.id, revision]);
  await client.query(`INSERT INTO study_consent_changes(id,study_id,enrollment_id,workspace_id,action,consent_revision,consent_digest)
    VALUES($1,$2,$3,$4,'withdrawn',$5,$6)`, [randomUUID(), input.studyId, input.enrollment.id, input.enrollment.workspace_id, revision, participant.consent_digest]);
  await client.query('UPDATE enrollments SET revision=revision+1 WHERE id=$1', [input.enrollment.id]);
  await appendEvent(client, { workspaceId: input.enrollment.workspace_id, enrollmentId: input.enrollment.id, actorId: input.actorId, actorKind: 'learner',
    type: 'study.withdrawn', payload: { studyId: input.studyId, consentRevision: revision }, idempotencyKey: `${input.enrollment.id}:${input.idempotencyKey}` });
  return { changed: true };
}

/** Staff view of one study: definition, arm balance and consent counts. Aggregates only. */
export async function studySummary(client: Sql, study: StudyRow) {
  const arms = (await client.query<{ arm_id: string; consented: number; withdrawn: number }>(
    `SELECT arm_id,count(*) FILTER (WHERE consent='consented')::int AS consented,count(*) FILTER (WHERE consent='withdrawn')::int AS withdrawn
       FROM study_participants WHERE study_id=$1 GROUP BY arm_id`, [study.id])).rows;
  const eligible = (await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM enrollments WHERE course_release_id=$1 AND workspace_id=$2 AND status<>'erased'`,
    [study.course_release_id, study.workspace_id])).rows[0]!.n;
  const byArm = new Map(arms.map((a) => [a.arm_id, a]));
  const consented = arms.reduce((n, a) => n + a.consented, 0), withdrawn = arms.reduce((n, a) => n + a.withdrawn, 0);
  return {
    id: study.id, releaseId: study.course_release_id, title: study.title, purpose: study.purpose, state: study.state, revision: study.revision,
    arms: study.arms.map((a) => ({ ...a, explanation: ARM_EXPLANATIONS[a.behaviour], consented: byArm.get(a.id)?.consented ?? 0, withdrawn: byArm.get(a.id)?.withdrawn ?? 0 })),
    instruments: study.instruments, minCellSize: study.min_cell_size, seedDigest: study.seed_digest,
    consent: { eligible, consented, withdrawn, undecided: Math.max(0, eligible - consented - withdrawn) },
    createdAt: study.created_at.toISOString(), openedAt: study.opened_at?.toISOString() ?? null, closedAt: study.closed_at?.toISOString() ?? null,
  };
}

/** Recomputes every remaining assignment from the seed. Any mismatch would mean an assignment changed. */
export async function verifyAllocation(client: Sql, study: StudyRow) {
  const rows = (await client.query<{ allocation_index: number; arm_id: string }>('SELECT allocation_index,arm_id FROM study_participants WHERE study_id=$1 ORDER BY allocation_index', [study.id])).rows;
  const ids = study.arms.map((a) => a.id);
  const mismatches = rows.filter((r) => allocateArm(study.allocation_seed, r.allocation_index, ids) !== r.arm_id).length;
  return { checked: rows.length, mismatches, allocated: study.next_allocation, seedDigest: study.seed_digest };
}

type Outcome = 'correct' | 'incorrect' | 'abstained' | 'pending' | 'not_attempted';
interface AttemptRow { enrollment_id: string; assessment_id: string; mode: string; assistance: string; submitted_at: Date; result: Record<string, unknown> | null; decision: string | null }
/** A first attempt's outcome: the stored result, or a human reviewer's decision for a reviewed answer. */
function attemptOutcome(a: AttemptRow): Outcome {
  const result = a.result ?? {};
  if (result.abstained === true) return 'abstained';
  if (result.status === 'pending_review') return a.decision === 'met' ? 'correct' : a.decision === 'not_met' ? 'incorrect' : 'pending';
  return result.passed === true ? 'correct' : 'incorrect';
}
export const EXPORT_SCHEMA = 'course-core.study-export/1';
/** Every column of the export, with its meaning. Nothing here names a person or holds free text. */
export const EXPORT_FIELDS: Record<string, string> = {
  participant: 'Pseudonym: HMAC-SHA256 of the enrollment id under the per-study salt (first 10 hex digits). The learner sees the same code.',
  arm: 'Arm id the participant was assigned to (never changed after assignment).',
  behaviour: 'What the arm switched: fixed, chat_only or supervisor.',
  consentedDay: 'Whole days from the study opening to the participant\'s (latest) consent.',
  '<set>_items': 'Items in the set (pre, post, transfer, delayed).',
  '<set>_attempted': 'Items with a first independent attempt (delayed: a first retention-check attempt).',
  '<set>_correct': 'First attempts judged correct (a human-reviewed answer counts once decided).',
  '<set>_score': 'correct / items, three decimals; empty when the set has no items.',
  '<set>_complete': '1 when every item in the set was attempted, else 0.',
  '<set>_first_min': 'Minutes from consent to the first attempt in the set (negative: answered before consenting).',
  '<set>_last_min': 'Minutes from consent to the last first-attempt in the set.',
  '<set>:<item>': 'First-attempt outcome per item: correct, incorrect, abstained, pending or not_attempted.',
  episodes_completed: 'Lessons completed or placed out.',
  episodes_total: 'Lessons in the release.',
  course_completed: '1 when the enrollment completed the course.',
};

/** The pseudonymous research export. Consented participants only, small arms suppressed. */
export async function buildExport(client: PoolClient, study: StudyRow, course: CourseManifest) {
  const rows = (await client.query<{ enrollment_id: string; arm_id: string; consented_at: Date; status: string }>(
    `SELECT p.enrollment_id,p.arm_id,p.consented_at,e.status FROM study_participants p JOIN enrollments e ON e.id=p.enrollment_id
      WHERE p.study_id=$1 AND p.consent='consented' AND e.status<>'erased' ORDER BY p.allocation_index`, [study.id])).rows;
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.arm_id, (counts.get(r.arm_id) ?? 0) + 1);
  // Small-cell rule: an arm with fewer included participants than the minimum is left out entirely,
  // and the overall total is withheld so it cannot be recovered by subtraction.
  const suppressed = new Set(study.arms.filter((a) => (counts.get(a.id) ?? 0) < study.min_cell_size).map((a) => a.id));
  const behaviours = new Map(study.arms.map((a) => [a.id, a.behaviour]));
  const totalEpisodes = course.chapters.reduce((n, c) => n + c.episodes.length, 0);
  const opened = study.opened_at?.getTime() ?? study.created_at.getTime();
  // First attempts only (a reviewer's clarification reply continues an attempt, it is not a new one),
  // in submission order, for every included participant at once.
  const byEnrollment = new Map<string, AttemptRow[]>();
  for (const a of (await client.query<AttemptRow>(
    `SELECT a.enrollment_id,a.assessment_id,a.mode,a.assistance,a.submitted_at,a.result,v.decision FROM attempts a LEFT JOIN rubric_reviews v ON v.attempt_id=a.id
      WHERE a.enrollment_id=ANY($1::uuid[]) AND a.continues_attempt_id IS NULL AND a.assessment_id=ANY($2::text[]) ORDER BY a.submitted_at,a.id`,
    [rows.filter((r) => !suppressed.has(r.arm_id)).map((r) => r.enrollment_id), INSTRUMENT_SETS.flatMap((set) => study.instruments[set])])).rows) {
    const list = byEnrollment.get(a.enrollment_id) ?? [];
    list.push(a);
    byEnrollment.set(a.enrollment_id, list);
  }
  const participants = [];
  for (const row of rows) {
    if (suppressed.has(row.arm_id)) continue;
    const consented = row.consented_at.getTime();
    const attempts = byEnrollment.get(row.enrollment_id) ?? [];
    const sets: Record<string, unknown> = {};
    for (const set of INSTRUMENT_SETS) {
      const items = study.instruments[set], outcomes: Record<string, Outcome> = {}, times: number[] = [];
      for (const item of items) {
        // First qualifying attempt: delayed items only through a retention check; the others only
        // when answered independently (placement counts: it is unassisted by contract).
        const first = attempts.find((a) => a.assessment_id === item
          && (set === 'delayed' ? a.mode === 'retention' : (a.mode === 'independent' || a.mode === 'placement') && a.assistance === 'none'));
        outcomes[item] = first ? attemptOutcome(first) : 'not_attempted';
        if (first) times.push(first.submitted_at.getTime());
      }
      const attempted = Object.values(outcomes).filter((o) => o !== 'not_attempted').length;
      const correct = Object.values(outcomes).filter((o) => o === 'correct').length;
      sets[set] = {
        items: items.length, attempted, correct, score: items.length ? Math.round((correct / items.length) * 1000) / 1000 : null,
        complete: items.length > 0 && attempted === items.length,
        firstMinutes: times.length ? Math.round((Math.min(...times) - consented) / 60_000) : null,
        lastMinutes: times.length ? Math.round((Math.max(...times) - consented) / 60_000) : null,
        outcomes,
      };
    }
    const progress = (await client.query<{ n: number }>("SELECT count(*)::int AS n FROM episode_progress WHERE enrollment_id=$1 AND state IN ('completed','placed')",
      [row.enrollment_id])).rows[0]!.n;
    participants.push({
      participant: pseudonym(study.pseudonym_salt, row.enrollment_id), arm: row.arm_id, behaviour: behaviours.get(row.arm_id)!,
      consentedDay: Math.floor((consented - opened) / 86_400_000), sets,
      episodesCompleted: progress, episodesTotal: totalEpisodes, courseCompleted: row.status === 'completed',
    });
  }
  // Rows sorted by pseudonym so the file order does not reveal consent order.
  participants.sort((a, b) => a.participant.localeCompare(b.participant));
  return {
    schema: EXPORT_SCHEMA,
    study: { title: study.title, state: study.state, seedDigest: study.seed_digest, minCellSize: study.min_cell_size },
    arms: study.arms.map((a) => ({ id: a.id, label: a.label, behaviour: a.behaviour, suppressed: suppressed.has(a.id), included: suppressed.has(a.id) ? null : counts.get(a.id) ?? 0 })),
    included: suppressed.size ? null : rows.length,
    instruments: study.instruments,
    fields: EXPORT_FIELDS,
    participants,
  };
}
export type StudyExport = Awaited<ReturnType<typeof buildExport>>;

/** The same rows as CSV: one line per participant, fixed column order. Every value is a number,
 * a code or an item outcome, so no cell can start a spreadsheet formula. */
export function exportCsv(document: StudyExport) {
  const head = ['participant', 'arm', 'behaviour', 'consentedDay'];
  for (const set of INSTRUMENT_SETS) {
    head.push(`${set}_items`, `${set}_attempted`, `${set}_correct`, `${set}_score`, `${set}_complete`, `${set}_first_min`, `${set}_last_min`);
    for (const item of document.instruments[set]) head.push(`${set}:${item}`);
  }
  head.push('episodes_completed', 'episodes_total', 'course_completed');
  const cell = (v: unknown) => {
    const text = v === null || v === undefined ? '' : typeof v === 'boolean' ? (v ? '1' : '0') : String(v);
    return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  const lines = [head.map(cell).join(',')];
  for (const p of document.participants) {
    const line: unknown[] = [p.participant, p.arm, p.behaviour, p.consentedDay];
    for (const set of INSTRUMENT_SETS) {
      const s = p.sets[set] as { items: number; attempted: number; correct: number; score: number | null; complete: boolean; firstMinutes: number | null; lastMinutes: number | null; outcomes: Record<string, string> };
      line.push(s.items, s.attempted, s.correct, s.score, s.complete, s.firstMinutes, s.lastMinutes);
      for (const item of document.instruments[set]) line.push(s.outcomes[item]);
    }
    line.push(p.episodesCompleted, p.episodesTotal, p.courseCompleted);
    lines.push(line.map(cell).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}
