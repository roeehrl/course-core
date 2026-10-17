import { z } from 'zod';

/**
 * Round checks of the supervisor tool loop (supervisor-tool-loop.ts). They refuse mid-run, after
 * tool receipts and paid rounds were recorded: the receipts stay (they are the run's record), the
 * usage of every round is charged, and no partial plan is kept or applied.
 * - invalid_decision: a decision that fails the loop's contract (shape, finish rules, arguments).
 * - candidate_limit: a third teaching candidate, research request or reviewed resource.
 * - round_limit: the model used every round without finishing.
 * - tool_result_too_large / input_too_large: a tool result, or the next round's prompt, over its bound.
 * - round_not_started: the provider certified a later round was never sent (e.g. a missing credential).
 */
export const TOOL_LOOP_REFUSAL_REASONS = ['tool_loop_invalid_decision', 'tool_loop_candidate_limit', 'tool_loop_round_limit',
  'tool_loop_tool_result_too_large', 'tool_loop_input_too_large', 'tool_loop_round_not_started'] as const;
export type ToolLoopRefusalReason = (typeof TOOL_LOOP_REFUSAL_REASONS)[number];
/**
 * Output a strategy received from the model and refused by Core's own checks before storing it:
 * a teaching proposal naming an objective outside this lesson, a companion reply over the
 * size bound, or a supervisor tool loop whose own round checks refused a decision (see
 * TOOL_LOOP_REFUSAL_REASONS). The model ran and its usage is known, so this is a definite
 * outcome, not an uncertain submission. It is stored only as this record (the role and a reason code, never
 * the refused text); the host verifier rejects it, so the job ends failed with
 * `verification_rejected` and nothing is delivered. A response Core cannot know the fate of
 * (a timeout or lost connection after sending) still waits as `provider_uncertain`.
 */
export const OUTPUT_REFUSAL_REASONS = ['objective_out_of_scope', 'output_too_large', ...TOOL_LOOP_REFUSAL_REASONS] as const;
export type OutputRefusalReason = (typeof OUTPUT_REFUSAL_REASONS)[number];
export const outputRefusalSchema = z.strictObject({
  kind: z.literal('output_refusal'),
  role: z.enum(['supervisor', 'companion']),
  reason: z.enum(OUTPUT_REFUSAL_REASONS),
}).refine((value) => value.role === 'supervisor' || !(TOOL_LOOP_REFUSAL_REASONS as readonly string[]).includes(value.reason));
export type OutputRefusal = z.infer<typeof outputRefusalSchema>;
