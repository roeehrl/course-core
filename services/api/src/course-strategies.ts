import { validateContract, type AgentStrategy, type AgentRole as SdkAgentRole } from '@course-core/sdk';
import { ProviderError } from '@course-core/providers';
import { supervisorTool } from './supervisor-tool-catalog.js';
import { BUILT_IN_STRATEGIES, defineRuntimeStrategy, supervisorToolLoopStrategy, toolLoopRunner, type AgentRole, type RuntimeStrategy } from './agent-strategies.js';

/**
 * Course-declared agent strategies (requirement B08; SDK 0.5 `agentStrategies`, a server-only
 * manifest section). A course package carries data, never code, so a declaration cannot add an
 * implementation. Core binds it to one of its own runtime strategies for the same role and lets it
 * only NARROW that strategy: fewer catalog tools, fewer tool rounds, a smaller output allowance,
 * fewer retries, a subset of proposal kinds and applicable operations, and an autonomy level of
 * propose_only or the base level. Anything that would widen authority is a problem: the package
 * is refused at inspection and install, and a stored release's declaration is ignored at runtime.
 * The host's verifiers and application path still decide every effect.
 */
export const SDK_TO_HOST: Partial<Record<SdkAgentRole, AgentRole>> = {
  supervisor: 'supervisor', companion_tutor: 'companion', researcher: 'research', builder: 'media', evaluator: 'reviewer',
};
export interface StrategyProblem { strategyId: string; code: string }
const subset = (a: readonly string[], b: readonly string[]) => a.every(x => b.includes(x));
/** The Core strategy a declaration narrows: the tool loop when it names tools, otherwise the
 * role's first tool-free built-in strategy. */
function baseFor(role: AgentRole, declared: AgentStrategy): RuntimeStrategy | undefined {
  if (declared.toolRefs.length) return role === 'supervisor' ? supervisorToolLoopStrategy : undefined;
  return BUILT_IN_STRATEGIES.find(s => s.role === role && s.contract.toolRefs.length === 0
    && subset(declared.outputContract.proposalKinds, s.contract.outputContract.proposalKinds));
}
/** Why a declaration cannot be bound (empty when it can). Codes only. */
export function strategyProblems(raw: unknown): { strategy: AgentStrategy | null; role: AgentRole | null; base: RuntimeStrategy | null; codes: string[] } {
  const checked = validateContract('agentStrategy', raw);
  if (!checked.valid) return { strategy: null, role: null, base: null, codes: ['STRATEGY_CONTRACT_INVALID'] };
  const s = checked.value, codes: string[] = [];
  if (s.id.startsWith('core.')) codes.push('STRATEGY_ID_RESERVED');
  const roles = [...new Set(s.roles.map(r => SDK_TO_HOST[r]).filter((r): r is AgentRole => r !== undefined))];
  if (roles.length !== 1 || s.roles.some(r => !SDK_TO_HOST[r])) return { strategy: s, role: null, base: null, codes: [...codes, 'STRATEGY_ROLE_UNSUPPORTED'] };
  const role = roles[0]!, base = baseFor(role, s);
  if (!base) return { strategy: s, role, base: null, codes: [...codes, s.toolRefs.length ? 'STRATEGY_TOOLS_NOT_SUPPORTED_FOR_ROLE' : 'STRATEGY_NO_BASE'] };
  const b = base.contract;
  if (!subset(s.toolRefs, b.toolRefs)) codes.push('STRATEGY_TOOL_NOT_IN_CATALOG');
  if (!subset(s.outputContract.proposalKinds, b.outputContract.proposalKinds)) codes.push('STRATEGY_PROPOSAL_WIDENS');
  if (s.budget.maxToolCalls > b.budget.maxToolCalls || s.budget.maxWallSeconds > b.budget.maxWallSeconds || s.budget.maxOutputTokens > b.budget.maxOutputTokens)
    codes.push('STRATEGY_BUDGET_WIDENS');
  if (s.retry.maxAttempts > b.retry.maxAttempts) codes.push('STRATEGY_RETRY_WIDENS');
  if (!(s.autonomy.level === 'propose_only' || s.autonomy.level === b.autonomy.level) || !subset(s.autonomy.mayApply, b.autonomy.mayApply)
    || s.autonomy.maxAppliedChangesPerDay > b.autonomy.maxAppliedChangesPerDay) codes.push('STRATEGY_AUTONOMY_WIDENS');
  if (!subset(s.modelRequirements.capabilities, b.modelRequirements.capabilities)) codes.push('STRATEGY_CAPABILITY_UNSUPPORTED');
  return { strategy: s, role, base, codes };
}
/** Problems across a manifest's declarations (package inspection and install). The SDK makes a
 * strategy's toolRefs name tools the course declares; a declared tool that a strategy uses must be
 * Core's catalog tool of that id, with the same side effects and no capability Core's lacks. */
export function courseStrategyProblems(bundle: unknown): StrategyProblem[] {
  const declared = (bundle as { agentStrategies?: unknown } | null)?.agentStrategies;
  if (declared === undefined) return [];
  if (!Array.isArray(declared) || declared.length > 16) return [{ strategyId: '', code: 'STRATEGY_LIST_INVALID' }];
  const courseTools = (bundle as { tools?: unknown }).tools;
  const toolList = Array.isArray(courseTools) ? courseTools as { id?: unknown; sideEffects?: unknown; capabilities?: unknown }[] : [];
  const problems: StrategyProblem[] = [], ids = new Set<string>(), roles = new Set<string>();
  for (const raw of declared) {
    const result = strategyProblems(raw), id = result.strategy?.id ?? '';
    for (const code of result.codes) problems.push({ strategyId: id, code });
    for (const ref of result.strategy?.toolRefs ?? []) {
      const own = toolList.find(t => t.id === ref), core = supervisorTool(ref)?.contract;
      if (!own) { problems.push({ strategyId: id, code: 'STRATEGY_TOOL_NOT_DECLARED' }); continue; }
      if (!core || own.sideEffects !== core.sideEffects || !Array.isArray(own.capabilities) || !subset(own.capabilities as string[], core.capabilities))
        problems.push({ strategyId: id, code: 'STRATEGY_TOOL_CONTRACT_MISMATCH' });
    }
    if (id && ids.has(id)) problems.push({ strategyId: id, code: 'STRATEGY_DUPLICATE' });
    // One declaration per host role and base: which one runs must never be ambiguous.
    const slot = `${result.role}:${result.base?.contract.id}`;
    if (result.role && result.base && roles.has(slot)) problems.push({ strategyId: id, code: 'STRATEGY_ROLE_TAKEN' });
    ids.add(id); roles.add(slot);
  }
  return problems;
}
/** The runtime strategies a release's declarations bind to. Declarations with any problem are left
 * out (Core's own strategy runs instead). Pure; callers may cache by release digest. */
export function bindCourseStrategies(bundle: unknown): RuntimeStrategy[] {
  const declared = (bundle as { agentStrategies?: unknown } | null)?.agentStrategies;
  if (!Array.isArray(declared) || declared.length > 16 || courseStrategyProblems(bundle).length) return [];
  return declared.map(raw => {
    const { strategy, role, base } = strategyProblems(raw);
    const contract = strategy!, b = base!;
    return defineRuntimeStrategy({
      role: role!, contract,
      capability: binding => b.capability(binding),
      matches: binding => b.matches(binding),
      reservationBound: (context, binding) => b.reservationBound(context, { ...binding, maxOutputTokens: Math.min(binding.maxOutputTokens, contract.budget.maxOutputTokens) }),
      run: b === supervisorToolLoopStrategy
        ? toolLoopRunner(() => contract.toolRefs, contract.budget.maxToolCalls + 1, () => contract.autonomy.level)
        : async input => {
          // The declaration's output allowance caps the binding's; nothing else about the run changes.
          if (contract.budget.maxOutputTokens < 1) throw new ProviderError('INVALID_CONFIG', { submission: 'not_sent' });
          return b.run({ ...input, binding: { ...input.binding, maxOutputTokens: input.binding.maxOutputTokens === 0 ? 0 : Math.min(input.binding.maxOutputTokens, contract.budget.maxOutputTokens) } });
        },
    });
  });
}
const cache = new Map<string, RuntimeStrategy[]>();
/** bindCourseStrategies, remembered per release digest (bounded). */
export function courseStrategiesFor(digest: string, bundle: unknown): RuntimeStrategy[] {
  const hit = cache.get(digest);
  if (hit) return hit;
  const bound = bindCourseStrategies(bundle);
  if (cache.size >= 64) cache.delete(cache.keys().next().value!);
  cache.set(digest, bound);
  return bound;
}
