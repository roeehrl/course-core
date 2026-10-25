import { z } from 'zod';
import { ProviderError } from '@course-core/providers';

/**
 * Round checks of the supervisor tool loop (supervisor-tool-loop.ts). They refuse mid-run, after
 * tool receipts and paid rounds were recorded: the receipts stay (they are the run's record), the
 * usage of every round is charged, and no partial plan is kept or applied.
 * - invalid_decision: a decision that fails the loop's contract (shape, finish rules, arguments).
 * - candidate_limit: a third teaching candidate, research request or reviewed resource.
 * - round_limit: the model used every round without finishing.
 * - tool_result_too_large / input_too_large: a tool result, or the next round's prompt, over its bound.
 * - round_not_started: the provider certified a later round was never sent (e.g. a missing credential).
 * - round_rejected: the provider definitely refused a later round (auth, permission, rate limit).
 * - runtime_unavailable: host-side, not the model's doing: an approved generation profile the run
 *   listed is no longer in the active registry or installed adapters.
 * The last three end the run as a host or provider failure; the model is not blamed for them.
 */
export const TOOL_LOOP_REFUSAL_REASONS = ['tool_loop_invalid_decision', 'tool_loop_candidate_limit', 'tool_loop_round_limit',
  'tool_loop_tool_result_too_large', 'tool_loop_input_too_large', 'tool_loop_round_not_started',
  'tool_loop_round_rejected', 'tool_loop_runtime_unavailable'] as const;
export type ToolLoopRefusalReason = (typeof TOOL_LOOP_REFUSAL_REASONS)[number];
/** Reasons that end a run for a host or provider cause, never for what the model returned. */
export const HOST_ENDED_REASONS: readonly string[] = ['tool_loop_round_not_started', 'tool_loop_round_rejected', 'tool_loop_runtime_unavailable',
  'provider_stream_stopped', 'provider_stream_stalled'];
/**
 * A streamed reply that stopped part way after the provider had reported its cumulative usage up
 * to the stop (provider-gateway.ts): `provider_stream_stopped` when Core stopped it because its
 * job was cancelled (the learner's Stop, staff, erasure), `provider_stream_stalled` when the
 * provider stopped sending (the idle or call bound, or a stream cut off early). The call is settled
 * at that usage and the rest of the reservation released; nothing of the reply is kept. Neither is
 * the model's doing.
 */
export const STOPPED_REPLY_REASONS = ['provider_stream_stopped', 'provider_stream_stalled'] as const;
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
/** autonomy_exceeded: a course strategy that may only propose (SDK autonomy propose_only) produced a
 * plan that would change the learner's teaching (course-strategies.ts). */
/**
 * A reply the provider returned in full (HTTP response read, usage reported) that the adapter's
 * own output checks refused: cut off at the output limit (INCOMPLETE_OUTPUT), malformed or not the
 * requested structure (INVALID_RESPONSE), or blocked by the provider's safety stop (BLOCKED). The
 * model ran and the usage is known, so the call is settled at that usage, not held as uncertain.
 */
export const PROVIDER_OUTPUT_REASONS = { INCOMPLETE_OUTPUT: 'provider_output_incomplete', INVALID_RESPONSE: 'provider_output_invalid', BLOCKED: 'provider_output_blocked' } as const;
export type ProviderOutputReason = (typeof PROVIDER_OUTPUT_REASONS)[keyof typeof PROVIDER_OUTPUT_REASONS];
/** The reason for a refused but completed reply, or null when the outcome is not certain: any
 * attempt without a read response, or any response without a reported token total. */
export function answeredRefusalReason(error: unknown): ProviderOutputReason | null {
  return error instanceof ProviderError && !hostCaused.has(error) ? refusedAnswerReason(error.code, error.usage) : null;
}
/** Errors a strategy raised for a host-side cause (for example a tool refusing because the
 * learner's state changed mid-run) that carry the run's usage but are not about the reply. */
const hostCaused = new WeakSet<ProviderError>();
export function markHostCaused(error: ProviderError) { hostCaused.add(error); return error; }
/** The same decision from a stored failure code and usage receipt (gateway dispatch rows). */
export function refusedAnswerReason(code: unknown, usage: unknown): ProviderOutputReason | null {
  if (typeof code !== 'string' || !Object.hasOwn(PROVIDER_OUTPUT_REASONS, code)) return null;
  const attempts = (usage as { attempts?: unknown } | null | undefined)?.attempts;
  if (!Array.isArray(attempts) || !attempts.length || attempts.some(attempt => !attempt || typeof attempt !== 'object'
    || (attempt as { outcome?: unknown }).outcome !== 'response'
    || !Number.isSafeInteger((attempt as { tokens?: { total?: unknown } }).tokens?.total)
    || ((attempt as { tokens: { total: number } }).tokens.total) < 0)) return null;
  return PROVIDER_OUTPUT_REASONS[code as keyof typeof PROVIDER_OUTPUT_REASONS];
}
export const OUTPUT_REFUSAL_REASONS = ['objective_out_of_scope', 'output_too_large', 'autonomy_exceeded', 'provider_output_incomplete', 'provider_output_invalid', 'provider_output_blocked',
  ...STOPPED_REPLY_REASONS, ...TOOL_LOOP_REFUSAL_REASONS] as const;
export type OutputRefusalReason = (typeof OUTPUT_REFUSAL_REASONS)[number];
export const outputRefusalSchema = z.strictObject({
  kind: z.literal('output_refusal'),
  role: z.enum(['supervisor', 'companion']),
  reason: z.enum(OUTPUT_REFUSAL_REASONS),
}).refine((value) => value.role === 'supervisor' || !(TOOL_LOOP_REFUSAL_REASONS as readonly string[]).includes(value.reason));
export type OutputRefusal = z.infer<typeof outputRefusalSchema>;
