import { z } from "zod";
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
  status: z.enum(["active", "paused", "completed", "closed"]),
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
export type ReleaseAction = "submit-review" | "approve" | "publish";
export type EvidenceDecision = { decision: "accept" | "reject"; note: string };
export type ProviderConfig = { connectionLabel: string; environment: string };
/** Presentation port. Parent adapters import released SDK contracts and map here. */
export interface AdminClient {
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
  ): Promise<MutationResult>;
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
  requestProviderConfig(
    courseId: string,
    providerId: string,
    input: ProviderConfig,
    context: MutationContext,
  ): Promise<MutationResult>;
}
