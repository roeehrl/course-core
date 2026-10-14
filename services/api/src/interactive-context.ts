import type { EnrollmentContext } from './repository.js';
import type { RuntimeExtension } from './publication.js';
import { ApiError } from './errors.js';
import { declarationMatchesInstalled } from './extension-identity.js';
import { requireAvailable } from './learning.js';
import { fromVisualExperience, VisualRuntime, flattenNodes, RENDERER_ID, type Value } from '@course-core/visuals/headless';

/** Mirrors VisualBlock's transport type. It deliberately accepts no scene,
 * replay, seed, readout, URL, extension declaration, grade or evidence field. */
export interface VisualInteractionContext {
  schemaVersion: 1;
  sceneVersion: 1;
  episodeId: string;
  blockId: string;
  visualId: string;
  rendererId: string;
  sceneFingerprint: string;
  state: Readonly<Record<string, Value>>;
  timeMs: number;
  layout: 'compact' | 'expanded';
  reducedMotion: boolean;
}

export interface SemanticVisualContext {
  kind: 'visual';
  provenance: 'learner-reported-state';
  authority: 'context-only';
  source: { courseDigest: string; episodeId: string; episodeTitle: string; blockId: string; visualId: string; visualTitle: string };
  renderer: { id: string; version: string; integrity: string };
  sceneFingerprint: string;
  sceneVersion: 1;
  timeMs: number;
  layout: 'compact' | 'expanded';
  reducedMotion: boolean;
  settings: { key: string; label: string; value: Value }[];
  cue: string;
  readout: string[];
  truncated: boolean;
}

export const MAX_INTERACTIVE_CONTEXT_BYTES = 16384;
const allowedKeys = ['schemaVersion', 'sceneVersion', 'episodeId', 'blockId', 'visualId', 'rendererId', 'sceneFingerprint', 'state', 'timeMs', 'layout', 'reducedMotion'];
const sdkId = /^[a-z][a-z0-9._:-]{0,127}$/;
function fail(code = 'INTERACTIVE_CONTEXT_INVALID', status = 400): never { throw new ApiError(status, code); }

/** Reject accessors/prototypes before inspecting values. HTTP JSON is plain
 * data; this also keeps direct helper calls from invoking object getters. */
function record(value: unknown, maxKeys: number): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail();
  const keys = Reflect.ownKeys(value);
  if (keys.length > maxKeys) fail();
  for (const key of keys) {
    if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key)) fail();
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!('value' in descriptor) || !descriptor.enumerable) fail();
  }
  return value as Record<string, unknown>;
}

/** Pure context resolver, with no persistence/provider calls or evidence writes.
 * Caller supplies the enrollment loaded by authenticated loadEnrollment, the
 * outer companion request's authorized current lesson/block, and the server's
 * installed renderer registry. Caller still enforces policy/access windows and
 * assessment-help consent in the existing command transaction.
 *
 * The replay fingerprint is a stale-scene marker, NOT a signature. Authorization
 * comes from enrollment scope and the matching trusted renderer registration.
 * Even a correctly recomputed frame is only a learner-reported exploration. */
export function resolveInteractiveContext(options: {
  input: unknown;
  enrollment: EnrollmentContext;
  scope: { episodeId: string; blockId: string };
  installedExtensions: readonly RuntimeExtension[];
}): SemanticVisualContext {
  const input = record(options.input, allowedKeys.length);
  if (Object.keys(input).length !== allowedKeys.length || allowedKeys.some(key => !Object.hasOwn(input, key))) fail();
  if (input.schemaVersion !== 1 || input.sceneVersion !== 1) fail();
  for (const key of ['episodeId', 'blockId', 'visualId', 'rendererId']) if (typeof input[key] !== 'string' || !sdkId.test(input[key])) fail();
  if (typeof input.sceneFingerprint !== 'string' || !/^\d{1,7}-[a-f0-9]{1,8}-[a-f0-9]{1,8}$/.test(input.sceneFingerprint)) fail();
  if (typeof input.timeMs !== 'number' || !Number.isFinite(input.timeMs) || input.timeMs < 0 || input.timeMs > 120000
      || !['compact', 'expanded'].includes(input.layout as string) || typeof input.reducedMotion !== 'boolean') fail();
  const state = record(input.state, 64);
  for (const value of Object.values(state)) {
    if (typeof value === 'number' ? !Number.isFinite(value) : typeof value === 'string' ? value.length > 2048 : typeof value !== 'boolean') fail();
  }
  if (Buffer.byteLength(JSON.stringify(input), 'utf8') > MAX_INTERACTIVE_CONTEXT_BYTES) fail();
  if (input.episodeId !== options.scope.episodeId || input.blockId !== options.scope.blockId) fail('INTERACTIVE_CONTEXT_OUT_OF_SCOPE');
  const { release, progress, evidence } = options.enrollment;
  const course = release.server_bundle;
  const episode = requireAvailable(course, release.digest, progress, evidence, options.scope.episodeId);
  const block = episode.blocks.find(block => block.id === options.scope.blockId);
  if (!block || block.type !== 'visual' || block.visualId !== input.visualId) fail('INTERACTIVE_CONTEXT_OUT_OF_SCOPE');
  const visuals = course.visuals.filter(visual => visual.id === block.visualId);
  if (visuals.length !== 1) fail('INTERACTIVE_CONTEXT_OUT_OF_SCOPE');
  const visual = visuals[0]!;
  if (visual.rendererId !== input.rendererId || visual.rendererId !== RENDERER_ID) fail('INTERACTIVE_RENDERER_UNAVAILABLE', 409);
  const declarations = course.extensions.filter(row => row.id === visual.rendererId);
  const adapters = options.installedExtensions.filter(row => row.id === visual.rendererId);
  const declaration = declarations[0], adapter = adapters[0];
  if (declarations.length !== 1 || adapters.length !== 1 || !declaration || !adapter
      || !declarationMatchesInstalled(declaration, adapter)
      || declaration.execution !== 'declarative' || !declaration.platforms.includes('web') || !adapter.platforms.includes('web')
      || !declaration.capabilities.includes('visual.render') || !adapter.capabilities.includes('visual.render') || !adapter.validateVisual) fail('INTERACTIVE_RENDERER_UNAVAILABLE', 409);
  let scene;
  try { adapter.validateVisual(visual); scene = fromVisualExperience(visual); }
  catch { fail('INTERACTIVE_RENDERER_UNAVAILABLE', 409); }
  const expectedKeys = Object.keys(scene.state);
  if (expectedKeys.length !== Object.keys(state).length || expectedKeys.some(key => !Object.hasOwn(state, key))) fail();
  if (input.timeMs > scene.timeline.durationMs) fail(); // Never silently clamp client time.
  const viewportWidth = input.layout === 'compact' ? 1 : 100000;
  let runtime;
  try { runtime = new VisualRuntime(scene, { viewportWidth, reducedMotion: input.reducedMotion }); }
  catch { fail('INTERACTIVE_RENDERER_UNAVAILABLE', 409); }
  if (input.sceneFingerprint !== runtime.exportReplay().sceneFingerprint) fail('INTERACTIVE_CONTEXT_STALE', 409);
  try {
    runtime.seek(input.timeMs);
    // This is the reported state AT timeMs, not an initial state to evolve a
    // second time. The authored simulation/seed and geometry remain server-owned.
    if (expectedKeys.length) runtime.setState(state as Record<string, Value>);
  } catch { fail(); }
  const frame = runtime.getSnapshot().frame;
  let truncated = false;
  const clip = (value: string, limit: number) => {
    const clean = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
    if (clean.length <= limit) return clean;
    truncated = true; return clean.slice(0, limit - 1) + '…';
  };
  const readout: string[] = [], seen = new Set<string>();
  let remaining = 2400;
  for (const node of flattenNodes(frame.nodes)) {
    if (node.kind !== 'text' || !node.visible || node.opacity <= 0 || !node.text?.trim()) continue;
    const value = clip(node.text, 180);
    if (seen.has(value)) continue;
    if (readout.length >= 24 || value.length > remaining) { truncated = true; continue; }
    seen.add(value); remaining -= value.length; readout.push(value);
  }
  const result: SemanticVisualContext = {
    kind: 'visual', provenance: 'learner-reported-state', authority: 'context-only',
    source: { courseDigest: release.digest, episodeId: episode.id, episodeTitle: clip(episode.title, 160), blockId: block.id, visualId: visual.id, visualTitle: clip(scene.title, 160) },
    renderer: { id: adapter.id, version: adapter.version, integrity: adapter.integrity },
    sceneFingerprint: runtime.exportReplay().sceneFingerprint, sceneVersion: scene.version,
    timeMs: frame.timeMs, layout: frame.layout, reducedMotion: frame.reducedMotion,
    settings: expectedKeys.map(key => ({ key, label: clip(scene.state[key]!.label, 120), value: frame.state[key]! })),
    cue: clip(frame.cue, 400), readout, truncated: false,
  };
  result.truncated = truncated;
  return result;
}
