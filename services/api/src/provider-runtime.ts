import { ModelRegistry, ProviderRouter, ProviderError, type Json, type VideoJob } from '@course-core/providers';
import type { SupervisorToolPort } from './supervisor-tool-loop.js';
import { providerCallObserver } from './telemetry.js';
import { AGENT_ROLES, builtInStrategies, type AgentRole, type RoleBinding, type RoleBindings, type RuntimeResult, type RuntimeStrategy,
  type StrategyRegistry, type TeachingContext } from './agent-strategies.js';

export { AGENT_ROLES, minimizeContext, supervisorPlanSchema, StrategyRegistry, defineRuntimeStrategy, BUILT_IN_STRATEGIES } from './agent-strategies.js';
export type { AgentRole, RoleBinding, RoleBindings, MediaPricing, TeachingContext, RuntimeResult, RuntimeStrategy, StrategyRun } from './agent-strategies.js';

/** Neutral composition target; no vendor protocol, key, endpoint or model-name logic. */
export class ProviderRuntime {
  private readonly router: ProviderRouter;
  private readonly bindings: RoleBindings;
  private readonly strategies: StrategyRegistry;
  constructor(private readonly registry: ModelRegistry, bindings: RoleBindings,
    private readonly configured: (providerId: string) => boolean, strategies: StrategyRegistry = builtInStrategies()) {
    this.router = new ProviderRouter(registry, { observe: providerCallObserver }); this.bindings = structuredClone(bindings);
    this.strategies = strategies;
    for (const [role, binding] of Object.entries(this.bindings)) {
      if (!(AGENT_ROLES as readonly string[]).includes(role) || !binding || !Number.isSafeInteger(binding.maxOutputTokens) || binding.maxOutputTokens < 0 || binding.maxOutputTokens > 16000
        || !Number.isSafeInteger(binding.maxInputCharacters) || binding.maxInputCharacters < 2000 || binding.maxInputCharacters > 100000) throw new ProviderError('INVALID_CONFIG');
      const video = role === 'media' && binding.mediaKind === 'video';
      if (video ? !binding.video || binding.maxOutputTokens !== 0 : binding.video || binding.maxOutputTokens < 1) throw new ProviderError('INVALID_CONFIG');
      if (binding.mediaKind && role !== 'media') throw new ProviderError('INVALID_CONFIG');
      if (binding.pricing && !(role === 'media' && binding.mediaKind === 'video' && Number.isSafeInteger(binding.pricing.microUsdPerOutputSecond) && binding.pricing.microUsdPerOutputSecond > 0)) throw new ProviderError('INVALID_CONFIG');
      if(binding.maxToolRounds!==undefined&&(role!=='supervisor'||!Number.isSafeInteger(binding.maxToolRounds)||binding.maxToolRounds<2||binding.maxToolRounds>8||binding.maxInputCharacters<20000))throw new ProviderError('INVALID_CONFIG');
      const model = registry.list().find(row => row.id === binding.modelId);
      if (!model || binding.maxInputCharacters > model.limits.maxInputCharacters || binding.maxOutputTokens > (model.limits.maxOutputTokens ?? 0)) throw new ProviderError('INVALID_CONFIG');
      const strategy = strategies.select(role as AgentRole, binding);
      if (!strategy) throw new ProviderError('INVALID_CONFIG');
      registry.port(binding.modelId, strategy.capability(binding));
    }
  }
  /** The strategy that runs a role under its current binding: a course-declared strategy bound to
   * the same base (course-strategies.ts) when the job's release has one, else Core's own. */
  private strategy(role: AgentRole, course: readonly RuntimeStrategy[] = []): { binding: RoleBinding; strategy: RuntimeStrategy } | undefined {
    const binding = this.bindings[role];
    const strategy = binding && (course.find(s => s.role === role && s.matches(binding)) ?? this.strategies.select(role, binding));
    return binding && strategy ? { binding, strategy } : undefined;
  }
  /** Which strategy would run a role for a release's declarations (for inspection). */
  strategyFor(role: AgentRole, course: readonly RuntimeStrategy[] = []) { return this.strategy(role, course)?.strategy.contract.id ?? null; }
  /** SDK contracts of the registered strategies and which one each bound role uses. */
  strategyContracts() {
    return { strategies: this.strategies.list(),
      bound: Object.fromEntries(AGENT_ROLES.flatMap(role => { const s = this.strategy(role); return s ? [[role, s.strategy.contract.id]] : []; })) };
  }
  availability(role: AgentRole) {
    const selected = this.strategy(role);
    if (!selected) return { status: 'configuration_missing' as const };
    const model = this.registry.list().find(row => row.id === selected.binding.modelId);
    if (!model || !this.configured(model.providerId)) return { status: 'configuration_missing' as const };
    try { this.registry.port(selected.binding.modelId, selected.strategy.capability(selected.binding)); return { status: 'ready' as const }; }
    catch { return { status: 'capability_missing' as const }; }
  }
  /** Availability of every role, keyed by role (each key always present). */
  status(): Record<AgentRole, ReturnType<ProviderRuntime['availability']>> {
    return { supervisor: this.availability('supervisor'), companion: this.availability('companion'), research: this.availability('research'),
      media: this.availability('media'), reviewer: this.availability('reviewer') };
  }
  /** The model bound to each role and how its calls are priced; never a price itself. */
  roleModels(): Partial<Record<AgentRole, { modelId: string; pricingKind: 'tokens' | 'video' }>> {
    return Object.fromEntries(Object.entries(this.bindings).flatMap(([role, binding]) => binding
      ? [[role, { modelId: binding.modelId, pricingKind: role === 'media' && binding.mediaKind === 'video' ? 'video' as const : 'tokens' as const }]] : []));
  }
  describe() {
    return this.registry.list().map(model => ({ id: model.id, providerId: model.providerId, enabled: model.enabled, capabilities: model.capabilities,
      configuration: this.configured(model.providerId) ? 'configured' : 'absent', verification: 'not_run' }));
  }
  tokenReservationBound(role: AgentRole, context: TeachingContext, course: readonly RuntimeStrategy[] = []) {
    const selected = this.strategy(role, course);
    if (!selected) throw new ProviderError('INVALID_CONFIG');
    return selected.strategy.reservationBound(context, selected.binding);
  }
  async execute(role: AgentRole, context: TeachingContext, accountingKey: string, signal: AbortSignal,tools?:SupervisorToolPort,beforeModelCall?:()=>Promise<void>,
    course: readonly RuntimeStrategy[] = []): Promise<RuntimeResult> {
    if (this.availability(role).status !== 'ready') throw new ProviderError('MISSING_CREDENTIAL');
    const { binding, strategy } = this.strategy(role, course)!;
    const result = await strategy.run({ role, binding, context, accountingKey, signal, router: capped(this.router), tools, beforeModelCall });
    // Whatever a strategy returns, its output stays an unverified proposal of this role.
    return { role, content: result.content, usage: result.usage, verification: 'unverified' };
  }
  /** The request a role's bound strategy would send for `context`, captured before anything is
   * sent (agent evals grade media prompts this way: staff review every media candidate, so the
   * revision is judged on what Core asks for, never on a paid generation). Null when the strategy
   * refused before building a request. */
  async assembledRequest(role: AgentRole, context: TeachingContext, course: readonly RuntimeStrategy[] = []): Promise<Record<string, unknown> | null> {
    const selected = this.strategy(role, course);
    if (!selected) throw new ProviderError('INVALID_CONFIG');
    class Captured extends Error {}
    let captured: Record<string, unknown> | null = null;
    const capture = (operation: string) => async (request: Record<string, unknown>) => {
      const { accounting: _accounting, ...rest } = request;
      captured = { operation, ...rest };
      throw new Captured();
    };
    const router = { tutor: capture('tutor'), assess: capture('assess'), research: capture('research'), startImage: capture('startImage'), startVideo: capture('startVideo') } as unknown as ProviderRouter;
    try { await selected.strategy.run({ role, binding: selected.binding, context, accountingKey: 'assembled-request', signal: new AbortController().signal, router }); }
    catch (error) { if (!(error instanceof Captured)) return null; }
    return captured;
  }
  /** The bound video role, its fixed settings and operator pricing; never a prompt. */
  mediaVideo() {
    const binding = this.bindings.media;
    if (!binding || binding.mediaKind !== 'video' || !binding.video) return undefined;
    return { modelId: binding.modelId, video: structuredClone(binding.video), pricing: binding.pricing ? structuredClone(binding.pricing) : null, availability: this.availability('media').status };
  }
  /** One staff-reviewed script submission. The router never retries an uncertain POST. */
  async submitMediaVideo(prompt: string, accountingKey: string, signal: AbortSignal) {
    const plan = this.mediaVideo();
    if (!plan || plan.availability !== 'ready') throw new ProviderError('MISSING_CREDENTIAL');
    return (await this.router.startVideo({ modelId: plan.modelId, accounting: { accountingKey }, prompt, ...plan.video }, { signal, timeoutMs: 60000 })).output;
  }
  async pollMediaVideo(job: VideoJob, signal: AbortSignal) {
    const plan = this.mediaVideo();
    if (!plan || plan.availability !== 'ready' || plan.modelId !== job.modelId) throw new ProviderError('CAPABILITY_MISMATCH');
    return (await this.router.pollVideo(job, { signal, timeoutMs: 30000 })).output;
  }
  async downloadMediaVideo(job: VideoJob, uri: string, maxBytes: number, signal: AbortSignal) {
    const plan = this.mediaVideo();
    if (!plan || plan.availability !== 'ready' || plan.modelId !== job.modelId) throw new ProviderError('CAPABILITY_MISMATCH');
    return this.router.downloadVideo(job, uri, { maxBytes, signal, timeoutMs: 120000 });
  }
  async pollVideo(job: VideoJob, signal: AbortSignal): Promise<RuntimeResult> {
    if (this.availability('media').status !== 'ready' || this.bindings.media?.modelId !== job.modelId || this.bindings.media.mediaKind !== 'video') throw new ProviderError('CAPABILITY_MISMATCH');
    const result = await this.router.pollVideo(job, { signal, timeoutMs: 30000 });
    return { role: 'media', content: { kind: 'video_candidate', ...result.output } as unknown as Json, usage: result.usage, verification: 'unverified' };
  }
}

/** Hard ceiling on what any strategy sends to a model in one request (design N06): instructions,
 * messages and prompts together, as UTF-8 bytes. Context minimization normally keeps far below it. */
export const MAX_MODEL_CONTEXT_BYTES = 65_536;
const CAPPED_CALLS = new Set(['tutor', 'assess', 'research', 'startImage', 'startVideo']);
function requestBytes(request: { systemInstruction?: string | undefined; messages?: { text: string }[] | undefined; prompt?: string | undefined }) {
  const text = (request.systemInstruction ?? '') + (request.messages ?? []).map(m => m.text).join('') + (request.prompt ?? '');
  return new TextEncoder().encode(text).byteLength;
}
/** The router a strategy receives: every model request over the ceiling is refused before it is sent. */
function capped(router: ProviderRouter): ProviderRouter {
  return new Proxy(router, { get(target, property, receiver) {
    const value = Reflect.get(target, property, receiver);
    if (typeof property !== 'string' || !CAPPED_CALLS.has(property) || typeof value !== 'function') return value;
    return (request: Parameters<ProviderRouter['tutor']>[0], ...rest: unknown[]) => {
      if (requestBytes(request) > MAX_MODEL_CONTEXT_BYTES) throw new ProviderError('INVALID_INPUT', { submission: 'not_sent' });
      return (value as (...args: unknown[]) => unknown).call(target, request, ...rest);
    };
  } });
}
