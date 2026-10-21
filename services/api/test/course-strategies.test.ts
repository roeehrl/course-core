import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { defineAgentStrategy, type AgentStrategy } from '@course-core/sdk';
import { supervisorTool } from '../src/supervisor-tool-catalog.js';
import type { ProviderAdapter, StructuredRequest, UsageReceipt } from '@course-core/providers';
import { composeProviders } from '../src/provider-composition.js';
import { bindCourseStrategies, courseStrategyProblems } from '../src/course-strategies.js';
import type { TeachingContext } from '../src/agent-strategies.js';
import type { SupervisorToolPort } from '../src/supervisor-tool-loop.js';
import { verifyCoursePackage } from '../src/course-package.js';
import { buildPackage } from './course-package-fixture.js';
import { fixture } from './fixture.js';

/** Clean-room declarations written only against the SDK 0.5 contract (requirement B08). */
const declared = (change: Partial<AgentStrategy> = {}): AgentStrategy => ({
  id: 'example.supervisor.read-first', version: '1.0.0', roles: ['supervisor'], description: 'Reads the learner record and hypotheses only, then proposes.',
  inputSchema: { type: 'object' }, outputContract: { schema: { type: 'object' }, proposalKinds: ['supervised_plan'] },
  toolRefs: ['get_profile', 'list_hypotheses', 'propose_practice_check'], modelRequirements: { capabilities: ['structured_output'] },
  autonomy: { level: 'propose_only', mayApply: [], requiresLearnerOptIn: true, maxAppliedChangesPerDay: 0 },
  budget: { maxToolCalls: 3, maxWallSeconds: 120, maxOutputTokens: 800 },
  retry: { maxAttempts: 2, reconcileUnknownOutcome: true }, cancellation: 'cooperative', ...change,
});
const companion = (change: Partial<AgentStrategy> = {}): AgentStrategy => ({
  ...declared(), id: 'example.companion.brief', roles: ['companion_tutor'], toolRefs: [], description: 'Short answers.',
  outputContract: { schema: { type: 'object' }, proposalKinds: ['companion_text'] }, modelRequirements: { capabilities: [] },
  budget: { maxToolCalls: 0, maxWallSeconds: 30, maxOutputTokens: 120 }, ...change,
});
/** The SDK makes toolRefs name tools the course declares: here, Core's own catalog contracts. */
const tools = ['get_profile', 'list_hypotheses', 'propose_practice_check'].map(id => supervisorTool(id)!.contract);
const bundle = (strategies: unknown[]) => ({ agentStrategies: strategies, tools });
const codes = (strategies: unknown[]) => courseStrategyProblems(bundle(strategies)).map(p => p.code);

describe('course-declared agent strategies narrow Core\'s own (B08)', () => {
  it('binds declarations that only narrow, and reports every way one could widen authority', () => {
    // The SDK accepts both declarations as contracts; Core accepts them as narrowing its own.
    expect(() => defineAgentStrategy(declared())).not.toThrow();
    expect(codes([declared(), companion()])).toEqual([]);
    expect(bindCourseStrategies(bundle([declared(), companion()])).map(s => [s.role, s.contract.id])).toEqual([
      ['supervisor', 'example.supervisor.read-first'], ['companion', 'example.companion.brief']]);
    expect(codes([declared({ toolRefs: ['get_profile', 'read_any_table'] })])).toEqual(['STRATEGY_TOOL_NOT_IN_CATALOG', 'STRATEGY_TOOL_NOT_DECLARED']);
    // A course's own declaration of a catalog tool cannot claim more than Core's contract does.
    expect(courseStrategyProblems({ agentStrategies: [declared()], tools: tools.map(t => t.id === 'get_profile' ? { ...t, sideEffects: 'artifact_write' } : t) }).map(p => p.code))
      .toEqual(['STRATEGY_TOOL_CONTRACT_MISMATCH']);
    expect(codes([declared({ budget: { maxToolCalls: 30, maxWallSeconds: 120, maxOutputTokens: 800 } })])).toEqual(['STRATEGY_BUDGET_WIDENS']);
    expect(codes([declared({ retry: { maxAttempts: 5, reconcileUnknownOutcome: true } })])).toEqual(['STRATEGY_RETRY_WIDENS']);
    expect(codes([declared({ autonomy: { level: 'apply_verified_personal', mayApply: ['append_teaching'], requiresLearnerOptIn: true, maxAppliedChangesPerDay: 50 } })])).toEqual(['STRATEGY_AUTONOMY_WIDENS']);
    expect(codes([declared({ outputContract: { schema: { type: 'object' }, proposalKinds: ['grade'] } })])).toEqual(['STRATEGY_PROPOSAL_WIDENS']);
    expect(codes([declared({ id: 'core.supervisor.mine' })])).toEqual(['STRATEGY_ID_RESERVED']);
    expect(codes([declared({ roles: ['verifier'] })])).toEqual(['STRATEGY_ROLE_UNSUPPORTED']);
    expect(codes([companion({ toolRefs: ['get_profile'], budget: { maxToolCalls: 1, maxWallSeconds: 30, maxOutputTokens: 120 } })])).toEqual(['STRATEGY_TOOLS_NOT_SUPPORTED_FOR_ROLE']);
    expect(codes([declared(), declared({ id: 'example.supervisor.second' })])).toEqual(['STRATEGY_ROLE_TAKEN']);
    expect(codes([{ id: 'not a contract' }])).toEqual(['STRATEGY_CONTRACT_INVALID']);
    expect(codes(Array.from({ length: 17 }, () => companion()))).toEqual(['STRATEGY_LIST_INVALID']);
    // Any problem: nothing from the release is bound, and Core's own strategies run.
    expect(bindCourseStrategies(bundle([declared(), declared({ id: 'core.bad' })]))).toEqual([]);
  });

  it('refuses a course package whose declaration widens authority, and accepts one that narrows', async () => {
    const narrow = { ...fixture(), tools, agentStrategies: [declared()] } as ReturnType<typeof fixture>;
    expect((await verifyCoursePackage(buildPackage(narrow).bytes)).compiled.server).toMatchObject({ agentStrategies: [expect.objectContaining({ id: 'example.supervisor.read-first' })] });
    const wide = { ...fixture(), tools, agentStrategies: [declared({ budget: { maxToolCalls: 30, maxWallSeconds: 120, maxOutputTokens: 800 } })] } as ReturnType<typeof fixture>;
    await expect(verifyCoursePackage(buildPackage(wide).bytes)).rejects.toMatchObject({ code: 'PACKAGE_AGENT_STRATEGY_REFUSED',
      details: { problems: [{ strategyId: 'example.supervisor.read-first', code: 'STRATEGY_BUDGET_WIDENS' }] } });
  });

  it('runs a bound declaration through the same runtime path: fewer tools, fewer rounds, a capped output, and propose-only output refused', async () => {
    const seen: StructuredRequest[] = [];
    let script: (round: number) => unknown = () => ({ decision: 'finish', tool: 'none', argumentsJson: '{}', summary: 'Done.' });
    const usage: UsageReceipt = { accounting: { accountingKey: 'test' }, providerId: 'scripted', modelId: 'scripted:model', operation: 'assess',
      attempts: [{ attempt: 1, status: 200, outcome: 'response', tokens: { input: 1, output: 1, total: 2, cachedInput: 0, thoughts: 0, toolInput: 0 } }],
      inputCharacters: 10, requestedMaxOutputTokens: 500, requestedVideoSeconds: null, observedImageCount: null, observedVideoCount: null, cost: null };
    // Scripted model only: proves dispatch and bounds, never answer quality.
    const adapter: ProviderAdapter = { providerId: 'scripted', validateModel: () => {}, ports: {
      structured_assessment: { async assess(request) { seen.push(request); return { output: script(seen.length - 1) as never, usage }; } },
      tutoring: { async tutor(request) { seen.push(request as never); return { output: { text: 'short' }, usage }; } },
    } };
    const runtime = composeProviders({ registry: { revision: 'course-strategies', models: [{ id: 'scripted:model', providerId: 'scripted', remoteModel: 'scripted', enabled: true,
      capabilities: ['tutoring', 'structured_assessment'], tools: [], providerConfig: {}, limits: { maxInputCharacters: 50000, maxOutputTokens: 4000 } }] },
      adapters: [{ id: 'scripted', kind: 'scripted', credentialEnv: 'COURSE_PROVIDER_SCRIPTED_API_KEY' }],
      roles: { supervisor: { modelId: 'scripted:model', maxInputCharacters: 30000, maxOutputTokens: 500, maxToolRounds: 8 },
        companion: { modelId: 'scripted:model', maxInputCharacters: 20000, maxOutputTokens: 500 } } }, () => 'synthetic-credential', { scripted: () => adapter });
    const course = bindCourseStrategies(bundle([declared(), companion()]));
    const context: TeachingContext = { course: { title: 'Ordering', digest: 'a'.repeat(64) },
      episode: { id: 'min', title: 'Minimum', teaching: 'The smaller value comes first.', objectives: [{ id: 'minimum', description: 'Find a minimum.' }] },
      learner: { profile: {}, recentHistory: [] }, question: 'Review.', constraints: { deadline: null, expansionAllowed: true, independentAssessmentActive: false } };
    const tools: SupervisorToolPort = { async invoke(name) {
      return name === 'propose_practice_check'
        ? { receiptId: randomUUID(), result: { staged: true }, suggestion: { kind: 'practice_check', objectiveId: 'minimum', assessmentId: 'min-again', episodeId: 'min' } }
        : { receiptId: randomUUID(), result: { ok: true } };
    } };
    expect(runtime.strategyFor('supervisor', course)).toBe('example.supervisor.read-first');
    expect(runtime.strategyFor('supervisor')).toBe('core.supervisor.tool-loop');
    await runtime.execute('supervisor', context, 'op-1', new AbortController().signal, tools, undefined, course);
    expect((seen[0]!.outputSchema as any).properties.tool.enum).toEqual(['get_profile', 'list_hypotheses', 'propose_practice_check', 'none']);
    // Three tool calls and a finish at most, though the binding allows eight rounds.
    seen.length = 0;
    script = () => ({ decision: 'tool', tool: 'get_profile', argumentsJson: '{}', summary: '' });
    const exhausted = await runtime.execute('supervisor', context, 'op-2', new AbortController().signal, tools, undefined, course);
    expect(seen).toHaveLength(4);
    expect(exhausted.content).toEqual({ kind: 'output_refusal', role: 'supervisor', reason: 'tool_loop_round_limit' });
    // propose_only: a plan that would change the learner's teaching is refused, not delivered.
    seen.length = 0;
    script = round => round === 0 ? { decision: 'tool', tool: 'propose_practice_check', argumentsJson: '{"objectiveId":"minimum"}', summary: '' }
      : { decision: 'finish', tool: 'none', argumentsJson: '{}', summary: 'Practice.' };
    expect((await runtime.execute('supervisor', context, 'op-3', new AbortController().signal, tools, undefined, course)).content)
      .toEqual({ kind: 'output_refusal', role: 'supervisor', reason: 'autonomy_exceeded' });
    // The companion declaration caps the output allowance below the binding's.
    seen.length = 0;
    await runtime.execute('companion', context, 'op-4', new AbortController().signal, undefined, undefined, course);
    expect((seen[0] as unknown as { maxOutputTokens: number }).maxOutputTokens).toBe(120);
  });
});
