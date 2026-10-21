import { z } from "zod";

/** Agent evaluation gate (API: /api/admin/workspaces/:id/provider-evals). */
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const role = z.enum([
  "supervisor",
  "companion",
  "research",
  "media",
  "reviewer",
]);
export const EVAL_STATUSES = [
  "passed",
  "override",
  "failed",
  "stale",
  "not_evaluated",
  "not_covered",
] as const;
export const evalRoleSchema = z.object({
  role,
  strategy: z.string().max(200).nullable(),
  revisionDigest: digest,
  covered: z.boolean(),
  status: z.enum(EVAL_STATUSES),
  grandfathered: z.boolean(),
  activatedBy: z.string().max(40).nullable(),
  evaluatedAt: z.string().optional(),
  overriddenAt: z.string().optional(),
});
export const evalStatusSchema = z.object({
  suite: z.object({
    id: z.string().max(120),
    version: z.string().max(40),
    digest,
    dialogues: z.number().int().nonnegative(),
    coverage: z
      .array(
        z.object({
          role: z.string().max(40),
          dialogues: z.number().int().nonnegative(),
        }),
      )
      .max(10),
  }),
  providerRevision: z.number().int().nonnegative(),
  gatedAtActivation: z.boolean(),
  roles: z.array(evalRoleSchema).max(10),
  results: z
    .array(
      z.object({
        id: z.string().uuid(),
        role,
        revisionDigest: digest,
        suiteDigest: digest,
        mode: z.enum(["scripted", "live"]),
        outcome: z.enum(["passed", "failed"]),
        actorId: z.string().uuid(),
        createdAt: z.string(),
        failed: z
          .array(
            z.object({
              dialogueId: z.string().max(120),
              graders: z.array(z.string().max(40)).max(10),
            }),
          )
          .max(200),
      }),
    )
    .max(50),
  overrides: z
    .array(
      z.object({
        id: z.string().uuid(),
        role,
        revisionDigest: digest,
        suiteDigest: digest,
        reason: z.string().max(1000),
        actorId: z.string().uuid(),
        createdAt: z.string(),
      }),
    )
    .max(50),
});
export type EvalStatus = z.infer<typeof evalStatusSchema>;
export const overrideReceiptSchema = z.object({
  id: z.string().uuid(),
  role,
  revisionDigest: digest,
  suiteDigest: digest,
  createdAt: z.string(),
});
/** What a refused activation (409 PROVIDER_EVAL_REQUIRED) says is missing. */
export const evalRequiredSchema = z.object({
  suiteDigest: digest,
  roles: z
    .array(
      z.object({
        role,
        revisionDigest: digest,
        reason: z.enum(["not_evaluated", "failed", "stale_suite"]),
      }),
    )
    .min(1)
    .max(5),
});
export type EvalRequired = z.infer<typeof evalRequiredSchema>;
export interface ProviderEvalPort {
  status(workspace: string, signal?: AbortSignal): Promise<EvalStatus>;
  override(
    workspace: string,
    input: {
      idempotencyKey: string;
      role: string;
      revisionDigest: string;
      reason: string;
    },
  ): Promise<z.infer<typeof overrideReceiptSchema>>;
}
