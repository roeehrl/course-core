import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { assertCourseRunnable } from '../src/publication.js';
import { assertInstalledActivityRuntimes, declarativeActivityRuntime, frameContentSecurityPolicy, frameDocument, FRAME_BOOTSTRAP, grantedCapabilities,
  matchesSchema, schemaIssues } from '../src/activity-runtime.js';
import { activityCourse, activityDefinition, declarativeConfiguration, evaluatorDeclaration, sandboxedActivityRuntime, sandboxedCourse, syntheticActivityEvaluator } from './activity-fixture.js';

const installed = () => [declarativeActivityRuntime(), syntheticActivityEvaluator()];
function refusal(run: () => void) {
  try { run(); } catch (error) { return error as { code: string; details?: Record<string, unknown> }; }
  return null;
}

describe('activity publication', () => {
  it('publishes a declarative activity when its runtime and registered evaluator are installed', () => {
    expect(() => assertCourseRunnable(activityCourse(), installed())).not.toThrow();
    expect(() => assertCourseRunnable(sandboxedCourse(), [declarativeActivityRuntime(), sandboxedActivityRuntime()])).not.toThrow();
  });
  it('refuses a declared course target this host cannot run, without a fallback', () => {
    expect(refusal(() => assertCourseRunnable(activityCourse(), [syntheticActivityEvaluator()]))).toMatchObject({ code: 'PUBLISH_ACTIVITY_TARGET_UNSUPPORTED', details: { activityId: 'min-explore', target: 'web_desktop' } });
    // A runtime whose build differs from the course declaration does not count.
    const other = { ...declarativeActivityRuntime(), integrity: 'sha256-' + '0'.repeat(64) };
    expect(refusal(() => assertCourseRunnable(activityCourse(), [other, syntheticActivityEvaluator()]))?.code).toBe('PUBLISH_ACTIVITY_TARGET_UNSUPPORTED');
  });
  it('checks every declared course target, not just web (U06)', () => {
    const course = activityCourse();
    course.platforms = ['web', 'ios'];
    expect(refusal(() => assertCourseRunnable(course, installed()))).toMatchObject({ code: 'PUBLISH_ACTIVITY_TARGET_UNSUPPORTED', details: { target: 'ios_phone' } });
    // Objective-equivalent fallbacks for the native targets make it publishable.
    course.activities![0]!.equivalentFallbacks = (['ios_phone', 'ipados_tablet'] as const).map(target => ({ target, kind: 'text_block' as const, ref: 'min-text', objectiveIds: ['minimum'] }));
    expect(() => assertCourseRunnable(course, installed())).not.toThrow();
    // A fallback that does not cover the activity's objectives, or names nothing, is not one.
    course.activities![0]!.equivalentFallbacks[0]!.ref = 'no-such-block';
    expect(refusal(() => assertCourseRunnable(course, installed()))).toMatchObject({ code: 'PUBLISH_ACTIVITY_TARGET_UNSUPPORTED', details: { target: 'ios_phone', fallback: 'no-such-block' } });
    course.activities![0]!.equivalentFallbacks[0] = { target: 'ios_phone', kind: 'assessment', ref: 'max-a', objectiveIds: ['minimum'] };
    expect(refusal(() => assertCourseRunnable(course, installed()))?.code).toBe('PUBLISH_ACTIVITY_TARGET_UNSUPPORTED');
    // A native-only runtime claim is not trusted: the installed runtime must offer the platform.
    course.activities![0]!.equivalentFallbacks = [];
    course.activities![0]!.supportedTargets.push('ios_phone', 'ipados_tablet');
    course.activities![0]!.rendererRefs.push({ target: 'ios_phone', rendererId: 'course-core-declarative-activity' }, { target: 'ipados_tablet', rendererId: 'course-core-declarative-activity' });
    expect(refusal(() => assertCourseRunnable(course, installed()))).toMatchObject({ code: 'PUBLISH_ACTIVITY_TARGET_UNSUPPORTED', details: { target: 'ios_phone' } });
  });
  it('refuses legacy activity blocks and execution adapters Core does not run', () => {
    const legacy = activityCourse();
    legacy.chapters[0]!.episodes[0]!.blocks[1] = { id: 'min-activity', type: 'activity', extensionId: 'course-core-declarative-activity', configuration: {} };
    expect(refusal(() => assertCourseRunnable(legacy, installed()))).toMatchObject({ code: 'PUBLISH_ACTIVITY_CONTRACT_REQUIRED', details: { blockId: 'min-activity' } });
    for (const executionAdapter of ['server', 'bundled_native'] as const)
      expect(refusal(() => assertCourseRunnable(activityCourse(activityDefinition({ executionAdapter })), installed()))).toMatchObject({ code: 'PUBLISH_ACTIVITY_EXECUTION_UNSUPPORTED', details: { executionAdapter } });
  });
  it('requires an installed registered evaluator when one is declared', () => {
    expect(refusal(() => assertCourseRunnable(activityCourse(), [declarativeActivityRuntime()]))?.code).toBe('PUBLISH_EVALUATOR_RUNTIME_UNAVAILABLE');
    const noPort = { ...syntheticActivityEvaluator() };
    delete noPort.activityEvaluator;
    expect(refusal(() => assertCourseRunnable(activityCourse(), [declarativeActivityRuntime(), noPort]))?.code).toBe('PUBLISH_EVALUATOR_RUNTIME_UNAVAILABLE');
    // A model-assisted definition would need human confirmation, which observations do not get.
    const course = activityCourse(activityDefinition({ evaluatorRef: 'judged' }));
    course.evaluators = [{ id: 'judged', version: '1.0.0', extensionId: evaluatorDeclaration().id, method: 'rubric_model_assisted', itemTypes: ['rubric'], humanConfirmation: 'required',
      outputs: { uncertainty: true, provenance: true }, tests: { fixtureRef: 'fixtures/judged.json', acceptsValidVariants: true, rejectsMisconceptions: true } }];
    expect(refusal(() => assertCourseRunnable(course, installed()))?.code).toBe('PUBLISH_EVALUATOR_RUNTIME_UNAVAILABLE');
    course.evaluators[0] = { ...course.evaluators[0]!, method: 'deterministic', itemTypes: ['numeric'], humanConfirmation: 'none' };
    expect(() => assertCourseRunnable(course, installed())).not.toThrow();
    // Without an evaluator the activity is practice: publishable, never evidence.
    expect(() => assertCourseRunnable(activityCourse(activityDefinition({ evaluatorRef: undefined })), [declarativeActivityRuntime()])).not.toThrow();
  });
  it('refuses required capabilities that are forbidden, unimplemented or not offered', () => {
    const withCapability = (capability: string, required = true) => activityCourse(activityDefinition({
      capabilityRequirements: [...activityDefinition().capabilityRequirements, { capability, required }] }));
    expect(refusal(() => assertCourseRunnable(withCapability('evidence.write'), installed()))).toMatchObject({ code: 'PUBLISH_CAPABILITY_FORBIDDEN', details: { capability: 'evidence.write' } });
    expect(refusal(() => assertCourseRunnable(withCapability('network.fetch'), installed()))).toMatchObject({ code: 'PUBLISH_CAPABILITY_MISSING', details: { capability: 'network.fetch' } });
    // Optional and unimplemented: publishable, simply never granted.
    expect(() => assertCourseRunnable(withCapability('network.fetch', false), installed())).not.toThrow();
    // The sandboxed runtime does not offer state.patch, which the probe requires here.
    const course = sandboxedCourse();
    course.activities![0]!.capabilityRequirements = course.activities![0]!.capabilityRequirements.map(c => ({ ...c, required: true }));
    expect(refusal(() => assertCourseRunnable(course, [declarativeActivityRuntime(), sandboxedActivityRuntime()]))).toMatchObject({ code: 'PUBLISH_CAPABILITY_MISSING', details: { capability: 'state.patch' } });
    // An activity that can never report an observation can never be completed.
    const silent = activityCourse(activityDefinition({ capabilityRequirements: [{ capability: 'state.read', required: true }] }));
    expect(refusal(() => assertCourseRunnable(silent, installed()))).toMatchObject({ code: 'PUBLISH_CAPABILITY_MISSING', details: { capability: 'observation.emit' } });
  });
  it('refuses invalid configuration, unenforceable schemas and budgets over the platform ceilings', () => {
    expect(refusal(() => assertCourseRunnable(activityCourse(activityDefinition(), { prompt: 'x', controls: [] }), installed()))?.code).toBe('PUBLISH_ACTIVITY_CONFIGURATION_INVALID');
    expect(refusal(() => assertCourseRunnable(activityCourse(activityDefinition(), { ...declarativeConfiguration(), script: 'alert(1)' }), installed()))?.code).toBe('PUBLISH_ACTIVITY_CONFIGURATION_INVALID');
    expect(refusal(() => assertCourseRunnable(activityCourse(activityDefinition({ observationSchema: { type: 'object', pattern: '.*' } })), installed())))
      .toMatchObject({ code: 'PUBLISH_ACTIVITY_SCHEMA_UNSUPPORTED', details: { schema: 'observationSchema', unsupported: ['/pattern'] } });
    const budget = { ...activityDefinition().resourceBudget, maxStateBytes: 70_000 };
    expect(refusal(() => assertCourseRunnable(activityCourse(activityDefinition({ resourceBudget: budget })), installed()))?.code).toBe('PUBLISH_ACTIVITY_BUDGET_INVALID');
  });
});

describe('capability grants', () => {
  it('grants only declared, offered and broker-implemented capabilities', () => {
    const activity = activityDefinition({ capabilityRequirements: [{ capability: 'state.read', required: true }, { capability: 'network.fetch', required: false }, { capability: 'observation.emit', required: false }] });
    expect(grantedCapabilities(activity, { capabilities: ['state.read', 'state.patch', 'observation.emit', 'network.fetch'] })).toEqual(['state.read', 'observation.emit']);
    expect(grantedCapabilities(activity, { capabilities: ['state.read'] })).toEqual(['state.read']);
  });
});

describe('declared schemas', () => {
  const schema = { type: 'object', additionalProperties: false, required: ['kind'], properties: { kind: { enum: ['submitted'] }, values: { type: 'array', maxItems: 2, items: { type: 'integer', minimum: 0 } } } };
  it('accepts the supported subset and rejects anything else', () => {
    expect(schemaIssues(schema)).toEqual([]);
    expect(schemaIssues({ type: 'object', properties: { a: { $ref: '#/x' } } })).toEqual(['/properties/a/$ref']);
    expect(schemaIssues({ type: 'decimal' })).toEqual(['/type']);
  });
  it('validates values', () => {
    expect(matchesSchema(schema, { kind: 'submitted', values: [1, 2] })).toBe(true);
    expect(matchesSchema(schema, { kind: 'submitted', values: [1, 2, 3] })).toBe(false);
    expect(matchesSchema(schema, { kind: 'submitted', values: [1.5] })).toBe(false);
    expect(matchesSchema(schema, { kind: 'other' })).toBe(false);
    expect(matchesSchema(schema, { kind: 'submitted', extra: true })).toBe(false);
    expect(matchesSchema(schema, { values: [] })).toBe(false);
  });
});

describe('declarative interpreter', () => {
  const runtime = declarativeActivityRuntime().activityRuntime!, activity = activityDefinition(), config = declarativeConfiguration();
  it('starts empty and re-checks every state patch and observation on the server', () => {
    expect(runtime.initialState(activity, config)).toEqual({ values: { value: null, sure: null } });
    expect(runtime.acceptsState!(activity, config, { values: { value: 3 } })).toBe(true);
    expect(runtime.acceptsState!(activity, config, { values: { value: 11 } })).toBe(false);
    expect(runtime.acceptsState!(activity, config, { values: { value: 2.5 } })).toBe(false);
    expect(runtime.acceptsState!(activity, config, { values: { other: 1 } })).toBe(false);
    expect(runtime.acceptsState!(activity, config, { values: {}, injected: true })).toBe(false);
    expect(runtime.acceptsObservation!(activity, config, { kind: 'submitted', values: { value: 4, sure: true } })).toBe(true);
    expect(runtime.acceptsObservation!(activity, config, { kind: 'submitted', values: { value: 4 } })).toBe(false);
    expect(runtime.acceptsObservation!(activity, config, { kind: 'passed', values: { value: 4, sure: true } })).toBe(false);
  });
});

describe('sandboxed frame', () => {
  it('serves the bootstrap and installed script under a hash-pinned, network-less, opaque-origin policy', () => {
    const script = 'document.title = "</script><b>x</b><!--";';
    const csp = frameContentSecurityPolicy(script), html = frameDocument(script, 'A <title>');
    expect(csp).toContain('sandbox allow-scripts');
    expect(csp).not.toContain('allow-same-origin');
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("frame-src 'none'");
    expect(csp).not.toContain('unsafe-inline\' \'sha');
    expect(html).toContain('<title>A &lt;title&gt;</title>');
    expect(html.match(/<script>/g)).toHaveLength(2);
    // Each inline script is exactly what the policy hash allows.
    const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]!);
    for (const body of inline) expect(csp).toContain(`'sha256-${createHash('sha256').update(body).digest('base64')}'`);
    expect(inline[0]).toBe(FRAME_BOOTSTRAP);
  });
  it('blocks WebRTC in the policy and removes its constructors before the activity script runs', () => {
    expect(frameContentSecurityPolicy('x')).toContain("webrtc 'block'");
    const posted: unknown[] = [];
    const run = (hash: string) => {
      const window: Record<string, unknown> = { RTCPeerConnection: class {}, webkitRTCPeerConnection: class {}, RTCDataChannel: class {}, RTCIceCandidate: class {},
        fetch: () => {}, addEventListener: () => {}, parent: { postMessage: (message: unknown) => posted.push(message) } };
      window.window = window;
      runInNewContext(FRAME_BOOTSTRAP, { window, location: { hash } });
      return window;
    };
    const window = run('#' + 'n'.repeat(24));
    for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel', 'RTCIceCandidate']) {
      expect(window[name], name).toBeUndefined();
      // Not restorable by the activity script.
      expect(() => { 'use strict'; window[name] = class {}; }).toThrow();
    }
    expect(typeof window.fetch).toBe('function');
    expect(posted).toEqual([{ type: 'course-activity-hello', nonce: 'n'.repeat(24) }]);
    // Without a well-formed nonce the bootstrap never says hello, so it never receives a port.
    run('#short');
    run('');
    expect(posted).toHaveLength(1);
  });
  it('refuses a sandboxed runtime that would serve its current script for a prior build', () => {
    const prior = { ...sandboxedActivityRuntime(), acceptedPriorBuilds: [{ version: '0.9.0', integrity: 'sha256-' + '2'.repeat(64) }] };
    expect(() => assertInstalledActivityRuntimes([prior])).toThrow(/prior builds/);
    // Even unchecked, a declaration of the prior build does not resolve to the current script.
    const course = sandboxedCourse();
    const declaration = course.extensions.find(e => e.id === prior.id)!;
    Object.assign(declaration, prior.acceptedPriorBuilds[0]);
    expect(refusal(() => assertCourseRunnable(course, [declarativeActivityRuntime(), prior]))?.code).toBe('PUBLISH_ACTIVITY_TARGET_UNSUPPORTED');
  });
  it('refuses an installed sandboxed runtime whose script does not match its integrity', () => {
    expect(() => assertInstalledActivityRuntimes([sandboxedActivityRuntime()])).not.toThrow();
    expect(() => assertInstalledActivityRuntimes([{ ...sandboxedActivityRuntime(), integrity: 'sha256-' + '1'.repeat(64) }])).toThrow(/integrity/);
  });
});
