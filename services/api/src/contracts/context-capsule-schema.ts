import { z } from 'zod';
import type { ContextCapsule } from './context-capsule.js';

/** Runtime schema of the public ContextCapsule contract (./context-capsule.ts). The committed JSON
 * Schema (docs/contracts/context-capsule.v1.schema.json) is generated from it. Objects are open
 * (unknown fields allowed) because readers must ignore fields added later in version 1. */
const count = z.number().int().min(0);
const segment = z.object({ startSeconds: z.number().min(0), endSeconds: z.number().min(0) });
const anchor = z.discriminatedUnion('kind', [
  z.object({ kind: z.enum(['text', 'formula']), blockId: z.string(), contentDigest: z.string(), excerpt: z.string(), courseDigest: z.string() }),
  z.object({ kind: z.literal('log_entry'), attemptId: z.string(), assessmentId: z.string(), excerpt: z.string(), courseDigest: z.string() }),
  z.object({ kind: z.literal('code_line'), assessmentId: z.string(), challengeId: z.string(), lineStart: count, lineEnd: count, excerpt: z.string(),
    codeSnapshotHash: z.string(), courseDigest: z.string(), source: z.literal('learner_draft') }),
  z.object({ kind: z.literal('visual_node'), blockId: z.string(), visualId: z.string(), nodeId: z.string(), label: z.string(), courseDigest: z.string() }),
]);
export const contextCapsuleSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal('companion_context_capsule'),
  enrollmentId: z.string(), courseDigest: z.string(), pathRevision: count.nullable(), planDigest: z.string().nullable(),
  episodeId: z.string(), blockId: z.string().nullable(), currentStepId: z.string().nullable(), activityInstanceId: z.string().nullable(), attemptId: z.string().nullable(),
  answersMessageId: z.string().nullable(), uiRevision: count.nullable(), contextRevision: count, enrollmentRevision: count,
  profileRevision: count, policyRevision: count, learnerModelRevision: count.nullable(), recentEventCursor: z.string().nullable(),
  selectedAnchor: anchor.nullable(),
  simulationState: z.object({ blockId: z.string(), visualId: z.string(), settings: z.array(z.object({ key: z.string(), label: z.string(), value: z.unknown() })) }).nullable(),
  codeSnapshotHash: z.string().nullable(), assessmentMode: z.enum(['none', 'practice_open', 'independent_open']),
  mediaRef: z.object({ mediaId: z.string(), blockId: z.string(), kind: z.string(), playbackSeconds: z.number().min(0).nullable(), reviewedSegment: segment.nullable() }).nullable(),
  playbackSeconds: z.number().min(0).nullable(), reviewedSegment: segment.nullable(),
  evidenceRefs: z.array(z.object({ evidenceId: z.string(), attemptId: z.string() })),
  historyRefs: z.array(z.object({ messageId: z.string(), role: z.enum(['learner', 'assistant']), eventId: z.string().nullable(), createdAt: z.string(), characters: count, clipped: z.boolean() })),
  summary: z.object({ kind: z.literal('earlier_questions_in_lesson'), count, omitted: count,
    items: z.array(z.object({ messageId: z.string(), eventId: z.string().nullable(), excerpt: z.string() })),
    sourceEventIds: z.array(z.string()), sourceMessageIds: z.array(z.string()) }).nullable(),
  sourceRefs: z.array(z.string()), authorizationScopes: z.array(z.string()), extensionAllowanceRefs: z.array(z.string()),
  pendingGateDecisionRef: z.object({ decisionId: z.string(), status: z.string() }).nullable(),
  resolvedConstraintSnapshot: z.object({ digest: z.string(), deadline: z.string().nullable(), expansionAllowed: z.boolean(), independentAssessmentActive: z.boolean(),
    policyRevision: count, view: z.looseObject({ authority: z.literal('server_resolved_policy_not_model_permission') }).nullable() }),
}) satisfies z.ZodType<ContextCapsule>;

/** The JSON Schema committed at docs/contracts/context-capsule.v1.schema.json. */
export function contextCapsuleJsonSchema() {
  return { $id: 'https://github.com/roeehrl/course-core/docs/contracts/context-capsule.v1.schema.json', title: 'ContextCapsule (schema version 1)',
    ...z.toJSONSchema(contextCapsuleSchema, { target: 'draft-2020-12', io: 'input', unrepresentable: 'any' }) };
}
