/**
 * The companion's answer guard (docs/companion-check-integrity.md, "Answer guard").
 *
 * The instruction tells the tutor never to state the answer of an unsolved check or exercise and
 * never to work an example whose result equals it, but an instruction is followed only most of the
 * time (pilot quality check of 2026-11-02: a Hebrew reply refused, then worked -1 + 4 = 3, 3 - 1 = 2
 * for a check whose answer is 2). So when the server knows the answer of a graded check in scope (a turn
 * in check-coaching mode whose checks have deterministic keys), every draft is read by the same
 * rule the `hint_leakage` grader applies (companion-check-integrity.ts `draftAnswerLeak`):
 *
 * 1. A clean draft is kept as it is (`none`); no extra call.
 * 2. A leaking draft is written again once, with `REGENERATION_NOTE` added to the instruction
 *    (`regenerated` when the second draft is clean). The second call is the same request on the
 *    same model, charged to the same job, and runs only when the host admits it within the job's
 *    reservation (`admitRegeneration`); otherwise the fallback is delivered at once.
 * 3. A second leaking draft is replaced by Core's guiding message (`fallback`), the one the gateway
 *    delivers for any withheld reply (companion-check-integrity.ts `checkCoachingMessage`), in the
 *    learner's language, and the reply is marked withheld with the leak's reason.
 *
 * A turn in check-coaching mode never streams text to the learner (its draft is a checking one), so
 * no leaking draft is ever shown; the guard runs before the strategy returns. Answer keys stay on
 * the host: the guard is a closure the host builds, and the model only ever sees the note.
 */
import { definiteRejection, priceUsage, ProviderError, type ModelPricing, type UsageReceipt } from '@course-core/providers';
import { judgeCeilingMicroUsd } from './role-reservation.js';
import { checkCoachingMessage, draftAnswerLeak, lessonNumbers, type CheckLeak, type CheckLeakReason, type GradedCheck } from './companion-check-integrity.js';
import { aggregateSupervisorUsage } from './supervisor-tool-loop.js';
import { answeredRefusalReason, markHostCaused } from './output-refusal.js';

/** Part of the companion's revision (agent-evals/revision.ts): bump it when the guard's rule, note
 * or fallback changes what a learner is given, so the role is checked again. */
export const ANSWER_GUARD_VERSION = 'core.companion-answer-guard/1';
export const ANSWER_GUARD_OUTCOMES = ['none', 'regenerated', 'fallback'] as const;
export type AnswerGuardOutcome = (typeof ANSWER_GUARD_OUTCOMES)[number];
/** Added to the instruction of the one regeneration (no answer, no draft: only what to change). */
export const REGENERATION_NOTE = 'Correction: your previous draft of this reply revealed the answer to the learner\'s unsolved check or exercise, or worked an example whose result equals that answer. Write the reply again: do not state, bold or hint that answer in any form or language, and give any worked example different values so that its result is a different number. Keep the rest of your guidance.';
/** Longest companion text a strategy returns (agent-strategies.ts refuses longer ones). */
const MAX_TEXT = 32000;

/** What the host is asked before the regeneration: the first call's usage and the request size. */
export interface RegenerationRequest { used: UsageReceipt; draft: string; requestBytes: number; maxOutputTokens: number }
/** The host's guard for one companion turn. Built only when the in-scope checks' keys are known. */
export interface CompanionAnswerGuard {
  /** The draft's leak of an in-scope answer, by the grader's rule (codes only), or null. */
  leak(text: string): CheckLeak | null;
  /** Whether one more companion call fits the job's reservation (and anything it must still hold). */
  admitRegeneration(request: RegenerationRequest): boolean | Promise<boolean>;
  /** Core's guiding message, in the learner's language. */
  fallback: string;
}

/**
 * The guard for one turn over these checks, or undefined when the server knows no answer to guard
 * (no check, or none with a deterministic key: a rubric item is left to the semantic judge).
 * `admitRegeneration` defaults to always (offline scripted runs).
 */
export function companionAnswerGuard(input: { checks: readonly GradedCheck[]; question: string; lessonText?: string;
  admitRegeneration?: CompanionAnswerGuard['admitRegeneration'] }): CompanionAnswerGuard | undefined {
  if (!input.checks.some(check => check.keys.length > 0)) return undefined;
  const scope = { lessonNumbers: input.lessonText ? lessonNumbers(input.lessonText) : [] };
  return { leak: text => draftAnswerLeak(text, input.checks, input.question, scope), admitRegeneration: input.admitRegeneration ?? (() => true),
    fallback: checkCoachingMessage(input.question, input.checks) };
}

/** Tokens a receipt used: refused or unsent attempts count nothing; null when any other is unknown. */
function usedTokens(receipt: UsageReceipt): number | null {
  let sum = 0;
  for (const attempt of receipt.attempts) {
    if (attempt.outcome === 'rejected' || attempt.outcome === 'not_sent') continue;
    if (attempt.outcome !== 'response' && attempt.outcome !== 'partial' || attempt.tokens.total === null) return null;
    sum += attempt.tokens.total;
  }
  return sum;
}
/**
 * Whether the one regeneration fits an allowance, counted as any companion call is: what the first
 * call used, plus the second call's bound (its request bytes, framing and output limit, the same
 * bound the gateway checks before a call), plus what must still follow it (`after`: the check
 * judge's bound in the gateway), within the tokens and, when the model is priced, the micro-USD.
 * Unknown usage never fits.
 */
export function regenerationFits(request: RegenerationRequest, allowance: { microUsd: number; tokens: number }, pricing: ModelPricing | null,
  after: { tokens: number; microUsd: number } = { tokens: 0, microUsd: 0 }): boolean {
  const tokens = usedTokens(request.used);
  if (tokens === null || tokens + request.requestBytes + request.maxOutputTokens + 4096 + after.tokens > allowance.tokens) return false;
  if (!pricing) return true;
  const used = priceUsage(request.used, pricing).cost, again = judgeCeilingMicroUsd(request.requestBytes, request.maxOutputTokens, pricing);
  return used !== null && again !== null && used.microUsd + again + after.microUsd <= allowance.microUsd;
}

export interface CompanionDraft { text: string; cutShort?: boolean; usage: UsageReceipt }
export interface GuardedReply { text: string; cutShort?: boolean; usage: UsageReceipt; outcome: AnswerGuardOutcome; withheld?: CheckLeakReason }
/**
 * Applies the guard to the first draft: kept, written again once (`regenerate` sends the same
 * request with the note added), or replaced by the fallback. The usage covers every call made.
 * A regeneration the provider certainly never ran (not sent, or definitely rejected) leaves the
 * fallback charged at the first call; one it answered and the adapter refused is charged too. A
 * regeneration whose outcome is unknown (or cancelled) fails the run as uncertain with both calls'
 * usage, as a tool loop's later round does: nothing of either draft is delivered.
 */
export async function guardDraft(guard: CompanionAnswerGuard, first: CompanionDraft, regenerate: (note: string) => Promise<CompanionDraft>,
  options: { accountingKey: string; signal: AbortSignal; requestBytes: number; maxOutputTokens: number }): Promise<GuardedReply> {
  const leaked = guard.leak(first.text);
  if (!leaked) return { ...first, outcome: 'none' };
  const receipts = [first.usage];
  const usage = () => receipts.length === 1 ? first.usage : aggregateSupervisorUsage(receipts, options.accountingKey);
  const fallback = (leak: CheckLeak): GuardedReply => ({ text: guard.fallback, usage: usage(), outcome: 'fallback', withheld: leak.reason });
  if (!(await guard.admitRegeneration({ used: first.usage, draft: first.text, requestBytes: options.requestBytes, maxOutputTokens: options.maxOutputTokens })))
    return fallback(leaked);
  let second: CompanionDraft;
  try {
    second = await regenerate(REGENERATION_NOTE);
  } catch (error) {
    const original = error instanceof ProviderError ? error : undefined;
    if (!options.signal.aborted && original) {
      if (original.submission === 'not_sent' && !original.usage?.attempts.length) return fallback(leaked);
      if (definiteRejection(original)) return fallback(leaked);
      if (answeredRefusalReason(original) && original.usage) { receipts.push(original.usage); return fallback(leaked); }
    }
    const failure = new ProviderError(options.signal.aborted ? 'CANCELLED' : original?.code ?? 'INVALID_RESPONSE',
      { submission: 'unknown', ...(!options.signal.aborted && original?.reason ? { reason: original.reason } : {}) });
    if (original?.usage) receipts.push(original.usage);
    failure.usage = usage();
    if (!original) markHostCaused(failure);
    throw failure;
  }
  receipts.push(second.usage);
  if (second.text.length > MAX_TEXT || !second.text.trim()) return fallback(leaked);
  const again = guard.leak(second.text);
  if (again) return fallback(again);
  return { text: second.text, ...(second.cutShort ? { cutShort: true } : {}), usage: usage(), outcome: 'regenerated' };
}
