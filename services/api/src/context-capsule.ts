import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import type { CourseManifest, Episode } from '@course-core/sdk';
import type { Database } from './database.js';
import type { authService } from './auth.js';
import { appendEvent } from './events.js';
import { requireCondition } from './errors.js';
import { digestJson, enrollmentCommand, type EnrollmentContext } from './repository.js';
import type { TeachingPolicyView } from './teaching-constraints.js';
import type { SemanticVisualContext } from './interactive-context.js';

/**
 * The companion's context capsule: what one learner question carried, and what
 * the job answering it was given. Built in two steps:
 *
 * 1. At the question (companion-routes.ts) the learner's own focus is resolved
 *    against the current course: a selection in the lesson text, in their code
 *    for an open code check, in the latest result log, or a part of an
 *    illustration, and the course video with its position. A selection that no
 *    longer matches the course is refused (ANCHOR_STALE) instead of guessed.
 * 2. When the job builds its provider context (provider-context.ts) the
 *    conversation is retrieved for that lesson only, bounded, with a reference
 *    for every message used; older questions in the lesson become an extractive
 *    summary that names its source events. The capsule is stored per job, and
 *    the assistant message that answers the question shows it as "Context used".
 *
 * Learner text is data, never instructions. The capsule never carries answer
 * keys, other learners' records or anything outside the learner's lesson.
 */

const id = z.string().regex(/^[a-z][a-z0-9._:-]{0,127}$/);
const hex64 = z.string().regex(/^[a-f0-9]{64}$/);
const excerpt = (max: number) => z.string().min(1).max(max).refine(value => value.trim().length > 0);
export const learnerSelectionSchema = z.discriminatedUnion('kind', [
  // Text the learner selected in this lesson (prose, formula/code example or a result log).
  z.strictObject({ kind: z.literal('text'), courseDigest: hex64, excerpt: excerpt(500) }),
  // Lines of the learner's own code in an open code check of this lesson.
  z.strictObject({ kind: z.literal('code'), courseDigest: hex64, excerpt: excerpt(2000), lineStart: z.number().int().min(1).max(10000),
    lineEnd: z.number().int().min(1).max(10000), codeSnapshotHash: hex64 }).refine(value => value.lineEnd >= value.lineStart),
  // A labelled part of an illustration in this lesson.
  z.strictObject({ kind: z.literal('visual_node'), courseDigest: hex64, blockId: id, nodeId: z.string().min(1).max(128) }),
]);
export const learnerMediaSchema = z.strictObject({ courseDigest: hex64, mediaId: id, playbackSeconds: z.number().min(0).max(86400).optional() });
export type LearnerSelection = z.infer<typeof learnerSelectionSchema>;
export type LearnerMedia = z.infer<typeof learnerMediaSchema>;

export type SemanticAnchor =
  | { kind: 'text' | 'formula'; blockId: string; contentDigest: string; excerpt: string; courseDigest: string }
  | { kind: 'log_entry'; attemptId: string; assessmentId: string; excerpt: string; courseDigest: string }
  | { kind: 'code_line'; assessmentId: string; challengeId: string; lineStart: number; lineEnd: number; excerpt: string; codeSnapshotHash: string; courseDigest: string; source: 'learner_draft' }
  | { kind: 'visual_node'; blockId: string; visualId: string; nodeId: string; label: string; courseDigest: string };
export interface MediaRef { mediaId: string; blockId: string; kind: string; playbackSeconds: number | null; reviewedSegment: { startSeconds: number; endSeconds: number } | null }

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const collapse = (value: string) => value.replace(/\s+/g, ' ').trim();
/** The text a learner can select from a markdown block, as the learner app renders it
 * (MarkdownContent): code fences keep their code, inline marks and link targets drop. */
export function renderedText(markdown: string) {
  return collapse(markdown.replace(/```[^\n]*\n([\s\S]*?)```/g, ' $1 ').replace(/^#{1,4}\s/gm, '').replace(/\[([^\]\n]+)\]\([^\s)]+\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1'));
}
function codeSpans(markdown: string) {
  return [...markdown.matchAll(/```[^\n]*\n([\s\S]*?)```/g), ...markdown.matchAll(/`([^`\n]+)`/g)].map(match => collapse(match[1]!));
}
function stale(): never { requireCondition(false, 'ANCHOR_STALE', 409); throw new Error('unreachable'); }
function labelledNode(value: unknown, nodeId: string, depth = 0): string | undefined {
  if (depth > 12 || !value || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) { for (const item of value) { const found = labelledNode(item, nodeId, depth + 1); if (found) return found; } return undefined; }
  const record = value as Record<string, unknown>;
  if (record.id === nodeId && typeof record.label === 'string' && record.label.trim()) return record.label.trim().slice(0, 200);
  for (const child of Object.values(record)) { const found = labelledNode(child, nodeId, depth + 1); if (found) return found; }
  return undefined;
}

/** Resolves the learner's selection against the current course and their open work in
 * this episode. Anything that does not match exactly is refused as stale. */
export async function resolveSelection(client: PoolClient, context: EnrollmentContext, episode: Episode, selection: LearnerSelection): Promise<SemanticAnchor> {
  const course = context.release.server_bundle as CourseManifest, courseDigest = context.release.digest;
  if (selection.courseDigest !== courseDigest) stale();
  if (selection.kind === 'text') {
    const wanted = collapse(selection.excerpt);
    for (const block of episode.blocks) {
      if (block.type !== 'text' || !renderedText(block.markdown).includes(wanted)) continue;
      const formula = codeSpans(block.markdown).some(span => span.includes(wanted));
      return { kind: formula ? 'formula' : 'text', blockId: block.id, contentDigest: sha256(block.markdown), excerpt: wanted, courseDigest };
    }
    // A result log: the learner's latest graded answer in this episode (its feedback and output).
    const assessments = episode.blocks.flatMap(block => block.type === 'assessment' ? [block.assessmentId] : []);
    const latest = (await client.query<{ id: string; assessment_id: string; result: unknown }>(`SELECT a.id,a.assessment_id,a.result FROM attempts a
      WHERE a.enrollment_id=$1 AND a.course_digest=$2 AND a.assessment_id=ANY($3::text[]) ORDER BY a.submitted_at DESC,a.id DESC LIMIT 1`,
    [context.enrollment.id, courseDigest, assessments])).rows[0];
    const strings: string[] = [];
    const collect = (value: unknown, depth = 0) => {
      if (depth > 8 || strings.length > 200) return;
      if (typeof value === 'string') strings.push(collapse(value));
      else if (value && typeof value === 'object') for (const child of Object.values(value)) collect(child, depth + 1);
    };
    collect(latest?.result);
    if (latest && strings.some(text => text.includes(wanted)))
      return { kind: 'log_entry', attemptId: latest.id, assessmentId: latest.assessment_id, excerpt: wanted, courseDigest };
    return stale();
  }
  if (selection.kind === 'code') {
    const codeAssessments = course.assessments.filter(item => item.type === 'code' || (item.type as string) === 'code_repair').map(item => item.id);
    const open = (await client.query<{ id: string; assessment_id: string }>(`SELECT id,assessment_id FROM assessment_challenges
      WHERE enrollment_id=$1 AND episode_id=$2 AND course_digest=$3 AND attempt_id IS NULL AND expires_at>now() AND assessment_id=ANY($4::text[])
      ORDER BY issued_at DESC,id DESC LIMIT 1`, [context.enrollment.id, episode.id, courseDigest, codeAssessments])).rows[0];
    if (!open) stale();
    return { kind: 'code_line', assessmentId: open.assessment_id, challengeId: open.id, lineStart: selection.lineStart, lineEnd: selection.lineEnd,
      excerpt: selection.excerpt, codeSnapshotHash: selection.codeSnapshotHash, courseDigest, source: 'learner_draft' };
  }
  const block = episode.blocks.find(row => row.id === selection.blockId && row.type === 'visual');
  const visual = block?.type === 'visual' ? course.visuals.find(row => row.id === block.visualId) : undefined;
  const label = visual ? labelledNode(visual, selection.nodeId) : undefined;
  if (!block || !visual || !label) stale();
  return { kind: 'visual_node', blockId: block.id, visualId: visual.id, nodeId: selection.nodeId, label, courseDigest };
}
export function resolveMedia(context: EnrollmentContext, episode: Episode, media: LearnerMedia): MediaRef {
  if (media.courseDigest !== context.release.digest) stale();
  const block = episode.blocks.find(row => row.type === 'media' && row.mediaId === media.mediaId);
  const resource = (context.release.server_bundle as CourseManifest).media.find(row => row.id === media.mediaId);
  if (!block || !resource) stale();
  const segment = (resource as { segment?: { startSeconds: number; endSeconds: number } }).segment;
  return { mediaId: resource.id, blockId: block.id, kind: resource.type, playbackSeconds: media.playbackSeconds === undefined ? null : Math.round(media.playbackSeconds * 10) / 10,
    reviewedSegment: segment ? { startSeconds: segment.startSeconds, endSeconds: segment.endSeconds } : null };
}

/** Retrieval bounds: the last eight messages of this lesson, at most 1,000 characters
 * each and 6,000 in all; five earlier questions are named in the summary. */
export const RETRIEVAL_LIMITS = { messages: 8, messageCharacters: 1000, totalCharacters: 6000, summarized: 5, summaryCharacters: 160 } as const;
export interface HistoryRef { messageId: string; role: 'learner' | 'assistant'; eventId: string | null; createdAt: string; characters: number; clipped: boolean }
export interface ConversationSummary { kind: 'earlier_questions_in_lesson'; count: number; omitted: number;
  items: { messageId: string; eventId: string | null; excerpt: string }[]; sourceEventIds: string[]; sourceMessageIds: string[] }
const EPISODE_OF_MESSAGE = `COALESCE(m.context->>'episodeId',(SELECT q.context->>'episodeId' FROM companion_messages q WHERE q.job_id=m.job_id AND q.enrollment_id=m.enrollment_id AND q.role='learner' LIMIT 1))`;
const DIGEST_OF_MESSAGE = `COALESCE(m.context->>'courseDigest',(SELECT q.context->>'courseDigest' FROM companion_messages q WHERE q.job_id=m.job_id AND q.enrollment_id=m.enrollment_id AND q.role='learner' LIMIT 1))`;
/** SQL over `companion_messages m`: the message is in one lesson (`episodeParam`) of one course
 * version (`digestParam`). A deleted question loses its context, so it is never in a lesson. */
export const inLesson = (episodeParam: string, digestParam: string) => `${EPISODE_OF_MESSAGE}=${episodeParam} AND ${DIGEST_OF_MESSAGE}=${digestParam}`;
/** SQL over `companion_messages m`: a message any model may receive. Not erased or deleted, not
 * excluded from AI context by the learner, and not in an erased enrollment. Every path that hands
 * conversation to a provider (provider context, supervisor tools) applies this one filter. */
export const USABLE_MESSAGE = `m.content NOT IN ('[erased]','[deleted]')
      AND NOT EXISTS (SELECT 1 FROM companion_context_exclusions x WHERE x.message_id=m.id AND x.enrollment_id=m.enrollment_id AND x.ended_at IS NULL)
      AND EXISTS (SELECT 1 FROM enrollments n WHERE n.id=m.enrollment_id AND n.status<>'erased')`;
const REQUEST_EVENT = `(SELECT e.id FROM learning_events e WHERE e.enrollment_id=m.enrollment_id AND e.event_type='companion.requested' AND e.payload->>'messageId'=m.id::text LIMIT 1)`;

/** Episode-scoped, bounded conversation retrieval with references. Messages the
 * learner excluded, erased or deleted, other lessons and other course versions
 * are never read; the current question is left out (it is the question). */
export async function retrieveConversation(client: PoolClient, input: { enrollmentId: string; episodeId: string; courseDigest: string; currentMessageId?: string; before?: Date }) {
  const base = `FROM companion_messages m WHERE m.enrollment_id=$1 AND ${inLesson('$2', '$3')}
      AND m.id<>COALESCE($4::uuid,'00000000-0000-0000-0000-000000000000') AND ($5::timestamptz IS NULL OR m.created_at<=$5) AND ${USABLE_MESSAGE}`;
  const args = [input.enrollmentId, input.episodeId, input.courseDigest, input.currentMessageId ?? null, input.before ?? null];
  const rows = (await client.query<{ id: string; role: 'learner' | 'assistant'; content: string; length: number; created_at: Date; event_id: string | null }>(
    `SELECT m.id,m.role,left(m.content,${RETRIEVAL_LIMITS.messageCharacters}) AS content,char_length(m.content) AS length,m.created_at,${REQUEST_EVENT} AS event_id
     ${base} ORDER BY m.created_at DESC,m.id DESC LIMIT ${RETRIEVAL_LIMITS.messages}`, args)).rows.reverse();
  // Keep the newest messages within the character budget.
  let budget: number = RETRIEVAL_LIMITS.totalCharacters;
  const kept: typeof rows = [];
  for (const row of [...rows].reverse()) { if (row.content.length > budget) break; budget -= row.content.length; kept.unshift(row); }
  const older = (await client.query<{ id: string; content: string; event_id: string | null; total: string }>(
    `SELECT m.id,left(m.content,${RETRIEVAL_LIMITS.summaryCharacters}) AS content,${REQUEST_EVENT} AS event_id,count(*) OVER () AS total
     ${base} AND m.role='learner' AND m.id<>ALL($6::uuid[]) ORDER BY m.created_at DESC,m.id DESC LIMIT ${RETRIEVAL_LIMITS.summarized}`,
    [...args, kept.map(row => row.id)])).rows;
  const total = Number(older[0]?.total ?? 0);
  const summary: ConversationSummary | null = total ? { kind: 'earlier_questions_in_lesson', count: total, omitted: Math.max(0, total - older.length),
    items: older.map(row => ({ messageId: row.id, eventId: row.event_id, excerpt: collapse(row.content) })),
    sourceEventIds: older.flatMap(row => row.event_id ? [row.event_id] : []), sourceMessageIds: older.map(row => row.id) } : null;
  return {
    history: kept.map(row => ({ role: row.role, content: row.content })),
    refs: kept.map((row): HistoryRef => ({ messageId: row.id, role: row.role, eventId: row.event_id, createdAt: row.created_at.toISOString(), characters: row.content.length, clipped: row.length > row.content.length })),
    summary,
  };
}

export interface CompanionCapsule {
  schemaVersion: 1; kind: 'companion_context_capsule';
  enrollmentId: string; courseDigest: string; pathRevision: number | null; planDigest: string | null;
  episodeId: string; blockId: string | null; currentStepId: string | null; activityInstanceId: string | null; attemptId: string | null;
  answersMessageId: string | null; uiRevision: number | null; contextRevision: number; enrollmentRevision: number;
  profileRevision: number; policyRevision: number; learnerModelRevision: number | null; recentEventCursor: string | null;
  selectedAnchor: SemanticAnchor | null; simulationState: { blockId: string; visualId: string; settings: { key: string; label: string; value: unknown }[] } | null;
  codeSnapshotHash: string | null; assessmentMode: 'none' | 'practice_open' | 'independent_open';
  mediaRef: MediaRef | null; playbackSeconds: number | null; reviewedSegment: { startSeconds: number; endSeconds: number } | null;
  evidenceRefs: { evidenceId: string; attemptId: string }[]; historyRefs: HistoryRef[]; summary: ConversationSummary | null;
  sourceRefs: string[]; authorizationScopes: string[]; extensionAllowanceRefs: string[]; pendingGateDecisionRef: { decisionId: string; status: string } | null;
  resolvedConstraintSnapshot: { digest: string; deadline: string | null; expansionAllowed: boolean; independentAssessmentActive: boolean; policyRevision: number; view: TeachingPolicyView | null };
}
/** The learner's focus recorded on their question when they asked it. */
export interface QuestionFocus { selectedAnchor?: SemanticAnchor; mediaRef?: MediaRef; uiRevision?: number; contextRevision?: number; recentEventCursor?: string }

export async function capsuleFacts(client: PoolClient, enrollmentId: string, episode: Episode, gateId: string | undefined) {
  const challenge = (await client.query<{ id: string; mode: string; independent_eligible: boolean }>(`SELECT id,mode,independent_eligible FROM assessment_challenges
    WHERE enrollment_id=$1 AND episode_id=$2 AND attempt_id IS NULL AND expires_at>now() ORDER BY issued_at DESC,id DESC LIMIT 1`, [enrollmentId, episode.id])).rows[0];
  const attempt = (await client.query<{ id: string }>(`SELECT a.id FROM attempts a JOIN assessment_challenges c ON c.attempt_id=a.id AND c.enrollment_id=a.enrollment_id
    WHERE a.enrollment_id=$1 AND c.episode_id=$2 ORDER BY a.submitted_at DESC,a.id DESC LIMIT 1`, [enrollmentId, episode.id])).rows[0];
  const grants = (await client.query<{ id: string }>('SELECT id FROM extension_grants WHERE enrollment_id=$1 ORDER BY created_at DESC LIMIT 5', [enrollmentId])).rows;
  const decision = gateId ? (await client.query<{ id: string; status: string }>(`SELECT id,status FROM gate_decisions WHERE enrollment_id=$1 AND gate_id=$2 AND superseded_at IS NULL
    ORDER BY decided_at DESC,id DESC LIMIT 1`, [enrollmentId, gateId])).rows[0] : undefined;
  return { activityInstanceId: challenge?.id ?? null, attemptId: attempt?.id ?? null,
    assessmentMode: !challenge ? 'none' as const : challenge.mode === 'independent' && challenge.independent_eligible ? 'independent_open' as const : 'practice_open' as const,
    extensionAllowanceRefs: grants.map(row => row.id), pendingGateDecisionRef: decision ? { decisionId: decision.id, status: decision.status } : null };
}

export function constraintSnapshot(input: { deadline: string | null; expansionAllowed: boolean; independentAssessmentActive: boolean; resolvedPolicy?: TeachingPolicyView }, policyRevision: number) {
  const values = { deadline: input.deadline, expansionAllowed: input.expansionAllowed, independentAssessmentActive: input.independentAssessmentActive, policyRevision };
  return { digest: digestJson({ ...values, view: input.resolvedPolicy ?? null }), ...values, view: input.resolvedPolicy ?? null };
}
export function simulationState(context: SemanticVisualContext | undefined) {
  return context ? { blockId: context.source.blockId, visualId: context.source.visualId, settings: context.settings.slice(0, 20) } : null;
}

/** Stores what this job was given, once per job (a retry replaces it with what it was given then). */
export async function storeCapsule(client: PoolClient, input: { jobId: string; workspaceId: string; enrollmentId: string; learnerMessageId: string; capsule: CompanionCapsule }) {
  let capsule = input.capsule;
  // Keep within the stored bound: summaries and references go before anything else.
  for (const trim of [() => ({ ...capsule, summary: capsule.summary && { ...capsule.summary, items: capsule.summary.items.slice(0, 2) } }),
    () => ({ ...capsule, resolvedConstraintSnapshot: { ...capsule.resolvedConstraintSnapshot, view: null } }),
    () => ({ ...capsule, historyRefs: capsule.historyRefs.slice(-4) })])
    if (Buffer.byteLength(JSON.stringify(capsule)) > 30_000) capsule = trim();
  // The supervisor lock order (enrollment, then job): the foreign-key checks below then wait on the
  // enrollment like every other supervision path instead of holding the job first.
  const live = (await client.query(`SELECT 1 FROM enrollments e WHERE e.id=$1 AND e.workspace_id=$2 AND e.status<>'erased' FOR KEY SHARE`, [input.enrollmentId, input.workspaceId])).rowCount
    && (await client.query('SELECT 1 FROM supervisor_jobs WHERE id=$1 AND enrollment_id=$2 AND workspace_id=$3 FOR KEY SHARE', [input.jobId, input.enrollmentId, input.workspaceId])).rowCount;
  if (!live) return;
  await client.query(`INSERT INTO companion_context_capsules(job_id,enrollment_id,workspace_id,learner_message_id,capsule,digest)
    SELECT $1,$2,$3,$4,$5,$6 WHERE EXISTS (SELECT 1 FROM companion_messages m WHERE m.id=$4 AND m.enrollment_id=$2)
    ON CONFLICT (job_id) DO UPDATE SET capsule=EXCLUDED.capsule,digest=EXCLUDED.digest,updated_at=clock_timestamp()
      WHERE companion_context_capsules.enrollment_id=EXCLUDED.enrollment_id`,
  [input.jobId, input.enrollmentId, input.workspaceId, input.learnerMessageId, JSON.stringify(capsule), digestJson(capsule)]);
}

/** "Context used", as the learner sees it on an answer: references with short
 * excerpts of the learner's own conversation, never anything else's text. */
export function contextUsedView(capsule: CompanionCapsule | Record<string, never> | null, excerpts: Map<string, string>, excluded: Set<string>) {
  if (!capsule || !('kind' in capsule) || capsule.kind !== 'companion_context_capsule') return null;
  const anchor = capsule.selectedAnchor;
  return {
    episodeId: capsule.episodeId, blockId: capsule.blockId, answersMessageId: capsule.answersMessageId, contextRevision: capsule.contextRevision,
    courseDigest: capsule.courseDigest, recentEventCursor: capsule.recentEventCursor,
    history: capsule.historyRefs.map(ref => ({ messageId: ref.messageId, role: ref.role, excerpt: excerpts.get(ref.messageId) ?? '', clipped: ref.clipped, excluded: excluded.has(ref.messageId) })),
    summary: capsule.summary && { count: capsule.summary.count, omitted: capsule.summary.omitted, sourceEventIds: capsule.summary.sourceEventIds,
      items: capsule.summary.items.map(item => ({ messageId: item.messageId, eventId: item.eventId, excerpt: item.excerpt, excluded: excluded.has(item.messageId) })) },
    selection: anchor ? { kind: anchor.kind, excerpt: 'excerpt' in anchor ? anchor.excerpt.slice(0, 200) : anchor.label, ...('lineStart' in anchor ? { lineStart: anchor.lineStart, lineEnd: anchor.lineEnd } : {}) } : null,
    media: capsule.mediaRef ? { mediaId: capsule.mediaRef.mediaId, playbackSeconds: capsule.mediaRef.playbackSeconds, reviewedSegment: capsule.mediaRef.reviewedSegment } : null,
    simulation: capsule.simulationState ? { blockId: capsule.simulationState.blockId, settings: capsule.simulationState.settings.length } : null,
    evidenceCount: capsule.evidenceRefs.length, assessmentMode: capsule.assessmentMode,
    constraints: { deadline: capsule.resolvedConstraintSnapshot.deadline, expansionAllowed: capsule.resolvedConstraintSnapshot.expansionAllowed,
      independentAssessmentActive: capsule.resolvedConstraintSnapshot.independentAssessmentActive, policyRevision: capsule.resolvedConstraintSnapshot.policyRevision,
      digest: capsule.resolvedConstraintSnapshot.digest },
  };
}

/** Learner-only: stop (or resume) using one of their earlier messages as companion context. */
export function registerCompanionContextRoutes(app: FastifyInstance, db: Database, auth: ReturnType<typeof authService>) {
  const schema = z.strictObject({ expectedRevision: z.number().int().positive().max(2147483646), idempotencyKey: z.string().regex(/^[A-Za-z0-9:_-]{8,200}$/),
    messageId: z.uuid(), excluded: z.boolean() });
  app.post('/api/enrollments/:enrollmentId/companion/context-exclusions', { bodyLimit: 4096 }, async request => {
    const actor = await auth.authenticate(request);
    const params = z.object({ enrollmentId: z.uuid() }).safeParse(request.params), body = schema.safeParse(request.body);
    requireCondition(params.success && body.success, 'INVALID_REQUEST');
    const enrollmentId = params.data!.enrollmentId, input = body.data!;
    return enrollmentCommand(db, actor, enrollmentId, 'companion.context_exclusion', input, async (client, context) => {
      const message = (await client.query<{ excluded: boolean }>(`SELECT EXISTS (SELECT 1 FROM companion_context_exclusions x WHERE x.message_id=m.id AND x.ended_at IS NULL) AS excluded
        FROM companion_messages m WHERE m.id=$1 AND m.enrollment_id=$2 FOR UPDATE`, [input.messageId, enrollmentId])).rows[0];
      requireCondition(message, 'MESSAGE_NOT_FOUND', 404);
      requireCondition(message.excluded !== input.excluded, 'CONTEXT_EXCLUSION_UNCHANGED', 409);
      await client.query('UPDATE enrollments SET revision=revision+1 WHERE id=$1', [enrollmentId]);
      const event = await appendEvent(client, { workspaceId: context.enrollment.workspace_id, enrollmentId, actorId: actor.id, actorKind: 'learner',
        type: input.excluded ? 'companion.context.excluded' : 'companion.context.included', payload: { messageId: input.messageId }, idempotencyKey: `${enrollmentId}:${input.idempotencyKey}` });
      if (input.excluded) await client.query('INSERT INTO companion_context_exclusions(id,enrollment_id,workspace_id,message_id,event_id) VALUES ($1,$2,$3,$4,$5)',
        [randomUUID(), enrollmentId, context.enrollment.workspace_id, input.messageId, event.id]);
      else await client.query('UPDATE companion_context_exclusions SET ended_at=clock_timestamp() WHERE message_id=$1 AND enrollment_id=$2 AND ended_at IS NULL', [input.messageId, enrollmentId]);
      return { messageId: input.messageId, excluded: input.excluded, eventId: event.id, revision: context.enrollment.revision + 1 };
    });
  });
}

/** A deleted question leaves every stored capsule: the capsule of the job answering it is
 * cleared, and other capsules drop it from their history references and summary (with its
 * source event). Returns how many capsules changed. */
export async function revokeCapsuleSources(client: PoolClient, enrollmentId: string, messageId: string, eventIds: string[]) {
  const answering = (await client.query("UPDATE companion_context_capsules SET capsule='{}'::jsonb,digest='revoked',updated_at=clock_timestamp() WHERE enrollment_id=$1 AND learner_message_id=$2 AND capsule<>'{}'::jsonb",
    [enrollmentId, messageId])).rowCount ?? 0;
  const citing = (await client.query<{ job_id: string; capsule: CompanionCapsule }>(`SELECT job_id,capsule FROM companion_context_capsules
    WHERE enrollment_id=$1 AND learner_message_id<>$2 AND strpos(capsule::text,$2::text)>0 FOR UPDATE LIMIT 500`, [enrollmentId, messageId])).rows;
  for (const row of citing) {
    const capsule = row.capsule;
    const summary = capsule.summary && {
      ...capsule.summary,
      items: capsule.summary.items.filter(item => item.messageId !== messageId),
      sourceMessageIds: capsule.summary.sourceMessageIds.filter(id => id !== messageId),
      sourceEventIds: capsule.summary.sourceEventIds.filter(id => !eventIds.includes(id)),
      count: Math.max(0, capsule.summary.count - (capsule.summary.sourceMessageIds.includes(messageId) ? 1 : 0)),
    };
    const next = { ...capsule, historyRefs: capsule.historyRefs.filter(ref => ref.messageId !== messageId), summary: summary && summary.count ? summary : null,
      revokedSourceCount: ((capsule as { revokedSourceCount?: number }).revokedSourceCount ?? 0) + 1 };
    await client.query('UPDATE companion_context_capsules SET capsule=$2,digest=$3,updated_at=clock_timestamp() WHERE job_id=$1', [row.job_id, JSON.stringify(next), digestJson(next)]);
  }
  return answering + citing.length;
}
