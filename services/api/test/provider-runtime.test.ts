import { describe, expect, it } from 'vitest';
import type { ProviderAdapter, TextRequest, UsageReceipt, VideoJob, VideoRequest } from '@course-core/providers';
import { composeProviders, unconfiguredProviders } from '../src/provider-composition.js';
import { minimizeContext, type TeachingContext } from '../src/provider-runtime.js';

function context(): TeachingContext { return {
  course: { title: 'Ordering', digest: 'a'.repeat(64) }, episode: { id: 'min', title: 'Minimum', teaching: 'The smaller value comes first.', objectives: [{ id: 'minimum', description: 'Find a minimum.' }] },
  learner: { profile: { goal: 'Understand comparisons' }, recentHistory: [] }, question: 'Why is two smaller than five?',
  constraints: { deadline: null, expansionAllowed: true, independentAssessmentActive: false },
}; }
function config() { return {
  registry: { revision: 'test-config', models: [{ id: 'portable:custom', providerId: 'custom', remoteModel: 'vendor/model with opaque syntax', enabled: true,
    capabilities: ['tutoring', 'structured_assessment'], tools: [], providerConfig: { customProtocol: true }, limits: { maxInputCharacters: 50000, maxOutputTokens: 4000 } }] },
  adapters: [{ id: 'custom', kind: 'custom', credentialEnv: 'COURSE_PROVIDER_CUSTOM_API_KEY' }],
  roles: { companion: { modelId: 'portable:custom', maxInputCharacters: 20000, maxOutputTokens: 1000 }, supervisor: { modelId: 'portable:custom', maxInputCharacters: 20000, maxOutputTokens: 1000 } },
}; }
function fixture(output: unknown = { summary: 'One clarification could help.', needs: [{ objectiveId: 'minimum', reason: 'Asked about ordering.', proposedAction: 'clarification' }] }) {
  const seen: TextRequest[] = [];
  const usage: UsageReceipt = { accounting: { accountingKey: 'test' }, providerId: 'custom', modelId: 'portable:custom', operation: 'tutor', attempts: [], inputCharacters: 100,
    requestedMaxOutputTokens: 1000, requestedVideoSeconds: null, observedImageCount: null, observedVideoCount: null, cost: null };
  const adapter: ProviderAdapter = { providerId: 'custom', validateModel: () => {}, ports: {
    tutoring: { async tutor(request) { seen.push(request); return { output: { text: 'Compare their positions on a number line.' }, usage }; } },
    structured_assessment: { async assess(request) { seen.push(request); return { output: output as any, usage }; } },
  } };
  const runtime = composeProviders(config(), () => 'synthetic-credential-canary', { custom: () => adapter });
  return { runtime, seen, usage };
}

describe('provider-neutral application composition', () => {
  it('reports missing configuration without selecting a fallback or invoking a provider', async () => {
    const runtime = unconfiguredProviders();
    expect(runtime.status()).toEqual({ supervisor: { status: 'configuration_missing' }, companion: { status: 'configuration_missing' }, research: { status: 'configuration_missing' }, media: { status: 'configuration_missing' } });
    await expect(runtime.execute('companion', context(), 'op', new AbortController().signal)).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' });
  });
  it('dispatches a non-Google capability without Google model/configuration fields and does not serialize credentials', async () => {
    const { runtime, seen } = fixture();
    const result = await runtime.execute('companion', context(), 'operation-1', new AbortController().signal);
    expect(result.content).toEqual({ kind: 'companion_text', text: 'Compare their positions on a number line.', episodeId: 'min' });
    expect(result.verification).toBe('unverified');
    expect(JSON.stringify(seen)).not.toContain('synthetic-credential-canary');
    expect(JSON.stringify(runtime.describe())).not.toContain('synthetic-credential-canary');
    expect(seen[0]!.maxOutputTokens).toBe(1000);
    expect(seen[0]!.messages[0]!.text).toContain('Understand comparisons');
  });
  it('blocks companion generation on an independent attempt before any model call', async () => {
    const { runtime, seen } = fixture(), input = context(); input.constraints.independentAssessmentActive = true;
    await expect(runtime.execute('companion', input, 'operation-1', new AbortController().signal)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(seen).toHaveLength(0);
  });
  it('does not let a structured supervisor proposal introduce an unregistered objective or claim applied credit', async () => {
    const bad = fixture({ summary: 'Improve arithmetic.', needs: [{ objectiveId: 'invented', reason: 'model inference', proposedAction: 'practice' }] });
    await expect(bad.runtime.execute('supervisor', context(), 'operation-1', new AbortController().signal)).rejects.toMatchObject({ code: 'INVALID_RESPONSE', usage: bad.usage });
    const credit = fixture({ summary: 'Finished', needs: [], passed: true });
    await expect(credit.runtime.execute('supervisor', context(), 'operation-1', new AbortController().signal)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    const good = fixture();
    expect((await good.runtime.execute('supervisor', context(), 'operation-2', new AbortController().signal)).verification).toBe('unverified');
  });
  it('rejects unknown roles, arbitrary environment access and unregistered adapter kinds', () => {
    const unknown = config() as any; unknown.roles.secretReader = unknown.roles.companion;
    expect(() => composeProviders(unknown, () => undefined)).toThrow();
    const env = config(); env.adapters[0]!.credentialEnv = 'DATABASE_URL';
    expect(() => composeProviders(env, () => undefined)).toThrow();
    expect(() => composeProviders(config(), () => undefined)).toThrow();
  });
  it('bounds history and teaching without modifying the authoritative records or truncating the latest question', () => {
    const input = context(); input.episode.teaching = 'explanation '.repeat(10000);
    input.learner.recentHistory = Array.from({ length: 200 }, (_, i) => ({ role: 'learner', content: `older message ${i} `.repeat(100) }));
    const result = minimizeContext(input, 6000);
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(6000);
    expect(result.historyTruncated).toBe(true); expect(result.question).toBe(input.question);
    expect(input.learner.recentHistory).toHaveLength(200);
    expect(input.episode.teaching.length).toBeGreaterThan(6000);
  });
  it('preserves a neutral long-running video job and never calls a pending video completed', async () => {
    const { usage } = fixture(); const seen: VideoRequest[] = [];
    const job: VideoJob = { kind: 'video', providerId: 'custom', modelId: 'movie', registryRevision: 'test-config', providerState: { ticket: 'opaque-queue-id' }, accounting: { accountingKey: 'video-operation' }, requestedDurationSeconds: 4 };
    const adapter: ProviderAdapter = { providerId: 'custom', validateModel: () => {}, ports: { video: {
      async startVideo(request) { seen.push(request); return { output: { state: 'pending', job }, usage: { ...usage, operation: 'video_submit' } }; },
      async pollVideo(input) { expect(input).toEqual(job); return { output: { state: 'completed', job, videos: [{ uri: 'https://cdn.example.invalid/video.webm', mimeType: 'video/webm' }] }, usage: { ...usage, operation: 'video_poll' } }; },
    } } };
    const runtime = composeProviders({ registry: { revision: 'test-config', models: [{ id: 'movie', providerId: 'custom', remoteModel: 'queue:renderer/v2', providerConfig: {}, enabled: true, capabilities: ['video'], tools: [], limits: { maxInputCharacters: 20000 } }] },
      adapters: [{ id: 'custom', kind: 'custom', credentialEnv: 'COURSE_PROVIDER_CUSTOM_API_KEY' }], roles: { media: { modelId: 'movie', mediaKind: 'video', maxInputCharacters: 10000, maxOutputTokens: 0,
        video: { durationSeconds: 4, aspectRatio: '16:9', resolution: '720p' } } } }, () => 'synthetic', { custom: () => adapter });
    const started = await runtime.execute('media', context(), 'video-operation', new AbortController().signal);
    expect(started.content).toMatchObject({ kind: 'video_candidate', state: 'pending', job });
    expect(started.verification).toBe('unverified'); expect(seen[0]!.durationSeconds).toBe(4);
    const polled = await runtime.pollVideo(job, new AbortController().signal);
    expect(polled.content).toMatchObject({ state: 'completed' }); expect(polled.verification).toBe('unverified');
  });
  it('sends only an approved public topic to external research, with no private learner context', async () => {
    const { usage } = fixture(), seen: TextRequest[] = [];
    const research: ProviderAdapter = { providerId: 'research', validateModel: () => {}, ports: { research: { async research(request) {
      seen.push(request); return { usage, output: { text: 'A candidate explanation.', grounding: 'grounded', parts: [], sources: [], citations: [], searchQueries: ['ordering numbers'], searchSuggestionsHtml: '<div>Untrusted provider markup</div>' } };
    } } } };
    const runtime = composeProviders({ registry: { revision: 'research-config', models: [{ id: 'search', providerId: 'research', remoteModel: 'search-backend', providerConfig: {}, enabled: true, capabilities: ['research'], tools: ['web_search'], limits: { maxInputCharacters: 20000, maxOutputTokens: 1000 } }] },
      adapters: [{ id: 'research', kind: 'research', credentialEnv: 'COURSE_PROVIDER_RESEARCH_API_KEY' }], roles: { research: { modelId: 'search', maxInputCharacters: 12000, maxOutputTokens: 1000 } } }, () => 'synthetic', { research: () => research });
    const input = context(); input.learner.profile = { goal: 'private-learner-canary' }; input.question = 'private-question-canary';
    await expect(runtime.execute('research', input, 'query-1', new AbortController().signal)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(seen).toHaveLength(0);
    input.publicResearchTopic = 'Ordering numbers with a number line';
    const result = await runtime.execute('research', input, 'query-1', new AbortController().signal);
    expect(seen[0]!.messages).toEqual([{ role: 'user', text: input.publicResearchTopic }]);
    expect(JSON.stringify(seen)).not.toMatch(/private-learner-canary|private-question-canary|Find a minimum/);
    expect(result.verification).toBe('unverified');
    expect(result.content).not.toHaveProperty('searchSuggestionsHtml');
  });
});
