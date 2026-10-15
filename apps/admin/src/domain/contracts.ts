import { z } from "zod";
import type { ProviderSetupPort } from "./providerSetup";
import type { ProviderCostPort } from "./providerCosts";
import type { ResearchAdminPort } from "./research";
import type { MediaAdminPort } from "./media";
import type { PeopleAdminPort } from "./people";
import type { LearnerDataPort } from "./learnerData";
import type { LearnerViewPort } from "./learnerView";
import type { HypothesisReadPort } from "./hypotheses";
import type { ReviewsPort } from "./reviews";
import type { GateReviewsPort } from "./gateReviews";
import type { ReleaseSafetyPort } from "./releaseSafety";
import type { AuditPort, OverviewPort } from "./overview";
import type { PlacementAdminPort } from "./placementAdmin";
import type { SupervisionPort } from "./supervision";
import type {
  LearningPolicy,
  ExtensionRequest,
  ExtensionPreview,
  ExtensionProposal,
  ExtensionProposalResult,
  EnrollmentMutationContext,
} from "./policy";
export type * from "./policy";

const text = z.string().max(12000);
const id = z.string().min(1).max(200);
export const permissionSchema = z.enum([
  "course.write",
  "course.read",
  "release.review",
  "release.publish",
  "enrollment.write",
  "enrollment.read",
  "evidence.review",
  "extension.propose",
  "policy.read",
  "policy.write",
  "provider.configure",
  "run.inspect",
  "learner.view",
  "audit.read",
  "supervision.control",
]);
export type Permission = z.infer<typeof permissionSchema>;
export const profileSchema = z.object({
  displayName: z.string().trim().min(1).max(100),
  goal: z.string().max(2000),
  pace: z.enum(["gentle", "steady", "focused"]),
});
export type Profile = z.infer<typeof profileSchema>;
export const courseSummarySchema = z.object({
  id,
  title: text,
  description: text,
  workspaceId: id.optional(),
  workspaceTitle: text.optional(),
  role: text.optional(),
  /** Set when access comes from a course grant that ends at this time. */
  accessExpiresAt: z.string().max(64).optional(),
});
export const sessionSchema = z.object({
  actor: z.object({
    id,
    name: text,
    role: z.enum([
      "administrator",
      "reviewer",
      "observer",
      "member",
      "owner",
      "admin",
      "author",
      "instructor",
    ]),
  }),
  courses: z.array(courseSummarySchema),
});
export type AdminSession = z.infer<typeof sessionSchema>;
export const releaseSchema = z.object({
  id,
  version: text,
  availableForNewLearners: z.boolean().optional(),
  state: z.enum([
    "draft",
    "pending_review",
    "approved",
    "published",
    "archived",
  ]),
  notes: text,
  createdAt: text,
  checks: z.array(z.object({ label: text, passed: z.boolean(), detail: text })),
});
export type Release = z.infer<typeof releaseSchema>;
export const evidenceSchema = z.object({
  id,
  objective: text,
  summary: text,
  status: z.enum(["accepted", "pending_review", "rejected", "stale"]),
  version: text,
  rubricVersion: text,
  receiptId: text.nullable(),
  reviewable: z.boolean().optional(),
  passed: z.boolean().optional(),
  independent: z.boolean().optional(),
});
export const enrollmentSchema = z.object({
  id,
  learnerRef: id,
  revision: z.number().int().positive().optional(),
  profile: profileSchema,
  releaseVersion: text,
  status: z.enum(["active", "paused", "completed", "closed", "erased"]),
  completed: z.number().int().nonnegative(),
  required: z.number().int().positive(),
  evidence: z.array(evidenceSchema),
  lessons: z
    .array(
      z.object({
        id,
        status: z.enum(["available", "locked", "completed", "placed"]),
      }),
    )
    .optional(),
  placement: z
    .object({
      state: z.enum(["declined", "in_progress", "finished", "accepted"]),
      stopReason: text.nullable(),
      exemptEpisodeIds: z.array(id),
      startEpisodeId: id.nullable(),
      items: z.number().int().nonnegative().nullable(),
    })
    .nullable()
    .optional(),
});
export type Enrollment = z.infer<typeof enrollmentSchema>;
export const providerSchema = z.object({
  id,
  name: text,
  description: text,
  capabilities: z.array(text),
  configuration: z.enum(["absent", "pending_review", "configured"]),
  verification: z.enum(["not_run", "failed", "verified"]),
  connectionLabel: text,
  environment: text,
  detail: text,
});
export type Provider = z.infer<typeof providerSchema>;
export const runSummarySchema = z.object({
  id,
  label: text,
  status: z.enum([
    "pending_review",
    "blocked",
    "completed",
    "failed",
    "queued",
    "running",
    "waiting",
    "verifying",
    "ready",
    "applied",
    "cancelled",
    "budget_wait",
  ]),
  startedAt: text,
  contextVersion: text,
  toolCalls: z.number().int().nonnegative(),
  providerAttempts: z.number().int().nonnegative().nullable().optional(),
  artifactCount: z.number().int().nonnegative(),
});
export type RunSummary = z.infer<typeof runSummarySchema>;
/** Deliberate allowlist: no raw model traces, private reasoning or arbitrary HTML. */
export const runSchema = runSummarySchema.extend({
  summary: text,
  events: z.array(
    z.object({ id, time: text, label: text, status: text, detail: text }),
  ),
  context: z.array(
    z.object({
      id,
      label: text,
      version: text,
      source: text,
      visibility: text,
    }),
  ),
  decisions: z.array(
    z.object({
      id,
      tool: text,
      outcome: z.enum(["allowed", "denied", "pending_review"]),
      reasonCode: text,
      explanation: text,
      inputSummary: text,
      budgetUnits: z.number().nonnegative(),
    }),
  ),
  artifacts: z.array(
    z.object({
      id,
      name: text,
      mediaType: z.enum(["text/plain", "application/json"]),
      status: z.enum(["pending_review", "approved", "rejected"]),
      preview: text,
      provenance: text,
    }),
  ),
  /** Provider calls as identifiers and counts; never prompts, context or output. */
  providerCalls: z
    .array(
      z.object({
        operationId: text,
        state: z.enum(["in_flight", "completed", "not_started", "uncertain"]),
        failureCode: text.nullable(),
        providerId: text.nullable(),
        modelId: text.nullable(),
        operation: text.nullable(),
        inputCharacters: z.number().nullable(),
        requestedMaxOutputTokens: z.number().nullable(),
        attempts: z.array(
          z.object({
            attempt: z.number().nullable(),
            status: z.number().nullable(),
            outcome: text.nullable(),
            tokens: z.object({ input: z.number().nullable(), output: z.number().nullable(), total: z.number().nullable() }),
          }),
        ),
        startedAt: text,
        durationMs: z.number().nullable(),
      }),
    )
    .optional(),
  /** Teaching hypothesis changes this run made: identifiers and states only. */
  hypothesisChanges: z
    .array(
      z.object({
        hypothesisId: text,
        action: text,
        revision: z.number(),
        kind: text,
        status: text,
        pinnedByLearner: z.boolean(),
        templateId: text.nullable(),
        time: text,
      }),
    )
    .optional(),
  verification: z
    .object({
      verifier: text,
      verdict: z.enum(["verified", "rejected", "revoked"]),
      applicationKind: text,
      verifiedAt: text,
      applied: z.object({ kind: text, at: text }).nullable(),
    })
    .nullable()
    .optional(),
});
export type SupervisorRun = z.infer<typeof runSchema>;
export const workspaceSchema = z.object({
  course: courseSummarySchema.extend({
    category: text,
    objectives: z.array(text),
  }),
  revision: id,
  role: text.optional(),
  permissions: z.array(permissionSchema),
  releases: z.array(releaseSchema),
  enrollments: z.array(enrollmentSchema),
  providers: z.array(providerSchema),
  runs: z.array(runSummarySchema),
  toolBudget: z
    .object({
      limit_micro_usd: z.string(),
      limit_tokens: z.string(),
      used_micro_usd: z.string(),
      used_tokens: z.string(),
    })
    .nullable()
    .optional(),
});
export type CourseWorkspace = z.infer<typeof workspaceSchema>;
export const mutationSchema = z.object({
  workspace: workspaceSchema,
  receipt: z.object({
    id,
    authority: z.enum(["demo", "server"]),
    outcome: z.enum(["saved", "pending_review", "reserved", "published"]),
  }),
  message: text,
});
export type MutationResult = z.infer<typeof mutationSchema>;
export interface MutationContext {
  expectedRevision: string;
  idempotencyKey: string;
  targetRevision?: number;
}
export type ReleaseAction =
  "submit-review" | "approve" | "publish" | "activate" | "archive";
export type EvidenceDecision = { decision: "accept" | "reject"; note: string };
export type ProviderConfig = { connectionLabel: string; environment: string };
/** Presentation port. Parent adapters import released SDK contracts and map here. */
export interface AdminClient {
  providerSetup?: ProviderSetupPort;
  /** Operator model pricing and reserved-versus-actual spend. Absent in demos. */
  providerCosts?: ProviderCostPort;
  /** Source catalog, inspection, review and optional delivery. Absent in demos that do not model it. */
  research?: ResearchAdminPort;
  /** Generated media jobs: cost, provider operation, review and optional delivery. */
  media?: MediaAdminPort;
  /** Workspace membership administration. Server authorization governs every change. */
  people?: PeopleAdminPort;
  /** Owner/admin export and irreversible erasure of one enrollment's personal data. */
  learnerData?: LearnerDataPort;
  /** Owner/admin read-only, audited view of what one learner sees. */
  learnerView?: LearnerViewPort;
  /** Read-only teaching hypotheses, probe runs and trigger decisions for one enrollment. */
  teachingHypotheses?: HypothesisReadPort;
  /** Written-answer (rubric) review queue and decisions. */
  reviews?: ReviewsPort;
  /** Learner requests to look at a gate decision again: uphold, or grant an audited exception. */
  gateReviews?: GateReviewsPort;
  /** What needs attention on one course. */
  overview?: OverviewPort;
  /** Workspace audit log; payloads only for allowlisted staff and system events. */
  audit?: AuditPort;
  /** Placement settings, per-enrollment exemptions and overrides, quality counters. */
  placement?: PlacementAdminPort;
  /** Pause, stop and resume one enrollment's AI supervision. */
  supervision?: SupervisionPort;
  adaptationRuntime?(): Promise<{
    adapters: {
      id: string;
      kind: string;
      implementationDigest: string;
      authorization: string;
    }[];
  }>;
  adaptationRegistry?(
    releaseId: string,
  ): Promise<{
    registryRevision: number;
    configured: boolean;
    configurationDigest: string | null;
  }>;
  approveAdaptationRegistry?(
    releaseId: string,
    expectedRegistryRevision: number,
    configuration: unknown,
  ): Promise<{ registryRevision: number }>;
  readonly mode: "demo" | "connected";
  getSession(signal?: AbortSignal): Promise<AdminSession>;
  getCourse(courseId: string, signal?: AbortSignal): Promise<CourseWorkspace>;
  getRun(
    courseId: string,
    runId: string,
    signal?: AbortSignal,
  ): Promise<SupervisorRun>;
  updateCourse(
    courseId: string,
    input: { title: string; description: string },
    context: MutationContext,
  ): Promise<MutationResult>;
  createRelease(
    courseId: string,
    input: { version: string; notes: string; manifest?: unknown },
    context: MutationContext,
  ): Promise<MutationResult>;
  getReleaseManifest?(
    courseId: string,
    releaseId: string,
    signal?: AbortSignal,
  ): Promise<{ manifest: unknown; notes: string; editable: boolean }>;
  updateRelease?(
    courseId: string,
    releaseId: string,
    input: { manifest: unknown; notes: string },
    context: MutationContext,
  ): Promise<MutationResult>;
  transitionRelease(
    courseId: string,
    releaseId: string,
    action: ReleaseAction,
    context: MutationContext,
    /** Selecting an older release (rollback) needs the digest of its reviewed impact. */
    confirmation?: { impactDigest: string },
  ): Promise<MutationResult>;
  /** Rollback impact, release diff and defective items. Absent in demos. */
  releaseSafety?: ReleaseSafetyPort;
  enroll(
    courseId: string,
    input: { learnerRef: string; profile: Profile; releaseId?: string },
    context: MutationContext,
  ): Promise<MutationResult>;
  updateProfile(
    courseId: string,
    enrollmentId: string,
    profile: Profile,
    context: MutationContext,
  ): Promise<MutationResult>;
  reviewEvidence(
    courseId: string,
    enrollmentId: string,
    evidenceId: string,
    input: EvidenceDecision,
    context: MutationContext,
  ): Promise<MutationResult>;
  getPolicy(
    enrollmentId: string,
    signal?: AbortSignal,
  ): Promise<LearningPolicy>;
  previewExtension(
    enrollmentId: string,
    input: ExtensionRequest,
    signal?: AbortSignal,
  ): Promise<ExtensionPreview>;
  proposeExtension(
    enrollmentId: string,
    input: ExtensionProposal,
    context: EnrollmentMutationContext,
  ): Promise<ExtensionProposalResult>;
  previewPolicyChange?(
    enrollmentId: string,
    scopes: unknown[],
    signal?: AbortSignal,
  ): Promise<import("./policy").PolicyMigrationPreview>;
  migratePolicy?(
    enrollmentId: string,
    input: { previewId: string; previewDigest: string; reason: string },
    context: EnrollmentMutationContext,
  ): Promise<import("./policy").PolicyMigrationResult>;
  /** Individual accommodation or approved pause, authorized separately from extension pools. */
  previewAccommodation?(
    enrollmentId: string,
    input: import("./policy").AccommodationRequest,
    signal?: AbortSignal,
  ): Promise<import("./policy").AccommodationPreview>;
  applyAccommodation?(
    enrollmentId: string,
    input: { previewId: string; previewDigest: string; reason: string },
    context: EnrollmentMutationContext,
  ): Promise<import("./policy").AccommodationResult>;
  requestProviderConfig(
    courseId: string,
    providerId: string,
    input: ProviderConfig,
    context: MutationContext,
  ): Promise<MutationResult>;
}
