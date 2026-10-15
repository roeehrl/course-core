import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import type { Assessment } from '@course-core/sdk';
import type { Json } from '@course-core/providers';
import { membership, type Actor, type authService } from './auth.js';
import { transaction, type Database } from './database.js';
import { appendEvent } from './events.js';
import { ApiError, requireCondition } from './errors.js';
import { enrollmentCommand, type EnrollmentContext } from './repository.js';
import { gradeDeterministic } from './learning.js';
import { audienceOf, STAFF_READ_ROLES, type LearnerDataAudience } from './learner-privacy.js';
import {
  ACTIVE_STATUSES, DEFAULT_TRIGGER_POLICY, HYPOTHESIS_KINDS, confidenceLevel, evaluateTriggers, interpretProbe, probeEffects, teachingContracts,
  type HypothesisState, type HypothesisStatus, type TeachingContracts, type TeachingSignal, type TriggerDecision, type TriggerEffect, type TriggerPolicy,
} from './teaching-triggers.js';

/**
 * Teaching hypotheses, diagnostic probes and the trigger table at runtime.
 *
 *   GET  /api/enrollments/:id/learner-model/hypotheses
 *   POST /.../learner-model/hypotheses/:hypothesisId/decision
 *        {expectedRevision,idempotencyKey,expectedHypothesisRevision,action:correct|reject|pin|unpin|renew,correction?,reason?}
 *   POST /.../learner-model/diagnostics {expectedRevision,idempotencyKey,hypothesisId?|objectiveId?,note?}
 *   POST /.../learner-model/probes/:probeRunId/answer {expectedRevision,idempotencyKey,answer?|abstain:true}
 *
 * Only the learner changes their hypotheses; authorized staff may read them.
 * Every change is appended to teaching_hypothesis_changes. Hypotheses guide
 * teaching only: they never add, remove or lower evidence, and a probe answer
 * is never written as an attempt or evidence row.
 */
const id = z.string().regex(/^[a-z][a-z0-9._:-]{0,127}$/);
const uuid = z.uuid();
const command = { expectedRevision: z.number().int().positive().max(2147483646), idempotencyKey: z.string().regex(/^[A-Za-z0-9:_-]{8,200}$/) };
const decisionSchema = z.strictObject({ ...command, expectedHypothesisRevision: z.number().int().positive(),
  action: z.enum(['correct', 'reject', 'pin', 'unpin', 'renew']), correction: z.string().trim().min(1).max(500).optional(), reason: z.string().trim().max(500).optional() })
  .refine(v => (v.action === 'correct') === (v.correction !== undefined));
const diagnosticSchema = z.strictObject({ ...command, hypothesisId: uuid.optional(), objectiveId: id.optional(), note: z.string().trim().min(1).max(500).optional() })
  .refine(v => (v.hypothesisId === undefined) !== (v.objectiveId === undefined) && (v.note === undefined || v.objectiveId !== undefined));
const probeAnswerSchema = z.strictObject({ ...command, answer: z.union([z.string().max(200), z.number().finite()]).optional(), abstain: z.literal(true).optional() })
  .refine(v => (v.answer === undefined) !== (v.abstain === undefined));
export const MAX_DIAGNOSTIC_REQUESTS_PER_DAY = 3;

interface HypothesisRow {
  id: string; enrollment_id: string; workspace_id: string; template_id: string | null; kind: (typeof HYPOTHESIS_KINDS)[number]; statement: string;
  objective_ids: string[]; evidence_refs: EvidenceRef[]; uncertainty: 'low' | 'medium' | 'high'; status: HypothesisStatus;
  source: 'supervisor' | 'companion' | 'assessment' | 'learner'; pinned: boolean; learner_correction: string | null;
  rejected_by: 'learner' | 'evidence' | 'supervisor' | null; observations: number; course_digest: string; revision: number;
  expires_at: Date | null; created_at: Date; updated_at: Date; expired: boolean;
}
export interface EvidenceRef { kind: 'attempt' | 'event' | 'probe_run'; id: string; supports: boolean; at: string }
interface Scope { enrollmentId: string; workspaceId: string; courseDigest: string; contracts: TeachingContracts; bundle: unknown }
type Writer = { kind: 'learner'; actorId: string } | { kind: 'agent'; jobId: string } | { kind: 'system' };

const HYPOTHESIS_COLUMNS = `*,(expires_at IS NOT NULL AND expires_at<=clock_timestamp()) AS expired`;
/** Serializes hypothesis writes for one enrollment, then settles checks that
 * expired unanswered, so every write path (triggers, learner requests and
 * decisions, probe answers, supervisor tools) counts caps on current state. */
export async function lockHypotheses(client: PoolClient, enrollmentId: string) {
  await client.query("SELECT pg_advisory_xact_lock(hashtext('teaching-hypotheses:'||$1))", [enrollmentId]);
  await releaseExpiredProbes(client, enrollmentId);
}
/** A quick check that expired unanswered ends ('expired'): it no longer holds an
 * open-probe slot or blocks scheduling that check again. An idea it was testing
 * that has no other open check goes back to 'proposed' with a fresh idea
 * lifetime (a pinned idea keeps no expiry), so an unanswered check never holds a
 * hypothesis slot forever. Nothing about the learner's results changes. */
async function releaseExpiredProbes(client: PoolClient, enrollmentId: string) {
  const lapsed = (await client.query<{ id: string; hypothesis_ids: string[] }>(`UPDATE diagnostic_probe_runs SET state='expired'
    WHERE enrollment_id=$1 AND state='scheduled' AND expires_at<=clock_timestamp() RETURNING id,hypothesis_ids`, [enrollmentId])).rows;
  if (!lapsed.length) return;
  const open = new Set((await client.query<{ hypothesis_ids: string[] }>("SELECT hypothesis_ids FROM diagnostic_probe_runs WHERE enrollment_id=$1 AND state='scheduled'", [enrollmentId]))
    .rows.flatMap(row => row.hypothesis_ids));
  const ids = [...new Set(lapsed.flatMap(run => run.hypothesis_ids))].filter(id => !open.has(id));
  const rows = (await client.query<HypothesisRow>(`SELECT ${HYPOTHESIS_COLUMNS} FROM teaching_hypotheses WHERE enrollment_id=$1 AND id=ANY($2::uuid[]) AND status='probing' FOR UPDATE`,
    [enrollmentId, ids])).rows;
  for (const h of rows) {
    const next = await update(client, h, { status: 'proposed', expires_at: h.pinned ? null : ideaExpiry() });
    await recordChange(client, next, { kind: 'system' }, 'status_changed', { from: 'probing', to: 'proposed', reason: 'probe_expired_unanswered',
      probeRunIds: lapsed.filter(run => run.hypothesis_ids.includes(h.id)).map(run => run.id), expiresAt: next.expires_at?.toISOString() ?? null });
  }
}
async function hypotheses(client: PoolClient, enrollmentId: string) {
  return (await client.query<HypothesisRow>(`SELECT ${HYPOTHESIS_COLUMNS} FROM teaching_hypotheses WHERE enrollment_id=$1 ORDER BY updated_at DESC,id DESC LIMIT 200`, [enrollmentId])).rows;
}
const toState = (h: HypothesisRow): HypothesisState & { observations: number } => ({ id: h.id, templateId: h.template_id, kind: h.kind, status: h.status, pinned: h.pinned,
  rejectedBy: h.rejected_by, objectiveIds: h.objective_ids, expired: h.expired, observations: h.observations,
  evidenceAttemptIds: h.evidence_refs.filter(r => r.kind === 'attempt').map(r => r.id) });
const isActive = (h: HypothesisRow) => ACTIVE_STATUSES.includes(h.status) && !h.expired;

async function recordChange(client: PoolClient, h: Pick<HypothesisRow, 'id' | 'enrollment_id' | 'workspace_id' | 'revision'>, writer: Writer, action: string, data: Record<string, unknown>, eventId: string | null = null) {
  const changeId = randomUUID();
  await client.query(`INSERT INTO teaching_hypothesis_changes(id,hypothesis_id,enrollment_id,workspace_id,hypothesis_revision,actor_kind,actor_id,action,job_id,event_id,data)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [changeId, h.id, h.enrollment_id, h.workspace_id, h.revision, writer.kind,
    writer.kind === 'learner' ? writer.actorId : null, action, writer.kind === 'agent' ? writer.jobId : null, eventId, JSON.stringify(data)]);
  return changeId;
}
async function update(client: PoolClient, h: HypothesisRow, set: Partial<Pick<HypothesisRow, 'status' | 'uncertainty' | 'pinned' | 'learner_correction' | 'rejected_by' | 'observations' | 'evidence_refs'>> & { expires_at?: Date | null }) {
  const next = { ...h, ...set };
  const row = (await client.query<HypothesisRow>(`UPDATE teaching_hypotheses SET status=$2,uncertainty=$3,pinned=$4,learner_correction=$5,rejected_by=$6,observations=$7,evidence_refs=$8,
    expires_at=$9,revision=revision+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING ${HYPOTHESIS_COLUMNS}`,
  [h.id, next.status, next.uncertainty, next.pinned, next.learner_correction, next.rejected_by, Math.min(next.observations, 1000), JSON.stringify(next.evidence_refs.slice(-50)), next.expires_at])).rows[0]!;
  return row;
}
const expiry = (days: number) => new Date(Date.now() + days * 86_400_000);
/** Every proposed idea, whoever wrote it, has the same bounded lifetime unless
 * the learner pins it; the learner can renew it for another lifetime. */
const ideaExpiry = () => expiry(DEFAULT_TRIGGER_POLICY.proposedExpiryDays);
async function insertHypothesis(client: PoolClient, scope: Pick<Scope, 'enrollmentId' | 'workspaceId' | 'courseDigest'>, input: { templateId: string | null; kind: HypothesisRow['kind'];
  statement: string; objectiveIds: string[]; evidence: EvidenceRef[]; uncertainty: HypothesisRow['uncertainty']; status: HypothesisStatus; source: HypothesisRow['source']; expiresAt: Date | null }) {
  // A lapsed (expired, never resolved) hypothesis for the same template is renewed,
  // keeping one row and its history per template instead of a duplicate.
  const lapsed = input.templateId === null ? undefined : (await client.query<HypothesisRow>(`SELECT ${HYPOTHESIS_COLUMNS} FROM teaching_hypotheses
    WHERE enrollment_id=$1 AND template_id=$2 AND status IN ('proposed','probing','confirmed') AND expires_at<=clock_timestamp() FOR UPDATE`, [scope.enrollmentId, input.templateId])).rows[0];
  if (lapsed) return update(client, lapsed, { status: input.status, uncertainty: input.uncertainty, evidence_refs: [...lapsed.evidence_refs, ...input.evidence],
    observations: lapsed.observations + input.evidence.filter(e => e.supports).length, expires_at: input.expiresAt });
  return (await client.query<HypothesisRow>(`INSERT INTO teaching_hypotheses(id,enrollment_id,workspace_id,template_id,kind,statement,objective_ids,evidence_refs,uncertainty,status,source,observations,course_digest,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING ${HYPOTHESIS_COLUMNS}`, [randomUUID(), scope.enrollmentId, scope.workspaceId, input.templateId, input.kind, input.statement,
    JSON.stringify(input.objectiveIds), JSON.stringify(input.evidence), input.uncertainty, input.status, input.source, input.evidence.filter(e => e.supports).length, scope.courseDigest, input.expiresAt])).rows[0]!;
}

async function probeCounts(client: PoolClient, enrollmentId: string) {
  const runs = (await client.query<{ state: string; today: boolean; hypothesis_ids: string[] }>(`SELECT state,scheduled_at>clock_timestamp()-interval '1 day' AS today,hypothesis_ids
    FROM diagnostic_probe_runs WHERE enrollment_id=$1 AND (state='scheduled' OR scheduled_at>clock_timestamp()-interval '30 days') LIMIT 500`, [enrollmentId])).rows;
  return { open: runs.filter(r => r.state === 'scheduled').length, today: runs.filter(r => r.today).length, runs };
}
async function independentActive(client: PoolClient, enrollmentId: string) {
  return Boolean((await client.query("SELECT 1 FROM assessment_challenges WHERE enrollment_id=$1 AND attempt_id IS NULL AND independent_eligible AND expires_at>clock_timestamp() LIMIT 1", [enrollmentId])).rowCount);
}

/** Schedules one declared probe for hypotheses it distinguishes. Caps and the
 * independent-assessment fence apply to every requester. */
export async function scheduleProbe(client: PoolClient, scope: Scope, input: { probeId: string; hypothesisIds: string[]; requestedBy: 'supervisor' | 'learner' | 'trigger'; jobId?: string; requestId?: string },
  writer: Writer, policy: TriggerPolicy = DEFAULT_TRIGGER_POLICY) {
  const probe = scope.contracts.probes.find(p => p.id === input.probeId);
  requireCondition(probe, 'PROBE_NOT_AVAILABLE', 404);
  const rows = (await hypotheses(client, scope.enrollmentId)).filter(h => input.hypothesisIds.includes(h.id));
  requireCondition(rows.length === input.hypothesisIds.length && rows.length > 0, 'HYPOTHESIS_NOT_FOUND', 404);
  requireCondition(rows.every(h => isActive(h) && h.template_id && probe.distinguishes.includes(h.template_id)), 'PROBE_DOES_NOT_DISTINGUISH', 409);
  requireCondition(!(await independentActive(client, scope.enrollmentId)), 'INDEPENDENT_ASSESSMENT_ACTIVE', 409);
  const counts = await probeCounts(client, scope.enrollmentId);
  requireCondition(counts.open < policy.maxOpenProbeRuns, 'PROBE_OPEN_LIMIT', 409);
  requireCondition(counts.today < policy.maxProbeRunsPerDay, 'PROBE_DAILY_LIMIT', 409);
  for (const h of rows) requireCondition(counts.runs.filter(r => r.hypothesis_ids.includes(h.id)).length < policy.maxProbeRunsPerTemplate, 'PROBE_HYPOTHESIS_LIMIT', 409);
  requireCondition(!(await client.query("SELECT 1 FROM diagnostic_probe_runs WHERE enrollment_id=$1 AND probe_id=$2 AND state='scheduled'", [scope.enrollmentId, probe.id])).rowCount, 'PROBE_ALREADY_SCHEDULED', 409);
  const runId = randomUUID();
  await client.query(`INSERT INTO diagnostic_probe_runs(id,enrollment_id,workspace_id,probe_id,assessment_id,course_digest,hypothesis_ids,requested_by,request_id,job_id,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [runId, scope.enrollmentId, scope.workspaceId, probe.id, probe.assessmentId, scope.courseDigest, JSON.stringify(rows.map(h => h.id)),
    input.requestedBy, input.requestId ?? null, input.jobId ?? null, expiry(policy.probeExpiryDays)]);
  for (const h of rows) {
    // Testing a hypothesis does not change a learner's pin.
    const next = h.status === 'proposed' ? await update(client, h, { status: 'probing', expires_at: null }) : h;
    await recordChange(client, next, writer, 'probe_scheduled', { probeRunId: runId, probeId: probe.id, status: next.status });
  }
  return { probeRunId: runId, probeId: probe.id, hypothesisIds: rows.map(h => h.id), countsAsEvidence: false as const };
}

/** Applies trigger effects. The caller holds the enrollment's command lock or the hypothesis lock. */
async function applyEffects(client: PoolClient, scope: Scope, effects: TriggerEffect[], writer: Writer, ref: EvidenceRef | null, source: HypothesisRow['source'],
  policy: TriggerPolicy, skipped: TriggerDecision['skipped']) {
  const applied: Record<string, unknown>[] = [];
  for (const effect of effects) {
    if (effect.kind === 'propose_hypothesis') {
      const template = scope.contracts.templates.get(effect.templateId)!;
      const row = await insertHypothesis(client, scope, { templateId: template.id, kind: template.kind, statement: template.statement, objectiveIds: template.objectiveIds,
        evidence: ref ? [ref] : [], uncertainty: effect.uncertainty, status: effect.status, source, expiresAt: effect.status === 'proposed' ? expiry(policy.proposedExpiryDays) : null });
      await recordChange(client, row, writer, 'proposed', { templateId: template.id, status: row.status, uncertainty: row.uncertainty, source, evidenceRef: ref });
      applied.push({ kind: effect.kind, hypothesisId: row.id, templateId: template.id });
    } else if (effect.kind === 'observe_hypothesis') {
      const h = (await client.query<HypothesisRow>(`SELECT ${HYPOTHESIS_COLUMNS} FROM teaching_hypotheses WHERE id=$1 AND enrollment_id=$2 FOR UPDATE`, [effect.hypothesisId, scope.enrollmentId])).rows[0];
      if (!h || !ref) continue;
      const next = await update(client, h, { evidence_refs: [...h.evidence_refs, { ...ref, supports: effect.supports }], observations: h.observations + (effect.supports ? 1 : 0) });
      await recordChange(client, next, writer, 'observed', { evidenceRef: { ...ref, supports: effect.supports } });
      applied.push({ kind: effect.kind, hypothesisId: h.id, supports: effect.supports });
    } else if (effect.kind === 'set_status') {
      const h = (await client.query<HypothesisRow>(`SELECT ${HYPOTHESIS_COLUMNS} FROM teaching_hypotheses WHERE id=$1 AND enrollment_id=$2 FOR UPDATE`, [effect.hypothesisId, scope.enrollmentId])).rows[0];
      if (!h || h.pinned || h.rejected_by === 'learner' || h.status === effect.status) continue;
      const next = await update(client, h, { status: effect.status, uncertainty: effect.uncertainty, rejected_by: effect.status === 'rejected' ? 'evidence' : null,
        expires_at: effect.status === 'proposed' ? h.expires_at : null });
      await recordChange(client, next, writer, 'status_changed', { from: h.status, to: effect.status, uncertainty: effect.uncertainty, evidenceRef: ref });
      applied.push({ kind: effect.kind, hypothesisId: h.id, status: effect.status });
    } else {
      const current = (await hypotheses(client, scope.enrollmentId)).filter(h => isActive(h) && h.template_id && effect.templateIds.includes(h.template_id));
      if (!current.length) { skipped.push({ ruleId: 'probe', what: `probe:${effect.probeId}`, reason: 'no_active_hypothesis' }); continue; }
      try {
        const scheduled = await client.query('SAVEPOINT schedule_probe').then(() => scheduleProbe(client, scope, { probeId: effect.probeId, hypothesisIds: current.map(h => h.id), requestedBy: 'trigger' }, writer, policy));
        await client.query('RELEASE SAVEPOINT schedule_probe');
        applied.push({ kind: effect.kind, ...scheduled });
      } catch (error) {
        await client.query('ROLLBACK TO SAVEPOINT schedule_probe');
        if (!(error instanceof ApiError)) throw error;
        skipped.push({ ruleId: 'probe', what: `probe:${effect.probeId}`, reason: error.code.toLowerCase() });
      }
    }
  }
  return applied;
}

async function triggerState(client: PoolClient, enrollmentId: string, objectiveIds: string[], episodeId: string | null, policy: TriggerPolicy) {
  const window = `${policy.windowHours} hours`;
  const signals = (await client.query<{ signal_kind: string; objective_ids: string[]; source_ref: { episodeId?: string }; recent: boolean; recommendations: { action: string; objectiveIds: string[] }[] }>(
    `SELECT signal_kind,objective_ids,source_ref,recommendations,created_at>clock_timestamp()-make_interval(mins=>$3) AS recent FROM teaching_signals
     WHERE enrollment_id=$1 AND created_at>clock_timestamp()-$2::interval ORDER BY created_at DESC LIMIT 500`, [enrollmentId, window, policy.recommendationCooldownMinutes])).rows;
  const count = (kind: string, filter: (s: (typeof signals)[number]) => boolean = () => true) => Object.fromEntries(objectiveIds.map(o => [o,
    signals.filter(s => s.signal_kind === kind && s.objective_ids.includes(o) && filter(s)).length]));
  const counts = await probeCounts(client, enrollmentId), rows = await hypotheses(client, enrollmentId);
  const byTemplate: Record<string, number> = {};
  for (const run of counts.runs) for (const hid of run.hypothesis_ids) { const t = rows.find(h => h.id === hid)?.template_id; if (t) byTemplate[t] = (byTemplate[t] ?? 0) + 1; }
  return {
    hypotheses: rows.map(toState),
    recentIncorrectUnlinked: count('answer.incorrect', s => (s.source_ref as { linked?: boolean }).linked !== true),
    recentAbstained: count('answer.abstained'),
    recentQuestionsInEpisode: signals.filter(s => s.signal_kind === 'companion.question' && s.source_ref.episodeId === episodeId).length,
    openProbeRuns: counts.open, probeRunsToday: counts.today, probeRunsByTemplate: byTemplate,
    independentAssessmentActive: await independentActive(client, enrollmentId),
    recentRecommendations: signals.filter(s => s.recent).flatMap(s => s.recommendations.flatMap(r => r.objectiveIds.map(o => `${r.action}:${o}`))),
  };
}

/** The learner's course-scoped supervision opt-in (design §4 autonomy). Read
 * under the same share lock the supervisor's own writes use, so a concurrent
 * revocation either precedes this signal or waits for it. */
export async function automaticHypothesesEnabled(client: PoolClient, enrollmentId: string, workspaceId: string, lock = true) {
  return Boolean((await client.query<{ adaptive_teaching: boolean }>(
    `SELECT adaptive_teaching FROM supervisor_permissions WHERE enrollment_id=$1 AND workspace_id=$2${lock ? ' FOR SHARE' : ''}`, [enrollmentId, workspaceId])).rows[0]?.adaptive_teaching);
}

/** Runs the trigger table for one signal. Forming hypotheses, observing them,
 * scheduling probes and recommending teaching moves from what a learner does is
 * the supervisor's loop, so it runs only after the learner's supervision
 * opt-in. Without it nothing is inferred or stored: no hypothesis, probe or
 * signal row (so earlier activity is not replayed into triggers on a later
 * opt-in). The learner's own requests and probe answers are not gated. */
async function evaluateAndApply(client: PoolClient, scope: Scope, signal: TeachingSignal, signalKind: string, sourceRef: Record<string, unknown>, ref: EvidenceRef | null,
  source: HypothesisRow['source'], policy: TriggerPolicy) {
  if (!(await automaticHypothesesEnabled(client, scope.enrollmentId, scope.workspaceId))) return null;
  await lockHypotheses(client, scope.enrollmentId);
  const state = await triggerState(client, scope.enrollmentId, signal.objectiveIds, signal.kind === 'companion_question' ? signal.episodeId : null, policy);
  const decision = evaluateTriggers(signal, state, scope.contracts, policy);
  const applied = await applyEffects(client, scope, decision.effects, { kind: 'system' }, ref, source, policy, decision.skipped);
  await client.query(`INSERT INTO teaching_signals(id,enrollment_id,workspace_id,signal_kind,objective_ids,source_ref,rule_ids,effects,recommendations,restraints,skipped)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [randomUUID(), scope.enrollmentId, scope.workspaceId, signalKind, JSON.stringify(signal.objectiveIds.slice(0, 20)),
    JSON.stringify(sourceRef), JSON.stringify(decision.ruleIds), JSON.stringify(applied), JSON.stringify(decision.recommendations), JSON.stringify(decision.restraints), JSON.stringify(decision.skipped)]);
  return { ...decision, applied };
}

function scopeOf(context: EnrollmentContext): Scope {
  return { enrollmentId: context.enrollment.id, workspaceId: context.enrollment.workspace_id, courseDigest: context.release.digest,
    contracts: teachingContracts(context.release.server_bundle), bundle: context.release.server_bundle };
}

/** Called inside the answer transaction after the attempt is stored. Placement
 * answers are excluded: probing later material is expected to miss. */
export async function recordAnswerSignal(client: PoolClient, context: EnrollmentContext, input: { attemptId: string; assessment: Assessment; answer: unknown;
  passed: boolean; independent: boolean; mode: string; confidence?: number | null; abstained?: boolean }, policy: TriggerPolicy = DEFAULT_TRIGGER_POLICY) {
  if (input.mode === 'placement') return null;
  const scope = scopeOf(context), links = scope.contracts.links(input.assessment.id, input.answer);
  const scale = (input.assessment as Assessment & { confidence?: { scale?: { maximum?: number } } }).confidence?.scale?.maximum ?? 5;
  const outcome = input.abstained ? 'abstained' : input.passed ? 'correct' : 'incorrect';
  const signal: TeachingSignal = { kind: 'answer', attemptId: input.attemptId, assessmentId: input.assessment.id, objectiveIds: input.assessment.objectiveIds, outcome,
    linkedTemplateIds: outcome === 'incorrect' ? links.templateIds : [], linkSpecificity: outcome === 'incorrect' ? links.specificity : 'none',
    itemTemplateIds: scope.contracts.itemTemplates(input.assessment.id), confidence: confidenceLevel(input.confidence ?? null, scale), independent: input.independent };
  const ref: EvidenceRef = { kind: 'attempt', id: input.attemptId, supports: outcome === 'incorrect', at: new Date().toISOString() };
  return evaluateAndApply(client, scope, signal, `answer.${outcome}`, { attemptId: input.attemptId, assessmentId: input.assessment.id, linked: links.templateIds.length > 0 && outcome === 'incorrect', mode: input.mode },
    ref, 'assessment', policy);
}
/** Called inside the companion request transaction. A question never changes evidence. */
export async function recordCompanionSignal(client: PoolClient, context: EnrollmentContext, input: { eventId: string; episodeId: string }, policy: TriggerPolicy = DEFAULT_TRIGGER_POLICY) {
  const episode = context.release.server_bundle.chapters.flatMap(c => c.episodes).find(e => e.id === input.episodeId);
  if (!episode) return null;
  const signal: TeachingSignal = { kind: 'companion_question', eventId: input.eventId, episodeId: input.episodeId, objectiveIds: episode.objectiveIds.slice(0, 20) };
  return evaluateAndApply(client, scopeOf(context), signal, 'companion.question', { eventId: input.eventId, episodeId: input.episodeId },
    { kind: 'event', id: input.eventId, supports: true, at: new Date().toISOString() }, 'companion', policy);
}
/** Called when the learner appeals a judged answer. */
export async function recordGradeChallenge(client: PoolClient, context: EnrollmentContext, attemptId: string) {
  const objectiveIds = (await client.query<{ objective_id: string }>('SELECT DISTINCT objective_id FROM evidence WHERE attempt_id=$1 AND enrollment_id=$2 LIMIT 20', [attemptId, context.enrollment.id])).rows.map(r => r.objective_id);
  return evaluateAndApply(client, scopeOf(context), { kind: 'grade_challenged', attemptId, objectiveIds }, 'grade.challenged', { attemptId }, null, 'assessment', DEFAULT_TRIGGER_POLICY);
}

/** The probe item as shown to the learner: prompt and choices only. No key,
 * family, explanation or misconception link reaches the browser. */
function probeQuestion(assessment: Assessment) {
  if (assessment.type === 'choice') return { id: assessment.id, type: 'choice' as const, prompt: assessment.prompt, options: assessment.options.map(o => ({ id: o.id, text: o.text })) };
  const unit = (assessment.grading as { unit?: unknown }).unit;
  return { id: assessment.id, type: 'numeric' as const, prompt: assessment.prompt, ...(typeof unit === 'string' ? { unit } : {}) };
}
function assessmentOf(bundle: unknown, assessmentId: string) {
  return ((bundle as { assessments?: Assessment[] }).assessments ?? []).find(a => a.id === assessmentId);
}

/** Who reads a hypothesis projection, from the shared rule in learner-privacy.ts.
 * Staff see what the course and the system proposed and how the learner
 * responded, never the learner's own words: their corrections, request notes,
 * probe answers and self-written hypotheses stay private to them. */
export type HypothesisAudience = LearnerDataAudience;
const ownWords = (h: Pick<HypothesisRow, 'source' | 'template_id'>) => h.source === 'learner' && h.template_id === null;

/** Learner-facing projection: plain statements, status, uncertainty, source and
 * evidence references. Read-only staff views get the same shape with the
 * learner's own words withheld. */
export async function hypothesisView(client: PoolClient, enrollmentId: string, bundle: unknown, audience: HypothesisAudience = 'learner') {
  const staff = audience === 'staff';
  const rows = (await hypotheses(client, enrollmentId)).slice(0, 30);
  const contracts = teachingContracts(bundle);
  const runs = (await client.query<{ id: string; probe_id: string; assessment_id: string; hypothesis_ids: string[]; requested_by: string; state: string; outcome: unknown; scheduled_at: Date; expires_at: Date; answered_at: Date | null; expired: boolean }>(
    `SELECT id,probe_id,assessment_id,hypothesis_ids,requested_by,state,outcome,scheduled_at,expires_at,answered_at,expires_at<=clock_timestamp() AS expired FROM diagnostic_probe_runs
     WHERE enrollment_id=$1 ORDER BY scheduled_at DESC LIMIT 20`, [enrollmentId])).rows;
  const requests = (await client.query<{ id: string; hypothesisId: string | null; objectiveId: string | null; note: string | null; state: string; probeRunId: string | null; createdAt: Date }>(
    `SELECT id,hypothesis_id AS "hypothesisId",objective_id AS "objectiveId",note,state,probe_run_id AS "probeRunId",created_at AS "createdAt"
    FROM diagnostic_requests WHERE enrollment_id=$1 ORDER BY created_at DESC LIMIT 10`, [enrollmentId])).rows
    .map(({ note, ...request }) => staff ? { ...request, note: null, noteWithheld: note !== null } : { ...request, note });
  return {
    items: rows.map(h => ({
      hypothesisId: h.id, revision: h.revision, templateId: h.template_id, kind: h.kind,
      statement: staff && ownWords(h) ? null : h.statement, learnerCorrection: staff ? null : h.learner_correction,
      correctedByLearner: h.learner_correction !== null, ...(staff ? { statementWithheld: ownWords(h) } : {}),
      status: h.expired && ACTIVE_STATUSES.includes(h.status) ? 'expired' : h.status, uncertainty: h.uncertainty, source: h.source, pinned: h.pinned,
      rejectedBy: h.rejected_by, objectiveIds: h.objective_ids, observations: h.observations,
      evidenceRefs: h.evidence_refs.slice(-10), evidenceRefsTruncated: h.evidence_refs.length > 10,
      expiresAt: h.expires_at?.toISOString() ?? null, createdAt: h.created_at.toISOString(), updatedAt: h.updated_at.toISOString(),
      probeAvailable: Boolean(h.template_id && contracts.probes.some(p => p.distinguishes.includes(h.template_id!))),
      grantsMastery: false as const,
    })),
    probes: runs.map(r => {
      const assessment = assessmentOf(bundle, r.assessment_id), open = r.state === 'scheduled' && !r.expired;
      return { probeRunId: r.id, probeId: r.probe_id, hypothesisIds: r.hypothesis_ids, requestedBy: r.requested_by, state: r.state === 'scheduled' && r.expired ? 'expired' : r.state,
        question: open && assessment && (assessment.type === 'choice' || assessment.type === 'numeric') ? probeQuestion(assessment) : null,
        outcome: r.outcome, scheduledAt: r.scheduled_at.toISOString(), expiresAt: r.expires_at.toISOString(), answeredAt: r.answered_at?.toISOString() ?? null, countsAsEvidence: false as const };
    }),
    requests,
    limits: { diagnosticRequestsPerDay: MAX_DIAGNOSTIC_REQUESTS_PER_DAY, openProbes: DEFAULT_TRIGGER_POLICY.maxOpenProbeRuns, probesPerDay: DEFAULT_TRIGGER_POLICY.maxProbeRunsPerDay,
      activeIdeas: DEFAULT_TRIGGER_POLICY.maxActiveHypotheses, ideaLifetimeDays: DEFAULT_TRIGGER_POLICY.proposedExpiryDays },
    notEvidence: true as const,
  };
}

/** Why the model sees no hypotheses: the learner has not opted in, or revoked. */
export const HYPOTHESES_WITHHELD = 'personal_lesson_support_off' as const;
/** Provider projection: active hypotheses only. Rejected, resolved and expired
 * ones are left out; a learner's correction replaces the original statement.
 *
 * Teaching hypotheses, including ideas the learner wrote and their corrections,
 * are part of the supervisor's loop (design §4/§5), so they reach a model only
 * while the learner's course-scoped supervision opt-in is on. The consent text
 * names this use. Without it the projection is empty. The rows are this
 * enrollment's only; staff write no hypothesis text, and decision reasons,
 * request notes and probe answers are never included. */
export async function providerHypotheses(client: PoolClient, enrollmentId: string, workspaceId: string, objectiveIds: string[]) {
  if (!(await automaticHypothesesEnabled(client, enrollmentId, workspaceId, false))) return { hypotheses: [], recommendedActions: [], withheld: HYPOTHESES_WITHHELD };
  const rows = (await hypotheses(client, enrollmentId)).filter(h => isActive(h) && h.objective_ids.some(o => objectiveIds.includes(o))).slice(0, 5);
  const recent = (await client.query<{ recommendations: { action: string; objectiveIds: string[]; ruleId: string }[] }>(
    "SELECT recommendations FROM teaching_signals WHERE enrollment_id=$1 AND created_at>clock_timestamp()-interval '1 day' AND recommendations<>'[]'::jsonb ORDER BY created_at DESC LIMIT 3", [enrollmentId])).rows;
  return {
    hypotheses: rows.map(h => ({ hypothesisId: h.id, kind: h.kind, statement: (h.learner_correction ?? h.statement).slice(0, 300), correctedByLearner: h.learner_correction !== null,
      status: h.status, uncertainty: h.uncertainty, pinnedByLearner: h.pinned, objectiveIds: h.objective_ids, observations: h.observations, authority: 'teaching_hypothesis_not_evidence' })),
    recommendedActions: recent.flatMap(r => r.recommendations).filter(r => r.objectiveIds.some(o => objectiveIds.includes(o))).slice(0, 3),
  };
}

async function readScope(client: PoolClient, actor: Actor, enrollmentId: string) {
  const enrollment = (await client.query<{ id: string; workspace_id: string; user_id: string; status: string; course_release_id: string }>('SELECT id,workspace_id,user_id,status,course_release_id FROM enrollments WHERE id=$1', [enrollmentId])).rows[0];
  requireCondition(enrollment, 'ENROLLMENT_NOT_FOUND', 404);
  const role = await membership(client, actor, enrollment.workspace_id);
  requireCondition(audienceOf(actor.id, enrollment) === 'learner' || (STAFF_READ_ROLES as readonly string[]).includes(role), 'ENROLLMENT_NOT_FOUND', 404);
  requireCondition(enrollment.status !== 'erased', 'ENROLLMENT_ERASED', 410);
  const release = (await client.query<{ server_bundle: unknown; digest: string }>('SELECT server_bundle,digest FROM course_releases WHERE id=$1 AND workspace_id=$2', [enrollment.course_release_id, enrollment.workspace_id])).rows[0]!;
  return { enrollment, release };
}

export function registerTeachingHypothesisRoutes(app: FastifyInstance, db: Database, auth: ReturnType<typeof authService>) {
  const base = '/api/enrollments/:enrollmentId/learner-model';
  const parse = <T>(schema: z.ZodType<T>, value: unknown): T => { const r = schema.safeParse(value); requireCondition(r.success, 'INVALID_REQUEST'); return r.data; };
  const params = (value: unknown) => parse(z.object({ enrollmentId: uuid }), value).enrollmentId;
  const learnerOnly = (context: EnrollmentContext, actor: Actor) => requireCondition(context.enrollment.user_id === actor.id, 'LEARNER_ONLY', 403);
  const receipt = async (client: PoolClient, context: EnrollmentContext, actor: Actor, type: string, payload: Record<string, unknown>, key: string, supervise = false) => {
    await client.query('UPDATE enrollments SET revision=revision+1 WHERE id=$1', [context.enrollment.id]);
    return appendEvent(client, { workspaceId: context.enrollment.workspace_id, enrollmentId: context.enrollment.id, actorId: actor.id, actorKind: 'learner', type,
      payload: { ...payload, grantsMastery: false }, idempotencyKey: `${context.enrollment.id}:${key}`, supervise });
  };

  app.get(`${base}/hypotheses`, async request => {
    const actor = await auth.authenticate(request), enrollmentId = params(request.params);
    // A check that lapsed unanswered is settled before the learner reads, so the view and the
    // revisions their next decision is fenced on are current (releaseExpiredProbes).
    if ((await db.query("SELECT 1 FROM diagnostic_probe_runs WHERE enrollment_id=$1 AND state='scheduled' AND expires_at<=clock_timestamp() LIMIT 1", [enrollmentId])).rowCount)
      await transaction(db, async client => {
        const { enrollment } = await readScope(client, actor, enrollmentId);
        if (audienceOf(actor.id, enrollment) === 'learner') await lockHypotheses(client, enrollmentId);
      });
    return transaction(db, async client => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const { enrollment, release } = await readScope(client, actor, enrollmentId);
      const view = await hypothesisView(client, enrollmentId, release.server_bundle, audienceOf(actor.id, enrollment));
      const revision = (await client.query<{ revision: number }>('SELECT revision FROM enrollments WHERE id=$1', [enrollmentId])).rows[0]!.revision;
      // Whether answers and questions may suggest ideas on their own (the supervision opt-in).
      const automaticIdeas = await automaticHypothesesEnabled(client, enrollmentId, enrollment.workspace_id, false);
      return { enrollmentId, workspaceId: enrollment.workspace_id, courseDigest: release.digest, revision, ...view, automaticIdeas };
    });
  });

  app.post(`${base}/hypotheses/:hypothesisId/decision`, { bodyLimit: 8192 }, async request => {
    const actor = await auth.authenticate(request), enrollmentId = params(request.params);
    const { hypothesisId } = parse(z.object({ hypothesisId: uuid }), request.params), input = parse(decisionSchema, request.body);
    return enrollmentCommand(db, actor, enrollmentId, 'learner_model.hypothesis', { ...input, hypothesisId }, async (client, context) => {
      learnerOnly(context, actor);
      await lockHypotheses(client, enrollmentId);
      const h = (await client.query<HypothesisRow>(`SELECT ${HYPOTHESIS_COLUMNS} FROM teaching_hypotheses WHERE id=$1 AND enrollment_id=$2 AND workspace_id=$3 FOR UPDATE`,
        [hypothesisId, enrollmentId, context.enrollment.workspace_id])).rows[0];
      requireCondition(h, 'HYPOTHESIS_NOT_FOUND', 404);
      // A supervisor or trigger changed it since the learner looked: refresh, never overwrite.
      requireCondition(h.revision === input.expectedHypothesisRevision, 'HYPOTHESIS_CHANGED', 409);
      requireCondition(h.status !== 'rejected' || input.action === 'unpin', 'HYPOTHESIS_REJECTED', 409);
      const writer: Writer = { kind: 'learner', actorId: actor.id };
      // Bringing back a lapsed idea (pin or renew) needs room under the active cap.
      const reactivates = h.expired && ACTIVE_STATUSES.includes(h.status) && (input.action === 'pin' || input.action === 'renew');
      if (reactivates) requireCondition((await hypotheses(client, enrollmentId)).filter(isActive).length < DEFAULT_TRIGGER_POLICY.maxActiveHypotheses, 'HYPOTHESIS_LIMIT', 409);
      let next: HypothesisRow, action: string;
      if (input.action === 'correct') { next = await update(client, h, { learner_correction: input.correction! }); action = 'corrected'; }
      else if (input.action === 'reject') { next = await update(client, h, { status: 'rejected', rejected_by: 'learner', pinned: false, expires_at: null }); action = 'rejected'; }
      else if (input.action === 'pin') { requireCondition(!h.pinned, 'HYPOTHESIS_ALREADY_PINNED', 409); next = await update(client, h, { pinned: true, expires_at: null }); action = 'pinned'; }
      else if (input.action === 'renew') {
        // Only a proposed, unpinned idea lapses; probing and confirmed ones follow their checks.
        requireCondition(h.status === 'proposed' && !h.pinned && h.expires_at !== null, 'HYPOTHESIS_NOT_EXPIRING', 409);
        next = await update(client, h, { expires_at: ideaExpiry() }); action = 'renewed';
      }
      // An unpinned proposed idea gets a fresh bounded lifetime instead of none.
      else { requireCondition(h.pinned, 'HYPOTHESIS_NOT_PINNED', 409); next = await update(client, h, { pinned: false, ...(h.status === 'proposed' ? { expires_at: ideaExpiry() } : {}) }); action = 'unpinned'; }
      const event = await receipt(client, context, actor, 'learner_model.hypothesis.reviewed', { hypothesisId, action, hypothesisRevision: next.revision }, input.idempotencyKey);
      const changeId = await recordChange(client, next, writer, action, { from: { status: h.status, pinned: h.pinned, learnerCorrection: h.learner_correction,
        expiresAt: h.expires_at?.toISOString() ?? null }, ...(input.correction ? { correction: input.correction } : {}),
        ...(next.expires_at?.getTime() !== h.expires_at?.getTime() ? { expiresAt: next.expires_at?.toISOString() ?? null } : {}), reason: input.reason ?? '' }, event.id);
      return { hypothesisId, hypothesisRevision: next.revision, status: next.status, pinned: next.pinned, expiresAt: next.expires_at?.toISOString() ?? null,
        changeId, eventId: event.id, revision: context.enrollment.revision + 1, grantsMastery: false };
    });
  });

  app.post(`${base}/diagnostics`, { bodyLimit: 8192 }, async request => {
    const actor = await auth.authenticate(request), enrollmentId = params(request.params), input = parse(diagnosticSchema, request.body);
    return enrollmentCommand(db, actor, enrollmentId, 'learner_model.diagnostic', input, async (client, context) => {
      learnerOnly(context, actor);
      await lockHypotheses(client, enrollmentId);
      const today = Number((await client.query<{ n: string }>("SELECT count(*) AS n FROM diagnostic_requests WHERE enrollment_id=$1 AND created_at>clock_timestamp()-interval '1 day'", [enrollmentId])).rows[0]!.n);
      requireCondition(today < MAX_DIAGNOSTIC_REQUESTS_PER_DAY, 'DIAGNOSTIC_REQUEST_LIMIT', 409);
      const scope = scopeOf(context), writer: Writer = { kind: 'learner', actorId: actor.id }, requestId = randomUUID();
      let targets: HypothesisRow[] = [], probeId: string | undefined, capped = false;
      if (input.hypothesisId) {
        const h = (await hypotheses(client, enrollmentId)).find(row => row.id === input.hypothesisId);
        requireCondition(h, 'HYPOTHESIS_NOT_FOUND', 404);
        requireCondition(isActive(h), 'HYPOTHESIS_NOT_ACTIVE', 409);
        targets = [h];
        probeId = h.template_id ? scope.contracts.probes.find(p => p.distinguishes.includes(h.template_id!))?.id : undefined;
      } else {
        requireCondition(context.release.server_bundle.objectives.some(o => o.id === input.objectiveId), 'OBJECTIVE_OUT_OF_SCOPE', 404);
        // Every active hypothesis counts toward the same cap, whoever wrote it:
        // the learner's own idea is refused at the cap (reject one to make room),
        // and course ideas a request would open are added only while room remains.
        let active = (await hypotheses(client, enrollmentId)).filter(isActive).length;
        const cap = DEFAULT_TRIGGER_POLICY.maxActiveHypotheses;
        if (input.note) {
          requireCondition(active < cap, 'HYPOTHESIS_LIMIT', 409);
          active++;
          const own = await insertHypothesis(client, scope, { templateId: null, kind: 'misconception', statement: input.note, objectiveIds: [input.objectiveId!], evidence: [],
            uncertainty: 'high', status: 'proposed', source: 'learner', expiresAt: ideaExpiry() });
          await recordChange(client, own, writer, 'proposed', { source: 'learner', statement: input.note, expiresAt: own.expires_at?.toISOString() ?? null });
        }
        const probe = scope.contracts.probes.find(p => p.objectiveId === input.objectiveId);
        if (probe) {
          probeId = probe.id;
          const rows = await hypotheses(client, enrollmentId);
          for (const templateId of probe.distinguishes) {
            const existing = rows.find(h => h.template_id === templateId && (isActive(h) || h.rejected_by === 'learner'));
            if (existing) { if (isActive(existing)) targets.push(existing); continue; }
            if (active >= cap) { capped = true; continue; }
            active++;
            const template = scope.contracts.templates.get(templateId)!;
            const created = await insertHypothesis(client, scope, { templateId, kind: template.kind, statement: template.statement, objectiveIds: template.objectiveIds, evidence: [],
              uncertainty: 'high', status: 'proposed', source: 'learner', expiresAt: expiry(DEFAULT_TRIGGER_POLICY.proposedExpiryDays) });
            await recordChange(client, created, writer, 'proposed', { templateId, source: 'learner', reason: 'learner_requested_diagnostic' });
            targets.push(created);
          }
        }
      }
      let scheduled: Awaited<ReturnType<typeof scheduleProbe>> | null = null, waitingReason: string | null = !probeId ? 'no_declared_probe' : !targets.length && capped ? 'active_hypothesis_cap' : null;
      if (probeId && targets.length) {
        try {
          await client.query('SAVEPOINT learner_probe');
          scheduled = await scheduleProbe(client, scope, { probeId, hypothesisIds: targets.map(h => h.id), requestedBy: 'learner', requestId }, writer);
          await client.query('RELEASE SAVEPOINT learner_probe');
        } catch (error) {
          await client.query('ROLLBACK TO SAVEPOINT learner_probe');
          if (!(error instanceof ApiError)) throw error;
          waitingReason = error.code.toLowerCase();
        }
      }
      // Without a probe the supervisor sees the request through the event outbox.
      const event = await receipt(client, context, actor, 'learner_model.diagnostic.requested', { requestId, probeRunId: scheduled?.probeRunId ?? null, waitingReason }, input.idempotencyKey, !scheduled);
      await client.query(`INSERT INTO diagnostic_requests(id,enrollment_id,workspace_id,hypothesis_id,objective_id,note,state,probe_run_id,event_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [requestId, enrollmentId, context.enrollment.workspace_id, input.hypothesisId ?? null, input.objectiveId ?? null, input.note ?? null, scheduled ? 'probe_scheduled' : 'awaiting_supervisor', scheduled?.probeRunId ?? null, event.id]);
      return { requestId, state: scheduled ? 'probe_scheduled' : 'awaiting_supervisor', probeRunId: scheduled?.probeRunId ?? null, waitingReason, eventId: event.id,
        revision: context.enrollment.revision + 1, grantsMastery: false, countsAsEvidence: false };
    });
  });

  app.post(`${base}/probes/:probeRunId/answer`, { bodyLimit: 8192 }, async request => {
    const actor = await auth.authenticate(request), enrollmentId = params(request.params);
    const { probeRunId } = parse(z.object({ probeRunId: uuid }), request.params), input = parse(probeAnswerSchema, request.body);
    return enrollmentCommand(db, actor, enrollmentId, 'learner_model.probe_answer', { ...input, probeRunId }, async (client, context) => {
      learnerOnly(context, actor);
      await lockHypotheses(client, enrollmentId);
      const run = (await client.query<{ id: string; probe_id: string; assessment_id: string; course_digest: string; hypothesis_ids: string[]; state: string; expired: boolean }>(
        `SELECT id,probe_id,assessment_id,course_digest,hypothesis_ids,state,expires_at<=clock_timestamp() AS expired FROM diagnostic_probe_runs WHERE id=$1 AND enrollment_id=$2 AND workspace_id=$3 FOR UPDATE`,
        [probeRunId, enrollmentId, context.enrollment.workspace_id])).rows[0];
      requireCondition(run, 'PROBE_NOT_FOUND', 404);
      requireCondition(run.state === 'scheduled', 'PROBE_ALREADY_ANSWERED', 409);
      requireCondition(!run.expired, 'PROBE_EXPIRED', 409);
      requireCondition(run.course_digest === context.release.digest, 'COURSE_VERSION_CHANGED', 409);
      const scope = scopeOf(context), probe = scope.contracts.probes.find(p => p.id === run.probe_id), assessment = assessmentOf(context.release.server_bundle, run.assessment_id);
      requireCondition(probe && assessment, 'PROBE_NOT_AVAILABLE', 409);
      let correct: boolean | null = null, explanation: string | null = null;
      if (!input.abstain) { const graded = gradeDeterministic(assessment, input.answer); correct = graded.passed; explanation = graded.explanation; }
      const outcome = input.abstain ? 'abstained' as const : correct ? 'correct' as const : 'incorrect' as const;
      const interpretation = interpretProbe(probe, { outcome, ...(typeof input.answer === 'string' ? { optionId: input.answer } : {}) });
      const rows = (await hypotheses(client, enrollmentId)).filter(h => run.hypothesis_ids.includes(h.id));
      const result = probeEffects(rows.map(toState), interpretation);
      const writer: Writer = { kind: 'learner', actorId: actor.id }, ref: EvidenceRef = { kind: 'probe_run', id: run.id, supports: true, at: new Date().toISOString() };
      const skipped: TriggerDecision['skipped'] = [];
      const event = await receipt(client, context, actor, 'diagnostic.probe.answered', { probeRunId: run.id, probeId: probe.id, outcome, countsAsEvidence: false }, input.idempotencyKey, true);
      // Effects are applied as the system: the learner answered; the interpretation is the probe's.
      const applied = await applyEffects(client, scope, result.effects, { kind: 'system' }, ref, 'assessment', DEFAULT_TRIGGER_POLICY, skipped);
      for (const h of rows) await recordChange(client, (await client.query<HypothesisRow>('SELECT * FROM teaching_hypotheses WHERE id=$1', [h.id])).rows[0]!, writer, 'probe_answered',
        { probeRunId: run.id, outcome, supported: interpretation.supported.includes(h.template_id ?? ''), ruledOut: interpretation.ruledOut.includes(h.template_id ?? '') }, event.id);
      const recorded = { outcome, correct, conclusive: interpretation.conclusive, supportedTemplateIds: interpretation.supported, ruledOutTemplateIds: interpretation.ruledOut, applied, restraints: result.restraints };
      await client.query(`UPDATE diagnostic_probe_runs SET state=$2,response=$3,outcome=$4,answered_at=clock_timestamp() WHERE id=$1`,
        [run.id, input.abstain ? 'abstained' : 'answered', JSON.stringify(input.abstain ? { abstained: true } : { answer: input.answer }), JSON.stringify(recorded)]);
      await client.query("UPDATE diagnostic_requests SET state='fulfilled' WHERE probe_run_id=$1 AND enrollment_id=$2", [run.id, enrollmentId]);
      const after = (await hypotheses(client, enrollmentId)).filter(h => run.hypothesis_ids.includes(h.id));
      return { probeRunId: run.id, outcome, correct, explanation, conclusive: interpretation.conclusive,
        hypotheses: after.map(h => ({ hypothesisId: h.id, status: h.status, uncertainty: h.uncertainty, pinned: h.pinned, revision: h.revision })),
        eventId: event.id, revision: context.enrollment.revision + 1, countsAsEvidence: false, grantsMastery: false };
    });
  });
}

// ---------------------------------------------------------------- supervisor tools

const evidenceEventIds = z.array(uuid).min(1).max(8).refine(v => new Set(v).size === v.length);
export const hypothesisToolSchemas = {
  list_hypotheses: z.strictObject({}),
  propose_hypothesis: z.union([
    z.strictObject({ templateId: id, evidenceEventIds, uncertainty: z.enum(['medium', 'high']) }),
    z.strictObject({ kind: z.enum(['misconception', 'missing_prerequisite', 'useful_analogy']), statement: z.string().trim().min(10).max(300), objectiveIds: z.array(id).min(1).max(4),
      evidenceEventIds, uncertainty: z.enum(['medium', 'high']) }),
  ]),
  update_hypothesis: z.strictObject({ hypothesisId: uuid, expectedRevision: z.number().int().positive(), status: z.enum(['probing', 'rejected', 'resolved']).optional(),
    uncertainty: z.enum(['medium', 'high']).optional(), evidenceEventIds: evidenceEventIds.optional() })
    .refine(v => v.status !== undefined || v.uncertainty !== undefined || v.evidenceEventIds !== undefined),
  schedule_probe: z.strictObject({ probeId: id, hypothesisIds: z.array(uuid).min(1).max(8).refine(v => new Set(v).size === v.length) }),
  read_probe_results: z.strictObject({}),
} as const;
export type HypothesisToolName = keyof typeof hypothesisToolSchemas;
export const HYPOTHESIS_TOOL_NAMES = Object.keys(hypothesisToolSchemas) as HypothesisToolName[];

/** Inside the supervisor tool transaction. The scope comes from the admitted
 * run, never from model arguments. Writes need the learner's supervision
 * opt-in, respect learner pins/rejections and the same caps as triggers. */
export async function invokeHypothesisTool(client: PoolClient, name: HypothesisToolName, args: unknown,
  run: { jobId: string; enrollmentId: string; workspaceId: string; bundle: unknown; digest: string; episodeObjectiveIds: string[]; consent: boolean }): Promise<Json> {
  const contracts = teachingContracts(run.bundle), scope: Scope = { enrollmentId: run.enrollmentId, workspaceId: run.workspaceId, courseDigest: run.digest, contracts, bundle: run.bundle };
  const writer: Writer = { kind: 'agent', jobId: run.jobId };
  // Reads return learner data (hypotheses, the learner's own ideas and
  // corrections, rejections, probe outcomes) only under the supervision opt-in,
  // read under the tool transaction's share lock. Course templates and probes
  // are course data and stay available.
  if (!run.consent && name === 'list_hypotheses') return { hypotheses: [], learnerRejectedTemplateIds: [], withheld: HYPOTHESES_WITHHELD,
    templates: [...contracts.templates.values()].filter(t => t.objectiveIds.some(o => run.episodeObjectiveIds.includes(o))).slice(0, 12)
      .map(t => ({ templateId: t.id, kind: t.kind, statement: t.statement, objectiveIds: t.objectiveIds })),
    probes: contracts.probes.filter(p => run.episodeObjectiveIds.includes(p.objectiveId)).slice(0, 8).map(p => ({ probeId: p.id, objectiveId: p.objectiveId, distinguishes: p.distinguishes })),
    authority: 'teaching_hypotheses_not_evidence' };
  if (!run.consent && name === 'read_probe_results') return { runs: [], withheld: HYPOTHESES_WITHHELD, responsesIncluded: false, countsAsEvidence: false };
  if (name === 'list_hypotheses') {
    const rows = await hypotheses(client, run.enrollmentId);
    const inScope = (objectiveIds: string[]) => objectiveIds.some(o => run.episodeObjectiveIds.includes(o));
    return {
      hypotheses: rows.filter(h => isActive(h) && inScope(h.objective_ids)).slice(0, 8).map(h => ({ hypothesisId: h.id, revision: h.revision, templateId: h.template_id, kind: h.kind,
        statement: (h.learner_correction ?? h.statement).slice(0, 300), correctedByLearner: h.learner_correction !== null, status: h.status, uncertainty: h.uncertainty,
        pinnedByLearner: h.pinned, source: h.source, observations: h.observations, objectiveIds: h.objective_ids })),
      learnerRejectedTemplateIds: [...new Set(rows.filter(h => h.rejected_by === 'learner' && h.template_id).map(h => h.template_id!))],
      templates: [...contracts.templates.values()].filter(t => inScope(t.objectiveIds)).slice(0, 12).map(t => ({ templateId: t.id, kind: t.kind, statement: t.statement, objectiveIds: t.objectiveIds })),
      probes: contracts.probes.filter(p => run.episodeObjectiveIds.includes(p.objectiveId)).slice(0, 8).map(p => ({ probeId: p.id, objectiveId: p.objectiveId, distinguishes: p.distinguishes })),
      authority: 'teaching_hypotheses_not_evidence', learnerControls: 'learner may correct, reject or pin; pinned and rejected hypotheses cannot be changed by tools',
    };
  }
  if (name === 'read_probe_results') {
    const runs = (await client.query(`SELECT id AS "probeRunId",probe_id AS "probeId",hypothesis_ids AS "hypothesisIds",state,requested_by AS "requestedBy",
      outcome->>'outcome' AS outcome,outcome->'supportedTemplateIds' AS "supportedTemplateIds",outcome->'ruledOutTemplateIds' AS "ruledOutTemplateIds",(outcome->>'conclusive')::boolean AS conclusive,
      scheduled_at AS "scheduledAt",answered_at AS "answeredAt" FROM diagnostic_probe_runs WHERE enrollment_id=$1 ORDER BY scheduled_at DESC LIMIT 10`, [run.enrollmentId])).rows;
    return { runs: runs.map(r => ({ ...r, scheduledAt: new Date(r.scheduledAt).toISOString(), answeredAt: r.answeredAt ? new Date(r.answeredAt).toISOString() : null })),
      responsesIncluded: false, countsAsEvidence: false };
  }
  requireCondition(run.consent, 'SUPERVISION_CONSENT_REQUIRED', 409);
  await lockHypotheses(client, run.enrollmentId);
  const sources = async (ids: string[]) => {
    const rows = (await client.query<{ id: string }>(`SELECT id FROM learning_events WHERE enrollment_id=$1 AND workspace_id=$2 AND id=ANY($3::uuid[]) AND actor_kind='learner'
      AND event_type IN ('assessment.submitted','companion.requested','diagnostic.probe.answered','learner_model.diagnostic.requested')`, [run.enrollmentId, run.workspaceId, ids])).rows;
    requireCondition(rows.length === ids.length, 'SOURCE_EVENT_OUT_OF_SCOPE', 404);
    const at = new Date().toISOString();
    return ids.map(eventId => ({ kind: 'event' as const, id: eventId, supports: true, at }));
  };
  if (name === 'propose_hypothesis') {
    const input = hypothesisToolSchemas.propose_hypothesis.parse(args);
    const rows = await hypotheses(client, run.enrollmentId);
    requireCondition(rows.filter(isActive).length < DEFAULT_TRIGGER_POLICY.maxActiveHypotheses, 'HYPOTHESIS_LIMIT', 409);
    const evidence = await sources(input.evidenceEventIds);
    let row: HypothesisRow;
    if ('templateId' in input) {
      const template = contracts.templates.get(input.templateId);
      requireCondition(template && template.objectiveIds.some(o => run.episodeObjectiveIds.includes(o)), 'HYPOTHESIS_TEMPLATE_OUT_OF_SCOPE', 404);
      const existing = rows.find(h => h.template_id === template.id && (isActive(h) || h.rejected_by === 'learner'));
      requireCondition(existing?.rejected_by !== 'learner', 'HYPOTHESIS_REJECTED_BY_LEARNER', 409);
      requireCondition(!existing, 'HYPOTHESIS_ALREADY_ACTIVE', 409);
      row = await insertHypothesis(client, scope, { templateId: template.id, kind: template.kind, statement: template.statement, objectiveIds: template.objectiveIds, evidence,
        uncertainty: input.uncertainty, status: 'proposed', source: 'supervisor', expiresAt: expiry(DEFAULT_TRIGGER_POLICY.proposedExpiryDays) });
    } else {
      requireCondition(input.objectiveIds.every(o => run.episodeObjectiveIds.includes(o)), 'OBJECTIVE_OUT_OF_SCOPE', 404);
      row = await insertHypothesis(client, scope, { templateId: null, kind: input.kind, statement: input.statement, objectiveIds: input.objectiveIds, evidence,
        uncertainty: input.uncertainty, status: 'proposed', source: 'supervisor', expiresAt: expiry(DEFAULT_TRIGGER_POLICY.proposedExpiryDays) });
    }
    await recordChange(client, row, writer, 'proposed', { source: 'supervisor', templateId: row.template_id, uncertainty: row.uncertainty, evidenceRefs: evidence });
    return { recorded: true, hypothesisId: row.id, revision: row.revision, status: row.status, delivery: 'visible_to_learner_for_review', grantsMastery: false };
  }
  if (name === 'update_hypothesis') {
    const input = hypothesisToolSchemas.update_hypothesis.parse(args);
    const h = (await client.query<HypothesisRow>(`SELECT ${HYPOTHESIS_COLUMNS} FROM teaching_hypotheses WHERE id=$1 AND enrollment_id=$2 AND workspace_id=$3 FOR UPDATE`,
      [input.hypothesisId, run.enrollmentId, run.workspaceId])).rows[0];
    requireCondition(h, 'HYPOTHESIS_NOT_FOUND', 404);
    requireCondition(h.rejected_by !== 'learner', 'HYPOTHESIS_REJECTED_BY_LEARNER', 409);
    requireCondition(h.revision === input.expectedRevision, 'HYPOTHESIS_STALE', 409);
    // A learner's pin outranks any agent: only evidence may be attached.
    requireCondition(!h.pinned || (input.status === undefined && input.uncertainty === undefined), 'HYPOTHESIS_PINNED_BY_LEARNER', 409);
    requireCondition(isActive(h), 'HYPOTHESIS_NOT_ACTIVE', 409);
    const evidence = input.evidenceEventIds ? await sources(input.evidenceEventIds) : [];
    const next = await update(client, h, { ...(input.status ? { status: input.status, rejected_by: input.status === 'rejected' ? 'supervisor' as const : null, expires_at: null } : {}),
      ...(input.uncertainty ? { uncertainty: input.uncertainty } : {}), evidence_refs: [...h.evidence_refs, ...evidence], observations: h.observations + evidence.length });
    await recordChange(client, next, writer, input.status ? 'status_changed' : evidence.length ? 'evidence_added' : 'status_changed',
      { from: h.status, to: next.status, uncertainty: next.uncertainty, evidenceRefs: evidence });
    return { recorded: true, hypothesisId: h.id, revision: next.revision, status: next.status, grantsMastery: false };
  }
  const input = hypothesisToolSchemas.schedule_probe.parse(args);
  const probe = contracts.probes.find(p => p.id === input.probeId);
  requireCondition(probe && run.episodeObjectiveIds.includes(probe.objectiveId), 'PROBE_NOT_AVAILABLE', 404);
  const scheduled = await scheduleProbe(client, scope, { probeId: input.probeId, hypothesisIds: input.hypothesisIds, requestedBy: 'supervisor', jobId: run.jobId }, writer);
  return { scheduled: true, ...scheduled, delivery: 'shown_to_learner_as_optional_check', grantsMastery: false };
}

// ---------------------------------------------------------------- admin, export, erasure

/** Staff read view: the staff projection (learner's own words withheld), plus recent signals. */
export async function adminHypothesisView(client: PoolClient, enrollmentId: string, bundle: unknown) {
  const view = await hypothesisView(client, enrollmentId, bundle, 'staff');
  const signals = (await client.query(`SELECT signal_kind AS "signalKind",rule_ids AS "ruleIds",recommendations,restraints,skipped,created_at AS "createdAt"
    FROM teaching_signals WHERE enrollment_id=$1 ORDER BY created_at DESC LIMIT 10`, [enrollmentId])).rows;
  return { items: view.items, probes: view.probes.map(({ question: _q, ...rest }) => rest), signals };
}
/** Hypothesis changes a supervisor run made, for the run inspector. */
export async function runHypothesisChanges(client: { query: PoolClient['query'] }, jobId: string, enrollmentId: string) {
  return (await client.query(`SELECT c.hypothesis_id AS "hypothesisId",c.action,c.hypothesis_revision AS "revision",c.created_at AS "createdAt",h.kind,h.status,h.pinned,h.template_id AS "templateId"
    FROM teaching_hypothesis_changes c JOIN teaching_hypotheses h ON h.id=c.hypothesis_id AND h.enrollment_id=c.enrollment_id
    WHERE c.job_id=$1 AND c.enrollment_id=$2 ORDER BY c.sequence LIMIT 50`, [jobId, enrollmentId])).rows;
}
/** Teaching-hypothesis records for a data export. The learner's copy is
 * complete. A staff copy is an explicit projection under the shared privacy
 * rule: ids, kinds, statuses and flags only, with no learner-written text
 * (corrections, notes, self-written hypotheses, change details) and no probe answers. */
export async function exportTeachingHypotheses(client: PoolClient, enrollmentId: string, audience: HypothesisAudience = 'learner') {
  const id = [enrollmentId];
  if (audience === 'staff') return {
    audience: 'staff' as const,
    withheld: ['learner corrections', 'diagnostic request notes', 'hypotheses written by the learner', 'change details', 'probe answers'],
    hypotheses: (await client.query<HypothesisRow>(`SELECT ${HYPOTHESIS_COLUMNS} FROM teaching_hypotheses WHERE enrollment_id=$1 ORDER BY created_at,id`, id)).rows.map(h => ({
      id: h.id, template_id: h.template_id, kind: h.kind, statement: ownWords(h) ? null : h.statement, statement_withheld: ownWords(h),
      corrected_by_learner: h.learner_correction !== null, objective_ids: h.objective_ids, evidence_refs: h.evidence_refs, uncertainty: h.uncertainty, status: h.status,
      source: h.source, pinned: h.pinned, rejected_by: h.rejected_by, observations: h.observations, revision: h.revision, expires_at: h.expires_at, created_at: h.created_at, updated_at: h.updated_at })),
    changes: (await client.query('SELECT hypothesis_id,hypothesis_revision,actor_kind,action,created_at FROM teaching_hypothesis_changes WHERE enrollment_id=$1 ORDER BY sequence', id)).rows,
    probeRuns: (await client.query('SELECT id,probe_id,assessment_id,hypothesis_ids,requested_by,state,scheduled_at,expires_at,answered_at FROM diagnostic_probe_runs WHERE enrollment_id=$1 ORDER BY scheduled_at', id)).rows,
    diagnosticRequests: (await client.query('SELECT id,hypothesis_id,objective_id,note IS NOT NULL AS note_withheld,state,probe_run_id,created_at FROM diagnostic_requests WHERE enrollment_id=$1 ORDER BY created_at', id)).rows,
    signals: (await client.query('SELECT signal_kind,objective_ids,rule_ids,recommendations,restraints,created_at FROM teaching_signals WHERE enrollment_id=$1 ORDER BY created_at', id)).rows,
  };
  return {
    audience: 'learner' as const,
    hypotheses: (await client.query(`SELECT id,template_id,kind,statement,learner_correction,objective_ids,evidence_refs,uncertainty,status,source,pinned,rejected_by,observations,revision,expires_at,created_at,updated_at
      FROM teaching_hypotheses WHERE enrollment_id=$1 ORDER BY created_at,id`, id)).rows,
    changes: (await client.query('SELECT hypothesis_id,hypothesis_revision,actor_kind,action,data,created_at FROM teaching_hypothesis_changes WHERE enrollment_id=$1 ORDER BY sequence', id)).rows,
    probeRuns: (await client.query('SELECT id,probe_id,assessment_id,hypothesis_ids,requested_by,state,response,outcome,scheduled_at,expires_at,answered_at FROM diagnostic_probe_runs WHERE enrollment_id=$1 ORDER BY scheduled_at', id)).rows,
    diagnosticRequests: (await client.query('SELECT id,hypothesis_id,objective_id,note,state,probe_run_id,created_at FROM diagnostic_requests WHERE enrollment_id=$1 ORDER BY created_at', id)).rows,
    signals: (await client.query('SELECT signal_kind,objective_ids,rule_ids,recommendations,restraints,created_at FROM teaching_signals WHERE enrollment_id=$1 ORDER BY created_at', id)).rows,
  };
}
/** Redacts learner-specific text and answers; keeps ids, kinds and timestamps. */
export async function eraseTeachingHypotheses(run: (label: string, sql: string) => Promise<void>) {
  await run('teachingHypotheses', "UPDATE teaching_hypotheses SET statement='[erased]',learner_correction=CASE WHEN learner_correction IS NULL THEN NULL ELSE '[erased]' END,evidence_refs='[]'::jsonb WHERE enrollment_id=$1");
  await run('teachingHypothesisChanges', "UPDATE teaching_hypothesis_changes SET data='{}'::jsonb WHERE enrollment_id=$1");
  await run('diagnosticProbeRuns', "UPDATE diagnostic_probe_runs SET response=CASE WHEN response IS NULL THEN NULL ELSE '{\"erased\":true}'::jsonb END,outcome=CASE WHEN outcome IS NULL THEN NULL ELSE '{\"erased\":true}'::jsonb END,state=CASE WHEN state='scheduled' THEN 'cancelled' ELSE state END WHERE enrollment_id=$1");
  await run('diagnosticRequests', "UPDATE diagnostic_requests SET note=CASE WHEN note IS NULL THEN NULL ELSE '[erased]' END WHERE enrollment_id=$1");
  await run('teachingSignals', "UPDATE teaching_signals SET source_ref='{}'::jsonb,effects='[]'::jsonb,skipped='[]'::jsonb WHERE enrollment_id=$1");
}
