import { z } from 'zod';
import { callOptionsSchema, id, modelId, videoJobSchema, type AccountingInput, type CallOptions, type CapabilityPorts,
  type ModelConfig, type ProviderAdapter, type ProviderResult, type UsageReceipt, type VideoJob } from './contracts.js';
import { ensure, ProviderError, safeError, type ErrorCode } from './errors.js';
import { parse } from './validation.js';

const instant = z.string().datetime({ offset: true });
export const subscriptionStatusSchema = z.strictObject({
  providerId: id, subscriptionRef: id, entitlementRevision: id,
  state: z.enum(['active', 'expired', 'revoked', 'sign_in_required', 'quota_exhausted', 'unavailable']),
  observedAt: instant, expiresAt: instant.nullable(),
  quotas: z.array(z.strictObject({ id, unit: z.enum(['requests', 'tokens', 'images', 'video_seconds', 'credits']),
    remaining: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(), resetsAt: instant.nullable() })).max(32),
});
export type SubscriptionStatus = z.infer<typeof subscriptionStatusSchema>;
export const subscriptionAuthorizationSchema = z.strictObject({
  providerId: id, subscriptionRef: id, entitlementRevision: id, accountingKey: id, modelId,
  operation: z.enum(['tutor', 'assess', 'research', 'image', 'video_submit', 'video_poll', 'video_cancel']),
  disposition: z.enum(['included', 'overage_required', 'denied']), validUntil: instant,
});
export type SubscriptionAuthorization = z.infer<typeof subscriptionAuthorizationSchema>;
export interface SubscriptionCall {
  providerId: string; subscriptionRef: string; entitlementRevision: string;
  operation: SubscriptionAuthorization['operation']; modelId: string; accounting: AccountingInput;
  /** Provider implementation must enforce this at the remote billing boundary. */
  overageAllowed: false;
  job?: VideoJob;
}
export interface SubscriptionFallbackCall {
  providerId: string; subscriptionRef: string; modelId: string; accounting: AccountingInput;
  operation: SubscriptionAuthorization['operation']; reason: ErrorCode | 'EXISTING_FALLBACK_JOB';
  job?: VideoJob;
}
export interface SubscriptionFallbackAuthorization {
  authorizationId: string; providerId: string; subscriptionRef: string; modelId: string;
  accountingKey: string; operation: SubscriptionAuthorization['operation']; approved: boolean; validUntil: string;
}
const fallbackAuthorizationSchema = subscriptionAuthorizationSchema.omit({ entitlementRevision: true, disposition: true })
  .extend({ authorizationId: id, approved: z.boolean() });
export type SubscriptionFallback = { enabled: false } | {
  enabled: true;
  /** Same logical provider/model IDs; the connector owns its native paid protocol. */
  adapter: ProviderAdapter;
  /** Fresh host consent/budget reservation, never model-provided permission. */
  authorize(call: SubscriptionFallbackCall, options: CallOptions): Promise<SubscriptionFallbackAuthorization>;
};
export interface SubscriptionAdapterOptions {
  adapter: ProviderAdapter;
  /** Non-secret, host-bound connection reference. Never an OAuth/access token. */
  subscriptionRef: string;
  applicationAccess: { supported: true; documentationUrl: string; reviewedAt: string };
  isConfigured(): boolean;
  getStatus(options: CallOptions): Promise<SubscriptionStatus>;
  /** Provider-specific atomic admission; enforce quota/idempotency and included-only
   * execution. A cached remaining count is not permission for a concurrent call. */
  authorize(call: SubscriptionCall, options: CallOptions): Promise<SubscriptionAuthorization>;
  now?: () => number;
  maxStatusAgeMs?: number;
  automaticFallback?: SubscriptionFallback;
}

/** Generic server boundary for documented subscription application access.
 * No login, token extraction, native protocol or inferred permission to spend. */
export class SubscriptionAdapter implements ProviderAdapter {
  readonly providerId: string;
  readonly ports: Partial<CapabilityPorts>;
  readonly access: NonNullable<ProviderAdapter['access']>;
  readonly applicationAccess: Readonly<SubscriptionAdapterOptions['applicationAccess']>;
  #options: SubscriptionAdapterOptions;
  constructor(input: SubscriptionAdapterOptions) {
    ensure(typeof process !== 'undefined' && !!process.versions?.node, 'SERVER_ONLY');
    ensure(input && typeof input.adapter?.validateModel === 'function' && typeof input.isConfigured === 'function'
      && typeof input.getStatus === 'function' && typeof input.authorize === 'function', 'INVALID_CONFIG');
    this.providerId = parse(id, input.adapter.providerId, 'INVALID_CONFIG');
    const ref = parse(id, input.subscriptionRef, 'INVALID_CONFIG');
    const approval = parse(z.strictObject({ supported: z.literal(true), documentationUrl: z.string().url().max(2048), reviewedAt: instant }), input.applicationAccess, 'INVALID_CONFIG');
    const url = new URL(approval.documentationUrl);
    ensure(url.protocol === 'https:' && !url.username && !url.password && !url.hash, 'INVALID_CONFIG');
    const maxStatusAgeMs = input.maxStatusAgeMs ?? 60_000;
    ensure(Number.isSafeInteger(maxStatusAgeMs) && maxStatusAgeMs >= 1 && maxStatusAgeMs <= 300_000, 'INVALID_CONFIG');
    this.#options = { ...input, maxStatusAgeMs, automaticFallback: input.automaticFallback?.enabled ? { ...input.automaticFallback } : { enabled: false } };
    if (input.automaticFallback?.enabled) ensure(input.automaticFallback.adapter.providerId === this.providerId
      && typeof input.automaticFallback.authorize === 'function', 'INVALID_CONFIG');
    this.applicationAccess = Object.freeze(approval);
    const readiness = input.isConfigured;
    this.access = Object.freeze({ kind: 'subscription', subscriptionRef: ref, automaticFallbackEnabled: input.automaticFallback?.enabled === true,
      isConfigured: () => { try { return readiness() === true; } catch { return false; } } });
    const ports: Partial<CapabilityPorts> = {};
    const methods = { tutoring: { tutor: 'tutor' }, structured_assessment: { assess: 'assess' }, research: { research: 'research' },
      image: { startImage: 'image' }, video: { startVideo: 'video_submit', pollVideo: 'video_poll', cancelVideo: 'video_cancel' } } as const;
    for (const [capability, port] of Object.entries(input.adapter.ports)) {
      ensure(Object.hasOwn(methods, capability) && port && typeof port === 'object', 'INVALID_CONFIG');
      const wrapped: Record<string, unknown> = {};
      for (const [name, operation] of Object.entries(methods[capability as keyof typeof methods])) {
        const native = (port as unknown as Record<string, unknown>)[name];
        if (name === 'cancelVideo' && native === undefined) continue;
        ensure(typeof native === 'function', 'INVALID_CONFIG');
        const invoke = native.bind(port);
        const fallbackNative = input.automaticFallback?.enabled
          ? (input.automaticFallback.adapter.ports[capability as keyof CapabilityPorts] as unknown as Record<string, unknown> | undefined)?.[name] : undefined;
        wrapped[name] = (request: { modelId: string; accounting: AccountingInput }, options: CallOptions = {}) => this.#run(operation, request, options, invoke,
          typeof fallbackNative === 'function' ? fallbackNative.bind(input.automaticFallback?.enabled ? input.automaticFallback.adapter.ports[capability as keyof CapabilityPorts] : undefined) : undefined);
      }
      // Declarations make no provider call and spend nothing, so they come from the subscription adapter as is.
      if (capability === 'image' || capability === 'video') for (const name of ['discoverCapabilities', 'estimateCost']) {
        const native = (port as unknown as Record<string, unknown>)[name];
        ensure(typeof native === 'function', 'INVALID_CONFIG'); wrapped[name] = native.bind(port);
      }
      Object.assign(ports, { [capability]: Object.freeze(wrapped) });
    }
    this.ports = Object.freeze(ports);
  }
  validateModel(model: ModelConfig): void {
    ensure(model.providerId === this.providerId, 'INVALID_CONFIG');
    const result: unknown = this.#options.adapter.validateModel(model);
    if (result instanceof Promise) void result.catch(() => {});
    ensure(result === undefined, 'INVALID_CONFIG');
    if (this.#options.automaticFallback?.enabled) {
      ensure(model.capabilities.every(capability => this.#options.automaticFallback?.enabled && this.#options.automaticFallback.adapter.ports[capability]), 'INVALID_CONFIG');
      const fallbackResult: unknown = this.#options.automaticFallback.adapter.validateModel(structuredClone(model));
      if (fallbackResult instanceof Promise) void fallbackResult.catch(() => {});
      ensure(fallbackResult === undefined, 'INVALID_CONFIG');
    }
  }
  #now() { const now = (this.#options.now ?? Date.now)(); ensure(Number.isFinite(now), 'INVALID_CONFIG'); return now; }
  #status(raw: unknown): SubscriptionStatus {
    const status = parse(subscriptionStatusSchema, raw, 'INVALID_RESPONSE'), now = this.#now();
    ensure(status.providerId === this.providerId && status.subscriptionRef === this.access.subscriptionRef, 'INVALID_RESPONSE');
    const age = now - Date.parse(status.observedAt);
    ensure(age >= 0 && age <= this.#options.maxStatusAgeMs!, 'INVALID_RESPONSE');
    ensure(new Set(status.quotas.map(q => q.id)).size === status.quotas.length, 'INVALID_RESPONSE');
    return structuredClone(status);
  }
  async status(options: CallOptions = {}): Promise<SubscriptionStatus> {
    try { return await this.#bounded(options, async call => this.#status(await this.#options.getStatus(call)), false); }
    catch (error) { const original = safeError(error); throw new ProviderError(original.code, { submission: 'not_sent' }); }
  }
  #result<T>(result: ProviderResult<T>, request: { modelId: string; accounting: AccountingInput }, operation: SubscriptionAuthorization['operation'], access: NonNullable<UsageReceipt['access']>): ProviderResult<T> {
    const usage = result.usage;
    ensure(usage.providerId === this.providerId && usage.modelId === request.modelId && usage.accounting.accountingKey === request.accounting.accountingKey
      && usage.operation === (operation === 'video_cancel' ? 'video_poll' : operation), 'INVALID_RESPONSE');
    let output = result.output;
    if (operation.startsWith('video_')) {
      const body = output as unknown as { job: VideoJob };
      const job = parse(videoJobSchema, body.job, 'INVALID_RESPONSE');
      ensure(job.providerId === this.providerId && job.modelId === request.modelId && job.accounting.accountingKey === request.accounting.accountingKey, 'INVALID_RESPONSE');
      output = { ...body, job: { ...job, accessRoute: { kind: 'subscription_adapter', subscriptionRef: this.access.subscriptionRef,
        route: access.kind === 'subscription' ? 'subscription' : 'fallback' } } } as T;
    }
    return { output, usage: { ...structuredClone(usage), access } };
  }
  async #bounded<T>(options: CallOptions, run: (call: CallOptions) => Promise<T>, sent: boolean | (() => boolean)): Promise<T> {
    const call = parse(callOptionsSchema, options), controller = new AbortController(); let timedOut = false;
    const forward = () => controller.abort();
    if (call.signal?.aborted) forward(); else call.signal?.addEventListener('abort', forward, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, call.timeoutMs ?? 60_000);
    let listener = () => {};
    const error = () => new ProviderError(timedOut ? 'TIMEOUT' : 'CANCELLED', { submission: (typeof sent === 'function' ? sent() : sent) ? 'unknown' : 'not_sent' });
    try {
      if (controller.signal.aborted) throw error();
      const abort = new Promise<never>((_, reject) => { listener = () => reject(error()); controller.signal.addEventListener('abort', listener, { once: true }); });
      return await Promise.race([Promise.resolve().then(() => { if (controller.signal.aborted) throw error(); return run({ signal: controller.signal, timeoutMs: call.timeoutMs ?? 60_000 }); }), abort]);
    } finally { clearTimeout(timer); call.signal?.removeEventListener('abort', forward); controller.signal.removeEventListener('abort', listener); }
  }
  async #run<T>(operation: SubscriptionAuthorization['operation'], request: { modelId: string; accounting: AccountingInput }, options: CallOptions,
    invoke: (request: unknown, options: CallOptions) => Promise<ProviderResult<T>>,
    fallbackInvoke?: (request: unknown, options: CallOptions) => Promise<ProviderResult<T>>): Promise<ProviderResult<T>> {
    const startedAt = Date.now();
    let sent = false, access: UsageReceipt['access'], job: VideoJob | undefined, fallbackJob = false;
    if (operation === 'video_poll' || operation === 'video_cancel') {
      const routed = parse(videoJobSchema, request);
      ensure(routed.accessRoute?.subscriptionRef === this.access.subscriptionRef, 'INVALID_INPUT');
      fallbackJob = routed.accessRoute.route === 'fallback';
      const { accessRoute: _route, ...native } = routed; job = native; request = native;
    }
    try {
      return await this.#bounded(options, async call => {
        if (fallbackJob) throw new ProviderError('SUBSCRIPTION_QUOTA_EXHAUSTED');
        ensure(this.access.isConfigured(), 'MISSING_CREDENTIAL');
        const status = this.#status(await this.#options.getStatus(call));
        if (status.state === 'expired' || status.expiresAt !== null && Date.parse(status.expiresAt) <= this.#now()) throw new ProviderError('SUBSCRIPTION_EXPIRED');
        if (status.state === 'quota_exhausted') throw new ProviderError('SUBSCRIPTION_QUOTA_EXHAUSTED');
        ensure(status.state === 'active', status.state === 'unavailable' ? 'UPSTREAM_UNAVAILABLE' : 'AUTHENTICATION');
        const grant = parse(subscriptionAuthorizationSchema, await this.#options.authorize({ providerId: this.providerId, subscriptionRef: this.access.subscriptionRef,
          entitlementRevision: status.entitlementRevision, modelId: request.modelId, accounting: structuredClone(request.accounting), operation, overageAllowed: false,
          ...(job ? { job: structuredClone(job) } : {}) }, call), 'INVALID_RESPONSE');
        ensure(grant.providerId === this.providerId && grant.subscriptionRef === status.subscriptionRef && grant.entitlementRevision === status.entitlementRevision
          && grant.accountingKey === request.accounting.accountingKey && grant.modelId === request.modelId && grant.operation === operation && Date.parse(grant.validUntil) > this.#now(), 'INVALID_RESPONSE');
        if (grant.disposition === 'overage_required') throw new ProviderError('SUBSCRIPTION_OVERAGE_REQUIRED');
        ensure(grant.disposition === 'included', 'PERMISSION_DENIED');
        ensure(!call.signal?.aborted, 'CANCELLED');
        access = { kind: 'subscription', subscriptionRef: status.subscriptionRef, entitlementRevision: status.entitlementRevision, overageAllowed: false };
        sent = true;
        return this.#result(await invoke(structuredClone(request), call), request, operation, access);
      }, () => sent);
    } catch (raw) {
      const original = safeError(raw), safe = new ProviderError(original.code, { ...(original.status === null ? {} : { status: original.status }),
        ...(original.retryAfterMs === null ? {} : { retryAfterMs: original.retryAfterMs }), submission: sent && original.submission === 'not_sent' ? 'unknown' : original.submission });
      if (original.usage) safe.usage = { ...structuredClone(original.usage), ...(access ? { access } : {}) };
      if (original.job) safe.job = structuredClone(original.job);
      if (original.pollUsage) safe.pollUsage = structuredClone(original.pollUsage);
      // Only failed admission can change routes. Unknown submitted work, output
      // validation failures and cancellation never replay. Persisted video jobs
      // remain on their original route even if the subscription later recovers.
      const eligible = ['MISSING_CREDENTIAL', 'AUTHENTICATION', 'SUBSCRIPTION_EXPIRED', 'SUBSCRIPTION_QUOTA_EXHAUSTED', 'SUBSCRIPTION_OVERAGE_REQUIRED', 'UPSTREAM_UNAVAILABLE'].includes(safe.code);
      const fallback = this.#options.automaticFallback;
      if (!sent && eligible && fallback?.enabled && fallbackInvoke && (!job || fallbackJob)) {
        const remaining = (options.timeoutMs ?? 60_000) - (Date.now() - startedAt);
        if (remaining <= 0) throw new ProviderError('TIMEOUT');
        let fallbackSent = false;
        try { return await this.#bounded({ ...options, timeoutMs: remaining }, async call => {
          const grant = parse(fallbackAuthorizationSchema, await fallback.authorize({ providerId: this.providerId, subscriptionRef: this.access.subscriptionRef,
            modelId: request.modelId, accounting: structuredClone(request.accounting), operation, reason: fallbackJob ? 'EXISTING_FALLBACK_JOB' : safe.code,
            ...(job ? { job: structuredClone(job) } : {}) }, call), 'INVALID_RESPONSE');
          ensure(grant.providerId === this.providerId && grant.subscriptionRef === this.access.subscriptionRef && grant.modelId === request.modelId
            && grant.accountingKey === request.accounting.accountingKey && grant.operation === operation && Date.parse(grant.validUntil) > this.#now(), 'INVALID_RESPONSE');
          ensure(grant.approved, 'PERMISSION_DENIED'); ensure(!call.signal?.aborted, 'CANCELLED');
          try {
            fallbackSent = true;
            return this.#result(await fallbackInvoke(structuredClone(request), call), request, operation, { kind: 'api_key_fallback', subscriptionRef: this.access.subscriptionRef,
              authorizationId: grant.authorizationId, reason: fallbackJob ? 'EXISTING_FALLBACK_JOB' : safe.code });
          } catch (failure) {
            const original = safeError(failure), error = new ProviderError(original.code, { submission: fallbackSent && original.submission === 'not_sent' ? 'unknown' : original.submission });
            if (original.usage) error.usage = { ...structuredClone(original.usage), access: { kind: 'api_key_fallback', subscriptionRef: this.access.subscriptionRef,
              authorizationId: grant.authorizationId, reason: fallbackJob ? 'EXISTING_FALLBACK_JOB' : safe.code } };
            throw error;
          }
        }, () => fallbackSent); } catch (failure) {
          const original = safeError(failure), error = new ProviderError(original.code, { ...(original.status === null ? {} : { status: original.status }),
            ...(original.retryAfterMs === null ? {} : { retryAfterMs: original.retryAfterMs }),
            submission: fallbackSent && original.submission === 'not_sent' ? 'unknown' : original.submission });
          if (original.usage) error.usage = structuredClone(original.usage);
          if (original.job) error.job = structuredClone(original.job);
          throw error;
        }
      }
      throw safe;
    }
  }
}
export function subscriptionAdapter(options: SubscriptionAdapterOptions): SubscriptionAdapter { return new SubscriptionAdapter(options); }
