import { z } from "zod";

export const erasureSchema = z.object({
  enrollmentId: z.string().uuid(),
  status: z.literal("erased"),
  counts: z.record(z.string(), z.number().int().nonnegative()),
  replayed: z.boolean(),
});
export interface LearnerDataPort {
  exportEnrollment(enrollmentId: string): Promise<unknown>;
  erase(
    enrollmentId: string,
    confirmation: string,
    reason: string,
  ): Promise<z.infer<typeof erasureSchema>>;
}
export class LearnerDataError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "LearnerDataError";
  }
}
const messages: Record<string, string> = {
  ERASURE_CONFIRMATION_REQUIRED: "Type the confirmation phrase exactly.",
  ERASURE_WAITING_FOR_SUPERVISION:
    "Supervision for this learner is stopping. Nothing was erased yet; try again shortly.",
  ALREADY_ERASED: "This enrollment's learning data was already erased.",
  ENROLLMENT_NOT_FOUND:
    "Only owners and admins can export or erase a learner's data.",
  INVALID_INPUT: "Add a reason of at least 10 characters.",
};
export const learnerDataErrorMessage = (error: unknown) =>
  messages[error instanceof LearnerDataError ? error.code : ""] ??
  "The data service is unavailable. Nothing was exported or erased.";
