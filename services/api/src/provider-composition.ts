import { z } from 'zod';
import { ModelRegistry, ProviderError, type ProviderAdapter, type RegistryConfig } from '@course-core/providers';
import { GoogleProvider } from '@course-core/providers/google';
import { AnthropicProvider } from '@course-core/providers/anthropic';
import { AGENT_ROLES, ProviderRuntime, type RoleBindings, type StrategyRegistry } from './provider-runtime.js';

const credentialEnv = z.string().regex(/^(?:GOOGLE_API_KEY|COURSE_PROVIDER_[A-Z0-9_]+_API_KEY)$/);
export const providerConfigurationSchema = z.strictObject({
  registry: z.unknown(),
  adapters: z.array(z.strictObject({ id: z.string().min(1).max(128), kind: z.string().min(1).max(100), credentialEnv: credentialEnv.optional(),
    subscriptionRef: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/).optional(),
    automaticFallback: z.strictObject({ enabled: z.boolean(), credentialEnv: credentialEnv.optional() }).optional(),
  }).refine(a => (a.credentialEnv === undefined) !== (a.subscriptionRef === undefined)
    && (!a.automaticFallback || a.subscriptionRef !== undefined)
    && (!a.automaticFallback?.enabled || a.automaticFallback.credentialEnv !== undefined))).max(20),
  roles: z.partialRecord(z.enum(AGENT_ROLES), z.strictObject({ modelId: z.string().min(1).max(2048), maxInputCharacters: z.number().int().min(2000).max(100000), maxOutputTokens: z.number().int().min(0).max(16000),
    maxToolRounds:z.number().int().min(2).max(8).optional(),
    mediaKind: z.enum(['image', 'video']).optional(), video: z.strictObject({ durationSeconds: z.number().int().min(1).max(20), aspectRatio: z.string().regex(/^\d{1,2}:\d{1,2}$/), resolution: z.string().min(1).max(128) }).optional(),
    image: z.strictObject({ aspectRatio: z.string().regex(/^\d{1,2}:\d{1,2}$/).optional(), imageSize: z.string().regex(/^[0-9]{1,4}K?$/).optional() }).optional(),
    /** Operator-reviewed rate card for generated media. Absent pricing refuses paid media admission. */
    pricing: z.strictObject({ microUsdPerOutputSecond: z.number().int().min(1).max(100_000_000), source: z.string().min(1).max(300), reviewedAt: z.iso.date() }).optional() })),
});
export type AdapterFactory = (options: { providerId: string; registry: ModelRegistry; getCredential: () => string | undefined;
  subscription?: { reference: string; automaticFallback: { enabled: boolean; getCredential(): string | undefined } } }) => ProviderAdapter;

// The durable layer owns attempts. A provider POST is never silently retried here.
const singleAttempt = { maxAttempts: 1, attemptTimeoutMs: 60000, totalTimeoutMs: 60000, baseDelayMs: 500, maxDelayMs: 1000 };
const requiredCredential = (read: () => string | undefined) => () => {
  const value = read(); if (!value) throw new ProviderError('MISSING_CREDENTIAL'); return value;
};
/** Built-in Messages API adapter. `fetch` is injectable only by trusted test code; the adapter
 * itself fixes the HTTPS origin, path and headers. */
export function anthropicAdapterFactory(fetch?: typeof globalThis.fetch): AdapterFactory {
  return options => {
    if (options.subscription) throw new ProviderError('INVALID_CONFIG');
    return new AnthropicProvider({ providerId: options.providerId, registry: options.registry,
      getApiKey: requiredCredential(options.getCredential), settings: singleAttempt, ...(fetch ? { fetch } : {}) });
  };
}

/** Built-in Gemini API adapter. `fetch` is injectable only by trusted test code (the admin browser
 * suite's synthetic model); the adapter itself fixes the HTTPS origin, path and headers. */
export function googleAdapterFactory(fetch?: typeof globalThis.fetch): AdapterFactory {
  return options => new GoogleProvider({ providerId: options.providerId, registry: options.registry,
    getApiKey: requiredCredential(options.getCredential), settings: singleAttempt, ...(fetch ? { fetch } : {}) });
}

/** Only trusted server code registers factories. Course/browser data cannot load a module. */
/** `strategies` is trusted server composition too: reviewed strategy packs placed before Core's own. */
export function composeProviders(input: unknown, readCredential: (name: string) => string | undefined, trustedFactories: Record<string, AdapterFactory> = {},
  options: { strategies?: StrategyRegistry } = {}) {
  const parsed = providerConfigurationSchema.safeParse(input);
  if (!parsed.success) throw new ProviderError('INVALID_CONFIG');
  const registry = new ModelRegistry(parsed.data.registry as RegistryConfig), providers = new Set<string>();
  const factories: Record<string, AdapterFactory> = {
    google: googleAdapterFactory(),
    anthropic: anthropicAdapterFactory(),
    ...trustedFactories,
  };
  const installed = new Map<string, ProviderAdapter>();
  for (const adapter of parsed.data.adapters) {
    if (providers.has(adapter.id) || !Object.hasOwn(factories, adapter.kind)) throw new ProviderError('INVALID_CONFIG');
    providers.add(adapter.id);
    if ((adapter.kind === 'google' || adapter.kind === 'anthropic') && adapter.subscriptionRef) throw new ProviderError('INVALID_CONFIG');
    const implementation = factories[adapter.kind]!({ providerId: adapter.id, registry,
      getCredential: () => adapter.credentialEnv ? readCredential(adapter.credentialEnv) : undefined,
      ...(adapter.subscriptionRef ? { subscription: { reference: adapter.subscriptionRef, automaticFallback: {
        enabled: adapter.automaticFallback?.enabled === true,
        getCredential: () => adapter.automaticFallback?.enabled && adapter.automaticFallback.credentialEnv ? readCredential(adapter.automaticFallback.credentialEnv) : undefined,
      } } } : {}) });
    if (adapter.subscriptionRef && (implementation.access?.kind !== 'subscription' || implementation.access.subscriptionRef !== adapter.subscriptionRef
      || implementation.access.automaticFallbackEnabled !== (adapter.automaticFallback?.enabled === true))) throw new ProviderError('INVALID_CONFIG');
    registry.registerAdapter(implementation); installed.set(adapter.id, implementation);
  }
  return new ProviderRuntime(registry, parsed.data.roles as RoleBindings, providerId => {
    const adapter = parsed.data.adapters.find(row => row.id === providerId);
    if (!adapter) return false;
    if (adapter.credentialEnv) return Boolean(readCredential(adapter.credentialEnv));
    return installed.get(providerId)?.access?.isConfigured() === true || Boolean(adapter.automaticFallback?.enabled && adapter.automaticFallback.credentialEnv && readCredential(adapter.automaticFallback.credentialEnv));
  }, options.strategies);
}

export function unconfiguredProviders() {
  return new ProviderRuntime(new ModelRegistry({ revision: 'unconfigured', models: [] }), {}, () => false);
}
