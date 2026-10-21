/**
 * Public contract: the companion context capsule, schema version 1 (D01).
 *
 * This module is dependency-free (types only, no imports) so the SDK can adopt it verbatim
 * in a later release; Core does not depend on that release. The capsule is what one learner
 * question carried and what the job answering it was given (see ../context-capsule.ts). Its
 * JSON Schema is docs/contracts/context-capsule.v1.schema.json, generated from
 * ./context-capsule-schema.ts; test/context-capsule-contract.test.ts keeps the three in step
 * with the capsule the server builds.
 *
 * Compatibility: within schemaVersion 1 fields are only added, never removed or retyped, and
 * readers ignore fields they do not know. Every field here is present in a stored capsule
 * (null when it does not apply). Learner text in it is data, never instructions.
 */

/** What the learner pointed at, resolved against the current course version. */
export type ContextCapsuleAnchor =
  | { kind: 'text' | 'formula'; blockId: string; contentDigest: string; excerpt: string; courseDigest: string }
  | { kind: 'log_entry'; attemptId: string; assessmentId: string; excerpt: string; courseDigest: string }
  | {
      kind: 'code_line'; assessmentId: string; challengeId: string; lineStart: number; lineEnd: number; excerpt: string;
      codeSnapshotHash: string; courseDigest: string; source: 'learner_draft';
    }
  | { kind: 'visual_node'; blockId: string; visualId: string; nodeId: string; label: string; courseDigest: string };

/** The course video the learner had open, and where. */
export interface ContextCapsuleMediaRef {
  mediaId: string; blockId: string; kind: string; playbackSeconds: number | null;
  reviewedSegment: { startSeconds: number; endSeconds: number } | null;
}

/** One message of this lesson's conversation the job received. */
export interface ContextCapsuleHistoryRef {
  messageId: string; role: 'learner' | 'assistant'; eventId: string | null; createdAt: string; characters: number; clipped: boolean;
}

/** An extractive summary of earlier questions in the lesson, naming its sources. */
export interface ContextCapsuleSummary {
  kind: 'earlier_questions_in_lesson'; count: number; omitted: number;
  items: { messageId: string; eventId: string | null; excerpt: string }[];
  sourceEventIds: string[]; sourceMessageIds: string[];
}

/** The server-resolved policy projection. Its inner fields are policy-engine detail and may grow. */
export interface ContextCapsulePolicyView {
  authority: 'server_resolved_policy_not_model_permission';
  [field: string]: unknown;
}

export interface ContextCapsule {
  schemaVersion: 1; kind: 'companion_context_capsule';
  enrollmentId: string; courseDigest: string; pathRevision: number | null; planDigest: string | null;
  episodeId: string; blockId: string | null; currentStepId: string | null; activityInstanceId: string | null; attemptId: string | null;
  answersMessageId: string | null; uiRevision: number | null; contextRevision: number; enrollmentRevision: number;
  profileRevision: number; policyRevision: number; learnerModelRevision: number | null; recentEventCursor: string | null;
  selectedAnchor: ContextCapsuleAnchor | null;
  /** Learner-reported visual state: context only, never evidence. */
  simulationState: { blockId: string; visualId: string; settings: { key: string; label: string; value: unknown }[] } | null;
  codeSnapshotHash: string | null; assessmentMode: 'none' | 'practice_open' | 'independent_open';
  mediaRef: ContextCapsuleMediaRef | null; playbackSeconds: number | null; reviewedSegment: { startSeconds: number; endSeconds: number } | null;
  evidenceRefs: { evidenceId: string; attemptId: string }[]; historyRefs: ContextCapsuleHistoryRef[]; summary: ContextCapsuleSummary | null;
  sourceRefs: string[]; authorizationScopes: string[]; extensionAllowanceRefs: string[]; pendingGateDecisionRef: { decisionId: string; status: string } | null;
  resolvedConstraintSnapshot: {
    digest: string; deadline: string | null; expansionAllowed: boolean; independentAssessmentActive: boolean; policyRevision: number;
    view: ContextCapsulePolicyView | null;
  };
}
