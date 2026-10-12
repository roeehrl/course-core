import type { ActivityAssignmentDecision, AdaptationPlanSnapshot, ArtifactProofReceipt, CourseAdaptation, CourseManifest, RegisteredVerifier } from '@course-core/sdk';
import type { PolicyState, Work } from '@course-core/policy';

export class AdaptationError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'AdaptationError'; }
}
export function requireCondition(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new AdaptationError(code, message);
}
/** Loaded from authoritative evidence storage; adaptation never writes evidence. */
export interface EvidenceFence { enrollmentId: string; baseCourseDigest: string; revision: number; digest: string }
/** A host-authenticated record, NOT a receipt claimed inside a model proposal. */
export interface TrustedProof {
  enrollmentId: string; baseCourseDigest: string; authenticationRef: string;
  status: 'active' | 'revoked'; receipt: ArtifactProofReceipt;
}
export interface TrustedAuthorization {
  receiptRef: string; enrollmentId: string; baseCourseDigest: string;
  proposalDigest: string; assignmentsDigest: string; evidenceRevision: number; evidenceDigest: string;
  authorizedAt: string; expiresAt: string; status: 'active' | 'revoked';
}
/** Host-owned snapshot. Never merge this with proposal/model/browser data. */
export interface TrustedRegistry {
  revision: number;
  verifiers: RegisteredVerifier[]; proofs: TrustedProof[]; authorizations: TrustedAuthorization[];
  episodeScopes: { episodeId: string; scopeId: string }[];
  objectiveConcepts: { objectiveId: string; conceptId: string }[];
  /** Existing reserved headroom for required core teaching/final assessments. */
  protectedReservationIds: string[];
}
export interface RuntimeContext {
  course: CourseManifest; policy: PolicyState; evidence: EvidenceFence; registry: TrustedRegistry;
}
export interface ReservationBinding { reservationId: string; scopeId: string; work: Work }
export interface Admission {
  id: string; authorizationRef: string; status: 'reserved' | 'applied' | 'cancelled';
  proposal: CourseAdaptation; proposalDigest: string; assignments: ActivityAssignmentDecision[];
  admittedPlan: AdaptationPlanSnapshot; admittedVerifiers: RegisteredVerifier[];
  admittedPolicyRevision: number; evidence: EvidenceFence;
  bindingsDigest: string; authorizationDigest: string; reservations: ReservationBinding[];
}
export interface AppliedAdaptation { admissionId: string; revision: number; parentDigest: string; digest: string }
export interface CommandReceipt {
  idempotencyKey: string; requestDigest: string; operation: 'admit' | 'apply' | 'cancel'; resourceId: string;
  ledgerRevision: number; planRevision: number; planDigest: string;
}
export interface AdaptationState {
  schemaVersion: 1; enrollmentId: string; baseCourseDigest: string; ledgerRevision: number; digest: string;
  bindingsDigest: string;
  plan: AdaptationPlanSnapshot; admissions: Admission[]; applications: AppliedAdaptation[]; receipts: CommandReceipt[];
}
export interface Command {
  idempotencyKey: string; now: string; expectedAdaptationRevision: number;
  expectedPolicyRevision: number; expectedPolicyLedgerRevision: number;
  expectedRegistryRevision: number; expectedEvidenceRevision: number;
}
export interface AdmitCommand extends Command {
  admissionId: string; authorizationRef: string; proposal: CourseAdaptation; assignments: ActivityAssignmentDecision[];
}
export interface AdmissionCommand extends Command { admissionId: string }
export interface TransactionPreconditions {
  enrollmentId: string; baseCourseDigest: string;
  evaluatedAt: string;
  /** Exclusive deadline for a NEW admission/application; null for cancellation/replay. */
  mustCommitBefore: string | null;
  adaptation: { ledgerRevision: number; digest: string; planRevision: number; planDigest: string };
  policy: { policyRevision: number; ledgerRevision: number; digest: string };
  registry: { revision: number; digest: string }; evidence: EvidenceFence;
}
export interface AdaptationTransition {
  state: AdaptationState; policy: PolicyState; receipt: CommandReceipt; replayed: boolean;
  preconditions: TransactionPreconditions;
  outbox: { id: string; type: 'adaptation.admitted' | 'adaptation.applied' | 'adaptation.cancelled'; admissionId: string; planRevision: number; planDigest: string }[];
  evidenceWrites: []; creditWrites: [];
}
