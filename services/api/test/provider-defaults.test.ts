import { describe, expect, it } from 'vitest';
import { upgradeLegacyProviderConfiguration } from '../src/provider-defaults.js';
import { roleReservation } from '../src/role-reservation.js';
import { roleRevisions } from '../src/agent-evals/revision.js';
import { composeProviders } from '../src/provider-composition.js';
import { configurationTokenBounds } from '../src/provider-setup.js';

/** A configuration exactly as the Gemini setup guide drafted it before Core set thinking (0.1.52). */
function legacy(remoteModel = 'gemini-3.8-flash') {
  const model = (role: string, capability: string, maxInputCharacters: number) => ({ id: `google:${role}`, providerId: 'google', remoteModel, enabled: true,
    capabilities: [capability], tools: capability === 'research' ? ['web_search'] : [],
    providerConfig: { transport: 'generate_content', apiVersion: 'v1beta', maxResponseBytes: 1048576 }, limits: { maxInputCharacters, maxOutputTokens: 1000 } });
  return {
    registry: { revision: 'guide', models: [model('companion', 'tutoring', 12000), model('supervisor', 'structured_assessment', 30000)] },
    adapters: [{ id: 'google', kind: 'google', credentialEnv: 'GOOGLE_API_KEY' as const }],
    roles: { companion: { modelId: 'google:companion', maxInputCharacters: 12000, maxOutputTokens: 1000 },
      supervisor: { modelId: 'google:supervisor', maxInputCharacters: 30000, maxOutputTokens: 1000, maxToolRounds: 4 } },
  };
}
const modelOf = (c: ReturnType<typeof legacy>, id: string) => c.registry.models.find(m => m.id === id) as { providerConfig: Record<string, unknown>; limits: { maxOutputTokens: number } };

describe('legacy Gemini configurations get thinking-aware defaults at load', () => {
  it('sets the role thinking level and raises the old 1000-token limit on the model and the role', () => {
    const upgraded = upgradeLegacyProviderConfiguration(legacy(), 600_000);
    expect(modelOf(upgraded, 'google:companion').providerConfig.thinking).toEqual({ level: 'low' });
    expect(modelOf(upgraded, 'google:supervisor').providerConfig.thinking).toEqual({ level: 'medium' });
    expect(modelOf(upgraded, 'google:companion').limits.maxOutputTokens).toBe(4096);
    expect(upgraded.roles.companion.maxOutputTokens).toBe(4096);
    expect(upgraded.roles.supervisor.maxOutputTokens).toBe(8192);
    // The pilot's 500,000-token allowance cannot hold the supervisor's four larger rounds: its limit
    // stays and it thinks at the low level so its answer fits; the companion is raised.
    const pilot = upgradeLegacyProviderConfiguration(legacy(), 500_000);
    expect(pilot.roles.supervisor.maxOutputTokens).toBe(1000);
    expect(modelOf(pilot, 'google:supervisor').providerConfig.thinking).toEqual({ level: 'low' });
    expect(pilot.roles.companion.maxOutputTokens).toBe(4096);
    // Still a valid configuration whose bounds fit the allowance.
    composeProviders(upgraded, () => 'configured');
    expect(configurationTokenBounds(pilot).companion).toBeLessThanOrEqual(500_000);
  });
  it('is idempotent and leaves operator choices, other providers and non-thinking models alone', () => {
    const once = upgradeLegacyProviderConfiguration(legacy(), 500_000);
    expect(upgradeLegacyProviderConfiguration(once, 500_000)).toBe(once);
    const chosen = legacy(); chosen.roles.companion.maxOutputTokens = 2000; chosen.registry.models[0]!.limits.maxOutputTokens = 2000;
    (chosen.registry.models[1]!.providerConfig as Record<string, unknown>).thinking = { level: 'high' };
    const kept = upgradeLegacyProviderConfiguration(chosen, 500_000);
    expect(kept.roles.companion.maxOutputTokens).toBe(2000);
    expect(modelOf(kept, 'google:companion').providerConfig.thinking).toEqual({ level: 'low' });
    expect(modelOf(kept, 'google:supervisor').providerConfig.thinking).toEqual({ level: 'high' });
    expect(kept.roles.supervisor.maxOutputTokens).toBe(1000); // tool loop bound does not fit 500,000
    const old = legacy('gemini-2.0-flash');
    expect(upgradeLegacyProviderConfiguration(old, 500_000)).toBe(old);
    const other = legacy(); other.adapters[0]!.kind = 'anthropic';
    expect(upgradeLegacyProviderConfiguration(other as never, 500_000)).toBe(other);
  });
  it('does not raise a limit past the job token allowance (the thinking level still applies)', () => {
    const tight = upgradeLegacyProviderConfiguration(legacy(), 53_096 + 100);
    expect(tight.roles.companion.maxOutputTokens).toBe(1000);
    expect(modelOf(tight, 'google:companion').providerConfig.thinking).toEqual({ level: 'low' });
  });
  it('Gemini 2.5 gets a budget, not a level', () => {
    const upgraded = upgradeLegacyProviderConfiguration(legacy('gemini-2.5-flash'), 500_000);
    expect(modelOf(upgraded, 'google:companion').providerConfig.thinking).toEqual({ budget: 512 });
  });
  it('the upgrade is a new role revision, and saving the upgraded setup again leaves every revision unchanged', async () => {
    const before = await roleRevisions(legacy()), after = await roleRevisions(upgradeLegacyProviderConfiguration(legacy(), 500_000));
    expect(after.companion!.digest).not.toBe(before.companion!.digest);
    const again = await roleRevisions(upgradeLegacyProviderConfiguration(upgradeLegacyProviderConfiguration(legacy(), 500_000), 500_000));
    expect(again.companion!.digest).toBe(after.companion!.digest);
    expect(again.supervisor!.digest).toBe(after.supervisor!.digest);
  });
});

describe('role reservations are sized from the role limits and the price in force', () => {
  const price = { versionId: 'p', currency: 'USD' as const, inputMicroUsdPerMillionTokens: 750_000, outputMicroUsdPerMillionTokens: 3_750_000,
    cachedInputMicroUsdPerMillionTokens: null, microUsdPerRequest: null, microUsdPerOutputSecond: null };
  const policy = { microUsd: 100_000, tokens: 500_000 };
  it('the pilot companion: max input and max output at the price, with a margin, far below the job allowance', () => {
    const sized = roleReservation({ maxInputCharacters: 12000, maxOutputTokens: 4096 }, price, policy)!;
    expect(sized.microUsd).toBe(Math.ceil(((12000 + 1024) * 750_000 + 4096 * 3_750_000) * 1.25 / 1_000_000));
    expect(sized.microUsd).toBeLessThan(policy.microUsd / 2);
    // The reserved ceiling covers a real turn (2002 input, 856 output tokens) many times over.
    expect(sized.microUsd).toBeGreaterThan(Math.ceil((2002 * 750_000 + 856 * 3_750_000) / 1_000_000) * 4);
    expect(sized.tokens).toBe(12000 * 4 + 4096 + 4096);
  });
  it('a tool loop multiplies by its rounds, a per-request price is added, and the job allowance stays the ceiling', () => {
    const loop = roleReservation({ maxInputCharacters: 30000, maxOutputTokens: 8192, maxToolRounds: 4 }, { ...price, microUsdPerRequest: 10 }, { microUsd: 1_000_000, tokens: 1_000_000 })!;
    expect(loop.microUsd).toBe(Math.ceil(4 * ((30000 + 1024) * 750_000 + 8192 * 3_750_000) * 1.25 / 1_000_000) + 40);
    expect(roleReservation({ maxInputCharacters: 30000, maxOutputTokens: 8192, maxToolRounds: 4 }, price, policy)).toEqual({ microUsd: 100_000, tokens: 500_000 });
  });
  it('without token prices the policy allowance stays in force', () => {
    expect(roleReservation({ maxInputCharacters: 12000, maxOutputTokens: 4096 }, null, policy)).toBeNull();
    expect(roleReservation({ maxInputCharacters: 12000, maxOutputTokens: 4096 }, { ...price, inputMicroUsdPerMillionTokens: null, outputMicroUsdPerMillionTokens: null, microUsdPerRequest: 5 }, policy)).toBeNull();
  });
});
