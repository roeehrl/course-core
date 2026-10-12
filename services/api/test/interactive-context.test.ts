import { beforeAll, describe, expect, it } from 'vitest';
import { compileCourse } from '@course-core/sdk/compiler';
import { fromVisualExperience, toVisualExperience, VisualRuntime } from '@course-core/visuals/headless';
import { resolveInteractiveContext, type VisualInteractionContext } from '../src/interactive-context.js';
import { svgRenderer } from '../src/svg-renderer.js';
import type { RuntimeExtension } from '../src/publication.js';
import type { EnrollmentContext } from '../src/repository.js';
import { fixture } from './fixture.js';
// Test-only shared public fixture: exercises the learner's installed SDK adapter
// against the API's actual installed renderer, without app-source dependencies.
import { visualContextFixture } from '../../../apps/learner/tests/visualContext.fixture.js';

let renderer: RuntimeExtension;
beforeAll(async () => { renderer = await svgRenderer(); });
function setup(changeScene?: (scene: ReturnType<typeof fromVisualExperience>) => void) {
  let visual = visualContextFixture();
  if (changeScene) { const scene = structuredClone(fromVisualExperience(visual)); changeScene(scene); visual = toVisualExperience(scene); }
  const course = fixture();
  course.chapters[0]!.episodes[0]!.id = 'lesson-one';
  course.visuals.push(visual);
  course.chapters[0]!.episodes[0]!.blocks.push({ id: 'diagram-one', type: 'visual', visualId: visual.id });
  course.extensions.push({ id: renderer.id, version: renderer.version, integrity: renderer.integrity, execution: 'declarative', entrypoint: 'renderers/svg-v1.js', platforms: ['web'], capabilities: ['visual.render'], accessibility: { keyboard: true, reducedMotion: true, textAlternative: visual.accessibility.description } });
  const compiled = compileCourse(course);
  const enrollment: EnrollmentContext = {
    enrollment: { id: 'enrollment', workspace_id: 'workspace', user_id: 'learner', status: 'active', revision: 1, profile: {}, profile_revision: 1, policy_revision: 1, policy: course.policy, started_at: new Date(0), course_release_id: 'release' },
    release: { id: 'release', workspace_id: 'workspace', digest: compiled.digest, server_bundle: compiled.server, learner_bundle: compiled.learner, status: 'published' },
    progress: [], evidence: [],
  };
  const scene = fromVisualExperience(visual), runtime = new VisualRuntime(scene);
  const input: VisualInteractionContext = { schemaVersion: 1, sceneVersion: 1, episodeId: 'lesson-one', blockId: 'diagram-one', visualId: visual.id, rendererId: visual.rendererId, sceneFingerprint: runtime.exportReplay().sceneFingerprint, state: runtime.getSnapshot().frame.state, timeMs: 500, layout: 'compact', reducedMotion: false };
  const options = { enrollment, scope: { episodeId: 'lesson-one', blockId: 'diagram-one' }, installedExtensions: [renderer], input };
  return { options, input, scene: structuredClone(scene), enrollment };
}

describe('enrolled interactive visual context', () => {
  it('recomputes actual declared state and returns a small attributed readout without credit or mutation', () => {
    const { options, enrollment } = setup();
    const before = structuredClone(enrollment);
    options.input.state = { amount: 4, mode: 'square', enabled: true };
    const result = resolveInteractiveContext(options);
    expect(result).toMatchObject({ kind: 'visual', provenance: 'learner-reported-state', authority: 'context-only', source: { episodeId: 'lesson-one', episodeTitle: 'Minimum', blockId: 'diagram-one', visualId: 'context-study', visualTitle: 'A measured change' }, renderer: { integrity: renderer.integrity }, timeMs: 500, layout: 'compact', reducedMotion: false, cue: 'Explore the second half.', readout: ['Value = 16'], truncated: false });
    expect(result.settings).toContainEqual({ key: 'amount', label: 'Amount', value: 4 });
    expect(result).not.toHaveProperty('nodes'); expect(result).not.toHaveProperty('scene');
    expect(result).not.toHaveProperty('evidence'); expect(result).not.toHaveProperty('passed');
    expect(enrollment).toEqual(before);
  });
  it('applies a reported simulation state at the requested time, without evolving it twice', () => {
    const { options } = setup(scene => { scene.simulation = { seed: 42, stepMs: 100, updates: { amount: { op: 'min', args: [10, { op: 'add', args: [{ state: 'amount' }, 1] }] } } }; });
    options.input.state = { amount: 3, mode: 'square', enabled: true };
    expect(resolveInteractiveContext(options).readout).toEqual(['Value = 9']);
  });
  it('recomputes a manually sought still frame while reduced motion is enabled', () => {
    const { options } = setup(); options.input.reducedMotion = true; options.input.timeMs = 200;
    expect(resolveInteractiveContext(options)).toMatchObject({ timeMs: 200, reducedMotion: true, cue: 'Observe the starting value.' });
  });
  it('supports a declared scene with no state fields', () => {
    const { options } = setup(scene => { scene.state = {}; scene.controls = []; scene.nodes = [{ kind: 'text', id: 'static', text: 'A still observation.', x: 10, y: 30 }]; scene.timeline.tracks = []; });
    expect(resolveInteractiveContext(options).settings).toEqual([]);
  });
  it('omits hidden readouts and bounds semantic text instead of returning geometry', () => {
    const { options } = setup(scene => { scene.nodes.push({ kind: 'group', id: 'hidden', opacity: 0, children: [{ kind: 'text', id: 'hidden-result', text: 'Not visible in this view', x: 0, y: 0 }] }, ...Array.from({ length: 40 }, (_, i) => ({ kind: 'text' as const, id: `extra-${i}`, text: `Long readout ${i} ${'x'.repeat(300)}`, x: 10, y: 50 }))); });
    const result = resolveInteractiveContext(options);
    expect(result.readout.join('')).not.toContain('Not visible');
    expect(result.readout.length).toBeLessThanOrEqual(24);
    expect(result.readout.join('').length).toBeLessThanOrEqual(2400);
    expect(result.truncated).toBe(true);
  });
  it.each([
    ['unknown state', (p: any) => { p.state = { ...p.state, surprise: 1 }; }],
    ['missing state', (p: any) => { p.state = { amount: 2 }; }],
    ['range high', (p: any) => { p.state.amount = 11; }],
    ['range low', (p: any) => { p.state.amount = -1; }],
    ['NaN', (p: any) => { p.state.amount = NaN; }],
    ['Infinity', (p: any) => { p.state.amount = Infinity; }],
    ['numeric string', (p: any) => { p.state.amount = '2'; }],
    ['boolean string', (p: any) => { p.state.enabled = 'true'; }],
    ['unknown enum', (p: any) => { p.state.mode = 'javascript:alert(1)'; }],
    ['nested state', (p: any) => { p.state.mode = { script: 'bad()' }; }],
    ['array state', (p: any) => { p.state = []; }],
    ['non-finite time', (p: any) => { p.timeMs = Infinity; }],
    ['negative time', (p: any) => { p.timeMs = -1; }],
    ['past duration', (p: any) => { p.timeMs = 1001; }],
    ['unbounded viewport', (p: any) => { p.layout = 'custom'; }],
    ['wrong wire version', (p: any) => { p.schemaVersion = 2; }],
    ['wrong scene version', (p: any) => { p.sceneVersion = 2; }],
    ['client readout', (p: any) => { p.readout = ['Passed']; }],
    ['script', (p: any) => { p.script = 'bad()'; }],
    ['URL', (p: any) => { p.url = 'https://untrusted.invalid'; }],
    ['client scene', (p: any) => { p.scene = {}; }],
    ['replay', (p: any) => { p.replay = { events: [] }; }],
    ['seed', (p: any) => { p.seed = 99; }],
    ['oversized enum', (p: any) => { p.state.mode = 'x'.repeat(17000); }],
    ['prototype pollution', (p: any) => { p.state = JSON.parse('{"amount":2,"enabled":true,"mode":"linear","__proto__":{}}'); }],
  ])('rejects %s', (_name, mutate) => {
    const { options } = setup(); options.input = structuredClone(options.input); mutate(options.input);
    expect(() => resolveInteractiveContext(options)).toThrowError(/INTERACTIVE_CONTEXT_INVALID/);
  });
  it('rejects accessors without invoking them', () => {
    const { options } = setup(); let invoked = false;
    Object.defineProperty(options.input, 'state', { enumerable: true, get() { invoked = true; throw new Error('must not run'); } });
    expect(() => resolveInteractiveContext(options)).toThrowError(/INTERACTIVE_CONTEXT_INVALID/);
    expect(invoked).toBe(false);
  });
  it.each(['episodeId', 'blockId', 'visualId'] as const)('rejects a different source %s', key => {
    const { options } = setup(); options.input[key] = 'another-asset';
    expect(() => resolveInteractiveContext(options)).toThrowError(/INTERACTIVE_CONTEXT_OUT_OF_SCOPE/);
  });
  it('cannot select another valid asset in the same enrolled course', () => {
    const { options, scene } = setup(); scene.id = 'other-visual';
    options.enrollment.release.server_bundle.visuals.push(toVisualExperience(scene));
    options.input.visualId = scene.id;
    expect(() => resolveInteractiveContext(options)).toThrowError(/INTERACTIVE_CONTEXT_OUT_OF_SCOPE/);
  });
  it('cannot use a non-visual block or a locked episode', () => {
    const { options } = setup(); options.scope.blockId = options.input.blockId = 'min-text';
    expect(() => resolveInteractiveContext(options)).toThrowError(/INTERACTIVE_CONTEXT_OUT_OF_SCOPE/);
    options.scope.episodeId = options.input.episodeId = 'max';
    expect(() => resolveInteractiveContext(options)).toThrowError(/PREREQUISITE_NOT_READY/);
  });
  it('rejects the current locked episode even when its requested visual binding is real', () => {
    const { options } = setup();
    options.enrollment.release.server_bundle.chapters[0]!.episodes[1]!.blocks.push({ id: 'locked-diagram', type: 'visual', visualId: options.input.visualId });
    options.scope = { episodeId: 'max', blockId: 'locked-diagram' };
    options.input.episodeId = 'max'; options.input.blockId = 'locked-diagram';
    const before = structuredClone(options.enrollment);
    expect(() => resolveInteractiveContext(options)).toThrowError(/PREREQUISITE_NOT_READY/);
    expect(options.enrollment).toEqual(before);
  });
  it.each(['evidence', 'passed', 'grade', 'independent', 'completedBlockIds', 'providerContext', 'courseDigest'])('rejects an evidence canary in client %s without any authority mutation', field => {
    const { options } = setup(); const before = structuredClone(options.enrollment);
    const input = { ...options.input, [field]: { marker: 'CLIENT_EVIDENCE_CANARY_DO_NOT_FORWARD', passed: true, independent: true } };
    expect(() => resolveInteractiveContext({ ...options, input })).toThrowError(/INTERACTIVE_CONTEXT_INVALID/);
    expect(options.enrollment).toEqual(before);
    const accepted = resolveInteractiveContext(options);
    expect(JSON.stringify(accepted)).not.toContain('CLIENT_EVIDENCE_CANARY_DO_NOT_FORWARD');
    expect(accepted.authority).toBe('context-only');
    expect(accepted.provenance).toBe('learner-reported-state');
    expect(accepted).not.toHaveProperty('evidence');
  });
  it('rejects an old fingerprint when the enrolled scene changed under the same ID', () => {
    const { options, scene } = setup(); scene.title = 'Changed authored scene';
    options.enrollment.release.server_bundle.visuals[0] = toVisualExperience(scene);
    expect(() => resolveInteractiveContext(options)).toThrowError(/INTERACTIVE_CONTEXT_STALE/);
  });
  it.each(['missing', 'integrity', 'version', 'capability', 'platform', 'validator', 'invalid-asset', 'unknown-renderer'] as const)('requires the actual registered renderer: %s', reason => {
    const { options } = setup();
    if (reason === 'missing') options.installedExtensions = [];
    else if (reason === 'integrity') options.installedExtensions = [{ ...renderer, integrity: 'sha256-' + '0'.repeat(64) }];
    else if (reason === 'version') options.installedExtensions = [{ ...renderer, version: '9.0.0' }];
    else if (reason === 'capability') options.installedExtensions = [{ ...renderer, capabilities: [] }];
    else if (reason === 'platform') options.installedExtensions = [{ ...renderer, platforms: ['native'] }];
    else if (reason === 'validator') { const { validateVisual: _, ...rest } = renderer; options.installedExtensions = [rest]; }
    else if (reason === 'invalid-asset') options.enrollment.release.server_bundle.visuals[0]!.scene = { script: 'bad()' };
    else options.input.rendererId = 'unknown-renderer';
    expect(() => resolveInteractiveContext(options)).toThrowError(/INTERACTIVE_RENDERER_UNAVAILABLE/);
  });
  it('fails closed when a valid-range state makes an authored expression undefined', () => {
    const { options } = setup(scene => { scene.nodes[0]!.width = { op: 'div', args: [1, { state: 'amount' }] }; });
    options.input.state = { amount: 0, enabled: true, mode: 'linear' };
    expect(() => resolveInteractiveContext(options)).toThrowError(/INTERACTIVE_CONTEXT_INVALID/);
  });
});
