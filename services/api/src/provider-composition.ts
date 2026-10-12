import { z } from 'zod';
import { ModelRegistry, ProviderError, type ProviderAdapter, type RegistryConfig } from '@course-core/providers';
import { GoogleProvider } from '@course-core/providers/google';
import { ProviderRuntime, type RoleBindings } from './provider-runtime.js';

const configuration = z.strictObject({
  registry: z.unknown(),
  adapters: z.array(z.strictObject({ id: z.string().min(1).max(128), kind: z.string().min(1).max(100), credentialEnv: z.string().regex(/^(?:GOOGLE_API_KEY|COURSE_PROVIDER_[A-Z0-9_]+_API_KEY)$/) })).max(20),
  roles: z.partialRecord(z.enum(['supervisor', 'companion', 'research', 'media']), z.strictObject({ modelId: z.string().min(1).max(2048), maxInputCharacters: z.number().int().min(2000).max(100000), maxOutputTokens: z.number().int().min(0).max(16000),
    mediaKind: z.enum(['image', 'video']).optional(), video: z.strictObject({ durationSeconds: z.number().int().min(1).max(20), aspectRatio: z.string().regex(/^\d{1,2}:\d{1,2}$/), resolution: z.string().min(1).max(128) }).optional() })),
});
export type AdapterFactory = (options: { providerId: string; registry: ModelRegistry; getCredential: () => string | undefined }) => ProviderAdapter;

/** Only trusted server code registers factories. Course/browser data cannot load a module. */
export function composeProviders(input: unknown, readCredential: (name: string) => string | undefined, trustedFactories: Record<string, AdapterFactory> = {}) {
  const parsed = configuration.safeParse(input);
  if (!parsed.success) throw new ProviderError('INVALID_CONFIG');
  const registry = new ModelRegistry(parsed.data.registry as RegistryConfig), providers = new Set<string>();
  const factories: Record<string, AdapterFactory> = {
    google: options => new GoogleProvider({ providerId: options.providerId, registry: options.registry, getApiKey: () => {
      const value = options.getCredential(); if (!value) throw new ProviderError('MISSING_CREDENTIAL'); return value;
    },
      // The durable layer owns attempts. A provider POST is never silently retried here.
      settings: { maxAttempts: 1, attemptTimeoutMs: 60000, totalTimeoutMs: 60000, baseDelayMs: 500, maxDelayMs: 1000 } }),
    ...trustedFactories,
  };
  for (const adapter of parsed.data.adapters) {
    if (providers.has(adapter.id) || !Object.hasOwn(factories, adapter.kind)) throw new ProviderError('INVALID_CONFIG');
    providers.add(adapter.id);
    registry.registerAdapter(factories[adapter.kind]!({ providerId: adapter.id, registry, getCredential: () => readCredential(adapter.credentialEnv) }));
  }
  return new ProviderRuntime(registry, parsed.data.roles as RoleBindings, providerId => {
    const adapter = parsed.data.adapters.find(row => row.id === providerId);
    return Boolean(adapter && readCredential(adapter.credentialEnv));
  });
}

export function unconfiguredProviders() {
  return new ProviderRuntime(new ModelRegistry({ revision: 'unconfigured', models: [] }), {}, () => false);
}
