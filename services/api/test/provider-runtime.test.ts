import { describe, expect, it } from 'vitest';
import { priceMediaUnits, subscriptionAdapter, type ProviderAdapter, type TextRequest, type UsageReceipt, type VideoJob, type VideoRequest } from '@course-core/providers';
import { composeProviders, unconfiguredProviders } from '../src/provider-composition.js';
import { minimizeContext, type TeachingContext } from '../src/provider-runtime.js';
import { contextHeadroom } from '../src/agent-strategies.js';
import {teachingPolicyView} from '../src/teaching-constraints.js';
import {initialPolicy} from '../src/policy-adapter.js';
import {fixture as courseFixture} from './fixture.js';

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
  it('composes documented subscription access without an API key or a hidden fallback', async () => {
    const cfg=config() as any;cfg.adapters=[{id:'custom',kind:'custom',subscriptionRef:'connection-1'}];
    let credentialReads=0;const now=Date.now(),later=new Date(now+60000).toISOString();
    const native:ProviderAdapter={providerId:'custom',validateModel(){},ports:{
      tutoring:{async tutor(request){return {output:{text:'Subscription reply'},usage:{...fixture().usage,accounting:request.accounting}};}},
      structured_assessment:{async assess(request){return {output:{summary:'No change',needs:[]},usage:{...fixture().usage,operation:'assess',accounting:request.accounting}};}},
    }};
    const runtime=composeProviders(cfg,()=>{credentialReads++;return undefined;},{custom:options=>{
      expect(options.getCredential()).toBeUndefined();expect(options.subscription?.automaticFallback.enabled).toBe(false);
      expect(options.subscription?.automaticFallback.getCredential()).toBeUndefined();
      return subscriptionAdapter({adapter:native,subscriptionRef:options.subscription!.reference,
        applicationAccess:{supported:true,documentationUrl:'https://provider.example.invalid/application-subscriptions',reviewedAt:new Date(now).toISOString()},
        isConfigured:()=>true,now:()=>now,
        async getStatus(){return {providerId:'custom',subscriptionRef:'connection-1',entitlementRevision:'e1',state:'active',observedAt:new Date(now).toISOString(),expiresAt:later,quotas:[]};},
        async authorize(call){return {providerId:call.providerId,subscriptionRef:call.subscriptionRef,entitlementRevision:call.entitlementRevision,
          modelId:call.modelId,operation:call.operation,accountingKey:call.accounting.accountingKey,validUntil:later,disposition:'included'};},
      });
    }});
    expect(runtime.status().companion).toEqual({status:'ready'});
    expect(credentialReads).toBe(0);
    const result=await runtime.execute('companion',context(),'subscription-call',new AbortController().signal);
    expect(result.content).toMatchObject({kind:'companion_text',text:'Subscription reply'});
    expect(result.usage.access).toMatchObject({kind:'subscription',overageAllowed:false});expect(credentialReads).toBe(0);
  });
  it('rejects ambiguous authentication, unsupported Google subscriptions and factories that ignore fallback opt-in',()=>{
    const cfg=config() as any;
    cfg.adapters[0].subscriptionRef='connection-1';expect(()=>composeProviders(cfg,()=>undefined)).toThrow();
    delete cfg.adapters[0].credentialEnv;cfg.adapters[0].kind='google';expect(()=>composeProviders(cfg,()=>undefined)).toThrow();
    cfg.adapters[0].kind='custom';cfg.adapters[0].automaticFallback={enabled:true};expect(()=>composeProviders(cfg,()=>undefined)).toThrow();
    cfg.adapters[0].automaticFallback={enabled:true,credentialEnv:'COURSE_PROVIDER_CUSTOM_API_KEY'};
    const adapter:ProviderAdapter={providerId:'custom',validateModel(){},ports:{},access:{kind:'subscription',subscriptionRef:'connection-1',automaticFallbackEnabled:false,isConfigured:()=>true}};
    expect(()=>composeProviders(cfg,()=>undefined,{custom:()=>adapter})).toThrow();
  });
  it('retains exact server policy through context minimization and never replaces it to fit a smaller prompt',()=>{
    const input=context(),state=initialPolicy(courseFixture(),'enrollment','learner','2026-01-01T00:00:00Z');input.constraints.resolvedPolicy=teachingPolicyView(state,'min',['minimum'],'2026-01-01T00:00:00Z');
    input.learner.recentHistory=Array.from({length:100},()=>({role:'learner',content:'history '.repeat(1000)}));
    const result=minimizeContext(input,12000);expect(result.constraints).toEqual(input.constraints);expect(result.historyTruncated).toBe(true);
    expect(()=>minimizeContext(input,100)).toThrow();
  });
  it('reports missing configuration without selecting a fallback or invoking a provider', async () => {
    const runtime = unconfiguredProviders();
    expect(runtime.status()).toEqual({ supervisor: { status: 'configuration_missing' }, companion: { status: 'configuration_missing' }, research: { status: 'configuration_missing' }, media: { status: 'configuration_missing' }, reviewer: { status: 'configuration_missing' } });
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
    // The model answered: Core's refusal is a definite outcome carrying only the reason and the real usage, not an uncertain error.
    const refused = await bad.runtime.execute('supervisor', context(), 'operation-1', new AbortController().signal);
    expect(refused.content).toEqual({ kind: 'output_refusal', role: 'supervisor', reason: 'objective_out_of_scope' });
    expect(refused.usage).toEqual(bad.usage);
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
      discoverCapabilities: modelId => ({ modelId, providerId: 'custom', kind: 'video', maxPromptCharacters: 20000, cancellation: 'not_applicable', billing: 'per_output_second',
        retention: { outputHours: null, providerStoresRequest: false } }),
      estimateCost: (request, price) => priceMediaUnits({ outputSeconds: request.durationSeconds, images: 0, requests: 1 }, price),
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
    input.publicResearchScope={requestId:'scope',topicId:'topic',queryDigest:'a'.repeat(64)};
    const result = await runtime.execute('research', input, 'query-1', new AbortController().signal);
    expect(seen[0]!.messages).toEqual([{ role: 'user', text: input.publicResearchTopic }]);
    expect(JSON.stringify(seen)).not.toMatch(/private-learner-canary|private-question-canary|Find a minimum/);
    expect(result.verification).toBe('unverified');
    expect(result.content).not.toHaveProperty('searchSuggestionsHtml');
  });
});
it('rechecks host authority before each model round and retains earlier usage when authority is revoked',async()=>{
 const cfg=config() as any;cfg.roles.supervisor.maxToolRounds=3;let calls=0,fences=0;const usage:UsageReceipt={...fixture().usage,operation:'assess',attempts:[{attempt:1,status:200,outcome:'response',tokens:{input:10,output:10,total:20,cachedInput:0,thoughts:0,toolInput:0}}]};
 const adapter:ProviderAdapter={providerId:'custom',validateModel(){},ports:{structured_assessment:{async assess(){calls++;return {usage,output:{decision:'tool',tool:'get_profile',argumentsJson:'{}',summary:''}};}},tutoring:{async tutor(){throw Error('Unexpected tutoring call');}}}};
 const runtime=composeProviders(cfg,()=> 'synthetic',{custom:()=>adapter});
 await expect(runtime.execute('supervisor',context(),'fenced-round',new AbortController().signal,{async invoke(){return {receiptId:crypto.randomUUID(),result:{available:true}};}},async()=>{if(fences++)throw Error('Scope revoked');})).rejects.toMatchObject({submission:'unknown',usage:{attempts:[expect.anything()]}});
 expect(calls).toBe(1);expect(fences).toBe(2);
});
describe('context minimization keeps the question and anchors, leaves headroom and does not refuse a long conversation', () => {
  const long = () => {
    const input = context();
    input.episode.teaching = 'Lesson text with "quotes" and\nnew lines. '.repeat(2000);
    input.learner.recentHistory = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'learner', content: `turn ${i} ` + 'explanation '.repeat(330) }));
    input.learner.recentAttempts = Array.from({ length: 10 }, (_, i) => ({ assessmentId: `a${i}`, prompt: 'prompt '.repeat(200), passed: false, assistance: 'none', mode: 'practice', feedback: 'feedback '.repeat(100) }));
    input.learner.model = { notes: 'model '.repeat(500) };
    input.conversation = { scope: 'this_lesson_only', earlierQuestions: { count: 5, excerpts: Array.from({ length: 5 }, () => 'earlier '.repeat(20)), note: 'n' } };
    input.question = 'CURRENT_QUESTION: do frozen layers still affect the prediction?';
    return input;
  };
  it.each([1000, 2500, 8000, 10300, 30000])('fits %i characters with headroom, keeping the question and lesson anchors', (bound) => {
    const input = long(), result = minimizeContext(input, bound), size = JSON.stringify(result).length;
    expect(size).toBeLessThanOrEqual(bound - contextHeadroom(bound));
    expect(result.question).toBe(input.question);
    expect(result.questionTruncated).toBeUndefined();
    expect(result.episode).toMatchObject({ id: input.episode.id, title: input.episode.title });
    expect(result.episode.objectives.map(o => o.id)).toEqual(input.episode.objectives.map(o => o.id));
    expect(result.course).toEqual(input.course);
    expect(result.historyTruncated).toBe(true);
  });
  it('keeps the newest history first and lesson text before dropping more', () => {
    const input = long(), result = minimizeContext(input, 30000);
    if (result.learner.recentHistory.length) expect(result.learner.recentHistory.at(-1)).toEqual(input.learner.recentHistory.at(-1));
  });
  it('a question longer than a tiny bound is shortened and marked, never dropped', () => {
    const input = context(); input.question = 'Q '.repeat(1800);
    const result = minimizeContext(input, 1000);
    expect(result.questionTruncated).toBe(true);
    expect(result.question.length).toBeGreaterThan(0);
    expect(input.question.startsWith(result.question)).toBe(true);
  });
  it('the companion run never refuses a long conversation before sending', async () => {
    const { runtime, seen } = fixture();
    const result = await runtime.execute('companion', long(), 'operation-long', new AbortController().signal);
    expect(result.content).toMatchObject({ kind: 'companion_text' });
    expect(seen[0]!.messages[0]!.text).toContain('CURRENT_QUESTION');
    expect(seen[0]!.allowCutShort).toBe(true);
    expect(seen[0]!.systemInstruction).toContain('Keep replies short and plain');
  });
});

describe('response bounds of a role call (live finding B-2)', () => {
  function bounded(roles: Record<string, unknown>) {
    const calls: { operation: string; options: Record<string, unknown> }[] = [];
    const usage: UsageReceipt = { accounting: { accountingKey: 'b' }, providerId: 'custom', modelId: 'portable:custom', operation: 'tutor', attempts: [], inputCharacters: 1,
      requestedMaxOutputTokens: 1, requestedVideoSeconds: null, observedImageCount: null, observedVideoCount: null, cost: null };
    const adapter: ProviderAdapter = { providerId: 'custom', validateModel: () => {}, ports: {
      tutoring: {
        async tutor(_request, options) { calls.push({ operation: 'tutor', options: { ...options } }); return { output: { text: 'Whole reply.' }, usage }; },
        async tutorStream(_request, options, onText) { calls.push({ operation: 'tutorStream', options: { ...options } }); onText('Streamed.'); return { output: { text: 'Streamed.' }, usage }; },
      },
      structured_assessment: { async assess(_request, options) { calls.push({ operation: 'assess', options: { ...options } });
        return { output: { summary: 'None.', needs: [] }, usage: { ...usage, operation: 'assess' } }; } },
    } };
    const runtime = composeProviders({ ...config(), roles }, () => 'synthetic-credential-canary', { custom: () => adapter });
    return { runtime, calls };
  }
  const companion = { modelId: 'portable:custom', maxInputCharacters: 20000, maxOutputTokens: 1000 };
  const supervisor = { modelId: 'portable:custom', maxInputCharacters: 20000, maxOutputTokens: 1000 };

  it('a streamed reply must start within 20 s and never pause longer than 20 s, below the 60 s call bound; a whole reply keeps the call bound', async () => {
    const { runtime, calls } = bounded({ companion, supervisor });
    await runtime.execute('companion', context(), 'k1', new AbortController().signal, undefined, undefined, [], () => {});
    await runtime.execute('companion', context(), 'k2', new AbortController().signal);
    await runtime.execute('supervisor', context(), 'k3', new AbortController().signal);
    expect(calls.map(c => [c.operation, c.options.timeoutMs, c.options.firstByteTimeoutMs, c.options.idleTimeoutMs])).toEqual([
      ['tutorStream', 60000, 20000, 20000],
      // A whole reply's first byte is its finished response: no first-byte bound unless the role sets one.
      ['tutor', 60000, undefined, undefined],
      ['assess', 60000, undefined, undefined],
    ]);
  });

  it('a role binding sets its own bounds, within the call bound', async () => {
    const { runtime, calls } = bounded({ companion: { ...companion, firstByteTimeoutMs: 12000, streamIdleTimeoutMs: 8000 }, supervisor: { ...supervisor, firstByteTimeoutMs: 45000 } });
    await runtime.execute('companion', context(), 'k1', new AbortController().signal, undefined, undefined, [], () => {});
    await runtime.execute('supervisor', context(), 'k2', new AbortController().signal);
    expect(calls.map(c => [c.operation, c.options.firstByteTimeoutMs, c.options.idleTimeoutMs])).toEqual([['tutorStream', 12000, 8000], ['assess', 45000, undefined]]);
    for (const value of [4999, 55001, 1.5])
      expect(() => composeProviders({ ...config(), roles: { companion: { ...companion, firstByteTimeoutMs: value } } }, () => 'k', { custom: () => ({ providerId: 'custom', validateModel: () => {}, ports: {} }) })).toThrow();
    expect(() => composeProviders({ ...config(), roles: { companion: { ...companion, streamIdleTimeoutMs: 60000 } } }, () => 'k', { custom: () => ({ providerId: 'custom', validateModel: () => {}, ports: {} }) })).toThrow();
  });
});
