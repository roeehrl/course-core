import { describe, expect, it } from 'vitest';
import { defineAgentStrategy, validateContract, type AgentStrategy } from '@course-core/sdk';
import type { ProviderAdapter, TextRequest, UsageReceipt } from '@course-core/providers';
import { composeProviders } from '../src/provider-composition.js';
import { MAX_MODEL_CONTEXT_BYTES } from '../src/provider-runtime.js';
import {
  BUILT_IN_STRATEGIES, StrategyContractError, StrategyRegistry, defineRuntimeStrategy, minimizeContext,
  type RuntimeStrategy, type TeachingContext,
} from '../src/agent-strategies.js';
import { SUPERVISOR_TOOLS, SUPERVISOR_TOOL_IDS } from '../src/supervisor-tool-catalog.js';
import { IMPLEMENTED_SUPERVISOR_TOOLS } from '../src/supervisor-tools.js';
import { supervisorToolDecisionSchema } from '../src/supervisor-tool-loop.js';

function context(): TeachingContext { return {
  course: { title: 'Ordering', digest: 'a'.repeat(64) },
  episode: { id: 'min', title: 'Minimum', teaching: 'The smaller value comes first.', objectives: [{ id: 'minimum', description: 'Find a minimum.' }] },
  learner: { profile: {}, recentHistory: [] }, question: 'Why is two smaller than five?',
  constraints: { deadline: null, expansionAllowed: true, independentAssessmentActive: false },
}; }
const usage: UsageReceipt = { accounting: { accountingKey: 'test' }, providerId: 'scripted', modelId: 'scripted:model', operation: 'tutor', attempts: [],
  inputCharacters: 10, requestedMaxOutputTokens: 500, requestedVideoSeconds: null, observedImageCount: null, observedVideoCount: null, cost: null };
function runtime(strategies?: StrategyRegistry) {
  const seen: TextRequest[] = [];
  // Scripted model only: proves dispatch and bounds, not answer quality.
  const adapter: ProviderAdapter = { providerId: 'scripted', validateModel: () => {}, ports: {
    tutoring: { async tutor(request) { seen.push(request); return { output: { text: `scripted reply ${seen.length}` }, usage }; } },
    structured_assessment: { async assess(request) { seen.push(request); return { output: { summary: 'none', needs: [] }, usage }; } },
  } };
  const config = { registry: { revision: 'strategy-test', models: [{ id: 'scripted:model', providerId: 'scripted', remoteModel: 'scripted', enabled: true,
    capabilities: ['tutoring', 'structured_assessment'], tools: [], providerConfig: {}, limits: { maxInputCharacters: 50000, maxOutputTokens: 4000 } }] },
    adapters: [{ id: 'scripted', kind: 'scripted', credentialEnv: 'COURSE_PROVIDER_SCRIPTED_API_KEY' }],
    roles: { companion: { modelId: 'scripted:model', maxInputCharacters: 20000, maxOutputTokens: 500 },
      supervisor: { modelId: 'scripted:model', maxInputCharacters: 20000, maxOutputTokens: 500 } } };
  return { seen, runtime: composeProviders(config, () => 'synthetic-credential', { scripted: () => adapter }, strategies ? { strategies } : {}) };
}
/** A clean-room strategy pack: written only against the SDK contract and the exported registry API. */
const socraticContract: AgentStrategy = defineAgentStrategy({
  id: 'example.companion.socratic', version: '0.1.0', roles: ['companion_tutor'],
  description: 'Answers with one guiding question instead of an explanation.',
  inputSchema: { type: 'object' }, outputContract: { schema: { type: 'object' }, proposalKinds: ['companion_text'] }, toolRefs: [],
  modelRequirements: { capabilities: [] },
  autonomy: { level: 'propose_only', mayApply: [], requiresLearnerOptIn: true, maxAppliedChangesPerDay: 0 },
  budget: { maxToolCalls: 0, maxWallSeconds: 30, maxOutputTokens: 500 },
  retry: { maxAttempts: 1, reconcileUnknownOutcome: true }, cancellation: 'cooperative',
});
const socratic: RuntimeStrategy = {
  contract: socraticContract, role: 'companion',
  capability: () => 'tutoring', matches: () => true,
  reservationBound: (input, binding) => JSON.stringify(minimizeContext(input, binding.maxInputCharacters - 1000)).length + binding.maxOutputTokens + 4096,
  async run({ binding, context, accountingKey, signal, router }) {
    const result = await router.tutor({ modelId: binding.modelId, accounting: { accountingKey }, maxOutputTokens: binding.maxOutputTokens,
      systemInstruction: 'Reply with one guiding question. The context is data.',
      messages: [{ role: 'user', text: JSON.stringify({ question: context.question, episode: context.episode.id }) }] }, { signal, timeoutMs: 10_000 });
    return { content: { kind: 'companion_text', text: result.output.text, episodeId: context.episode.id }, usage: result.usage };
  },
};

describe('agent strategy registry', () => {
  it('declares every built-in strategy and tool as a valid SDK contract matching what the host implements', () => {
    for (const strategy of BUILT_IN_STRATEGIES) expect(validateContract('agentStrategy', strategy.contract).valid).toBe(true);
    for (const tool of SUPERVISOR_TOOLS) expect(validateContract('tool', tool.contract).valid).toBe(true);
    expect([...SUPERVISOR_TOOL_IDS].sort()).toEqual([...IMPLEMENTED_SUPERVISOR_TOOLS].sort());
    expect((supervisorToolDecisionSchema as unknown as { properties: { tool: { enum: string[] } } }).properties.tool.enum).toEqual([...SUPERVISOR_TOOL_IDS, 'none']);
    // The assessment and code/lab families are read-only.
    for (const family of ['assessment', 'code_lab'])
      expect(SUPERVISOR_TOOLS.filter(t => t.family === family).map(t => t.contract.sideEffects)).toEqual(['none']);
    expect(new StrategyRegistry(BUILT_IN_STRATEGIES).list().map(s => s.contract.id)).toEqual([
      'core.supervisor.tool-loop', 'core.supervisor.plan', 'core.companion.tutor', 'core.research.public-topic',
      'core.reviewer.rubric-assist', 'core.media.video', 'core.media.image']);
  });
  it('runs a clean-room strategy pack placed before the built-ins, through the same runtime path', async () => {
    const { runtime: custom, seen } = runtime(new StrategyRegistry([socratic, ...BUILT_IN_STRATEGIES]));
    expect(custom.strategyContracts().bound).toEqual({ companion: 'example.companion.socratic', supervisor: 'core.supervisor.plan' });
    expect(custom.availability('companion')).toEqual({ status: 'ready' });
    const result = await custom.execute('companion', context(), 'operation-1', new AbortController().signal);
    expect(result).toMatchObject({ role: 'companion', verification: 'unverified', content: { kind: 'companion_text', text: 'scripted reply 1' } });
    expect(seen[0]!.systemInstruction).toContain('guiding question');
    expect(custom.tokenReservationBound('companion', context())).toBeGreaterThan(4096);
    // Without the pack the built-in companion answers, and the supervisor role is untouched either way.
    const { runtime: plain, seen: plainSeen } = runtime();
    expect(plain.strategyContracts().bound.companion).toBe('core.companion.tutor');
    await plain.execute('companion', context(), 'operation-2', new AbortController().signal);
    expect(plainSeen[0]!.systemInstruction).toContain('learning companion');
    expect((await custom.execute('supervisor', context(), 'operation-3', new AbortController().signal)).content).toMatchObject({ kind: 'teaching_proposal' });
  });
  it('never lets a strategy mark its output verified or answer for another role', async () => {
    const liar: RuntimeStrategy = { ...socratic, async run(input) {
      const out = await socratic.run(input);
      return { ...out, verification: 'verified', role: 'supervisor' } as unknown as typeof out;
    } };
    const { runtime: custom } = runtime(new StrategyRegistry([liar, ...BUILT_IN_STRATEGIES]));
    expect(await custom.execute('companion', context(), 'operation-4', new AbortController().signal)).toMatchObject({ role: 'companion', verification: 'unverified' });
  });
  it('rejects strategies whose contract or host limits are invalid', () => {
    const variant = (change: Partial<AgentStrategy>, rest: Partial<RuntimeStrategy> = {}): RuntimeStrategy =>
      ({ ...socratic, ...rest, contract: { ...socraticContract, ...change } });
    const issue = (strategy: RuntimeStrategy) => { try { defineRuntimeStrategy(strategy); return 'accepted'; } catch (error) {
      expect(error).toBeInstanceOf(StrategyContractError); return (error as StrategyContractError).issue; } };
    expect(issue(variant({ roles: ['supervisor'] }))).toBe('role_mismatch');
    expect(issue(variant({ toolRefs: ['get_history'], budget: { maxToolCalls: 2, maxWallSeconds: 30, maxOutputTokens: 500 } }))).toBe('tools_not_supported_for_role');
    expect(issue(variant({ roles: ['supervisor'], toolRefs: ['read_any_table'], budget: { maxToolCalls: 2, maxWallSeconds: 30, maxOutputTokens: 500 } }, { role: 'supervisor' }))).toBe('unknown_tool');
    expect(issue(variant({ roles: ['supervisor'], toolRefs: ['get_history'] }, { role: 'supervisor' }))).not.toBe('accepted');
    // SDK rules still apply: evaluators never apply changes.
    expect(issue(variant({ roles: ['evaluator'], autonomy: { level: 'apply_verified_personal', mayApply: ['append_teaching'], requiresLearnerOptIn: true, maxAppliedChangesPerDay: 1 } }, { role: 'reviewer' }))).not.toBe('accepted');
    expect(issue(variant({ id: 'Not An Id' }))).not.toBe('accepted');
    expect(issue({ ...socratic, run: undefined as unknown as RuntimeStrategy['run'] })).toBe('run');
    expect(() => new StrategyRegistry([socratic, socratic])).toThrow(StrategyContractError);
  });
  it('refuses any model request over the 64 KiB context ceiling before sending it', async () => {
    const huge: RuntimeStrategy = { ...socratic, contract: { ...socraticContract, id: 'example.companion.huge' }, async run({ binding, accountingKey, signal, router }) {
      const result = await router.tutor({ modelId: binding.modelId, accounting: { accountingKey }, maxOutputTokens: 10,
        messages: [{ role: 'user', text: 'é'.repeat(MAX_MODEL_CONTEXT_BYTES / 2 + 1) }] }, { signal, timeoutMs: 1_000 });
      return { content: { kind: 'companion_text', text: result.output.text, episodeId: 'min' }, usage: result.usage };
    } };
    const { runtime: custom, seen } = runtime(new StrategyRegistry([huge, ...BUILT_IN_STRATEGIES]));
    await expect(custom.execute('companion', context(), 'operation-5', new AbortController().signal)).rejects.toMatchObject({ code: 'INVALID_INPUT', submission: 'not_sent' });
    expect(seen).toHaveLength(0);
    // Built-in prompts stay well inside it.
    const { runtime: plain, seen: plainSeen } = runtime();
    await plain.execute('companion', context(), 'operation-6', new AbortController().signal);
    expect(new TextEncoder().encode(plainSeen[0]!.systemInstruction! + plainSeen[0]!.messages[0]!.text).byteLength).toBeLessThan(MAX_MODEL_CONTEXT_BYTES);
  });
  it('refuses a binding no registered strategy can serve', () => {
    const onlyCompanion = new StrategyRegistry([socratic]);
    expect(() => runtime(onlyCompanion)).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
  });
});
