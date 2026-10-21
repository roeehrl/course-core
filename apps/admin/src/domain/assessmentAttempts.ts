import { z } from "zod";
import { assessmentPolicySchema } from "./policyLedger";

// Graded-attempt use per check for one enrollment, and the staff "allow one more attempt" action.
// The server enforces the limit and the wait; this view only explains them.
const count = z.number().int().nonnegative();
export const checkAttemptsSchema = z.object({
  checkId: z.string().min(1).max(256),
  title: z.string().max(500),
  used: count,
  limit: count.nullable(),
  granted: count,
  retryAt: z.string().datetime({ offset: true }).nullable(),
});
export type CheckAttempts = z.infer<typeof checkAttemptsSchema>;
export const assessmentAttemptsSchema = z.object({
  enrollmentId: z.string().min(1).max(256),
  revision: count,
  policy: assessmentPolicySchema,
  checks: z.array(checkAttemptsSchema).max(500),
  receipt: z
    .object({
      id: z.string().min(1).max(256),
      authority: z.enum(["demo", "server"]),
      outcome: z.string(),
    })
    .optional(),
});
export type AssessmentAttempts = z.infer<typeof assessmentAttemptsSchema>;
