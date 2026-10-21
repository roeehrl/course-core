import { z } from "zod";
import type { MessageKey, Translate } from "../i18n";

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
const codes = new Set([
  "ERASURE_CONFIRMATION_REQUIRED",
  "ERASURE_WAITING_FOR_SUPERVISION",
  "ALREADY_ERASED",
  "ENROLLMENT_NOT_FOUND",
  "INVALID_INPUT",
]);
export const learnerDataErrorMessage = (error: unknown, t: Translate) =>
  t(
    error instanceof LearnerDataError && codes.has(error.code)
      ? (`learnerData.error.${error.code}` as MessageKey)
      : "learnerData.error.unavailable",
  );
