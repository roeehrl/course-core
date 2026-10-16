import { z } from 'zod';

/**
 * Output a strategy received from the model and refused by Core's own checks before storing it:
 * a teaching proposal naming an objective outside this lesson, or a companion reply over the
 * size bound. The model ran and its usage is known, so this is a definite outcome, not an
 * uncertain submission. It is stored only as this record (the role and a reason code, never
 * the refused text); the host verifier rejects it, so the job ends failed with
 * `verification_rejected` and nothing is delivered. A response Core cannot know the fate of
 * (a timeout or lost connection after sending) still waits as `provider_uncertain`.
 */
export const OUTPUT_REFUSAL_REASONS = ['objective_out_of_scope', 'output_too_large'] as const;
export type OutputRefusalReason = (typeof OUTPUT_REFUSAL_REASONS)[number];
export const outputRefusalSchema = z.strictObject({
  kind: z.literal('output_refusal'),
  role: z.enum(['supervisor', 'companion']),
  reason: z.enum(OUTPUT_REFUSAL_REASONS),
});
export type OutputRefusal = z.infer<typeof outputRefusalSchema>;
