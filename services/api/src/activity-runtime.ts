import { createHash } from 'node:crypto';
import type { ActivityDefinition, ContentBlock, CourseManifest, Episode, ExtensionManifest, Json, Platform, PlatformTarget } from '@course-core/sdk';
import { FORBIDDEN_CAPABILITIES, MAX_EVENT_BYTES, MAX_STATE_BYTES, PLATFORM_TARGETS, targetsForPlatforms } from '@course-core/sdk';
import { ApiError } from './errors.js';
import { declarationMatchesInstalled } from './extension-identity.js';
import type { RuntimeExtension } from './publication.js';

/**
 * Activity runtime (SDK 0.5 activities, audit #14). Core runs two execution adapters:
 *
 * - declarative: Core's own interpreter renders author data (no course code runs anywhere);
 * - sandboxed_web: an installed extension's script runs in an iframe with an opaque origin
 *   (sandbox="allow-scripts", never allow-same-origin). Its CSP blocks fetch/XHR/WebSocket/beacons
 *   (connect-src), subresources, nested frames, workers, plugins and form submission. Two routes
 *   CSP does not cover are closed by the frame bootstrap before the activity script runs: WebRTC
 *   (its constructors are removed) and network hints (WebKit preconnects to, and may resolve,
 *   <link rel=preconnect|dns-prefetch> hosts despite default-src 'none'; the bootstrap keeps such
 *   links, and nested documents, from ever entering the document). Navigating the frame elsewhere
 *   is stopped by the learner page's own CSP (frame-src 'self' and youtube-nocookie.com, also
 *   re-checked on redirect), so these guarantees need the learner app served with Core's CSP.
 *   What remains (navigation to Core's origin or youtube-nocookie.com, learner paste into editable
 *   regions, unobservable dns-prefetch) is listed in README "Activity runtime". Activity state
 *   must never hold anything sensitive.
 *
 * Either way the activity can only act through the capability broker, which grants the
 * capabilities the activity declared, the installed runtime offers and Core implements, and
 * denies every other request. Observations reach evidence only through a registered evaluator.
 */

/** What the broker implements. Every other capability is denied, declared or not. */
export const BROKER_CAPABILITIES: ReadonlySet<string> = new Set(['state.read', 'state.patch', 'observation.emit']);
export const ACTIVITY_EXECUTIONS = ['declarative', 'sandboxed_web'] as const;
export type ActivityExecution = typeof ACTIVITY_EXECUTIONS[number];
export type ActivityBlock = Extract<ContentBlock, { type: 'activity'; activityId: string }>;
type JsonObject = { [key: string]: Json };

/** The runtime half of an installed extension that renders activities. */
export interface ActivityRuntimePort {
  kind: ActivityExecution;
  /** Publication check of one activity block's configuration. Throws to refuse. */
  validateActivity(activity: ActivityDefinition, configuration: JsonObject): void;
  /** State of a new instance. */
  initialState(activity: ActivityDefinition, configuration: JsonObject): JsonObject;
  /** Server-side checks beyond the declared JSON schemas; return false to refuse. */
  acceptsState?(activity: ActivityDefinition, configuration: JsonObject, state: JsonObject): boolean;
  acceptsObservation?(activity: ActivityDefinition, configuration: JsonObject, observation: JsonObject): boolean;
  /** sandboxed_web only: the script Core serves inside the sandboxed frame. Its sha256 is the
   * installed integrity, so a course declaration pins these exact bytes. */
  frameScript?: string;
}
export interface ActivityEvaluation { passed: boolean; objectiveIds: string[]; explanation?: string }
/** Effective values of one course admin section for the enrollment being evaluated. */
export type AdminSettingValues = Readonly<Record<string, boolean | number | string>>;
/** A registered (installed, trusted) evaluator of activity observations. */
export interface ActivityEvaluatorPort {
  /** `course` is the enrollment's own course version (server bundle). `evaluatorId` is the course's
   * evaluator definition id (absent for a bare extension reference). `settings` reads the effective
   * values (enrollment, chapter or course scope, else the declared default) of one of the course's
   * own admin sections for this enrollment, or null when the course declares no such section. */
  evaluate(input: { activity: ActivityDefinition; configuration: JsonObject; observation: JsonObject; state: JsonObject;
    course?: CourseManifest; evaluatorId?: string; settings?: (sectionId: string) => Promise<AdminSettingValues | null> }): Promise<ActivityEvaluation>;
  /** Publication check of one activity block against what this evaluator needs. Throws to refuse. */
  validateActivity?(input: { course: CourseManifest; activity: ActivityDefinition; configuration: JsonObject; evaluatorId?: string }): void;
}

export const frameScriptIntegrity = (script: string) => 'sha256-' + createHash('sha256').update(script, 'utf8').digest('hex');
/** Installed sandboxed runtimes must identify exactly the script they serve. */
export function assertInstalledActivityRuntimes(installed: readonly RuntimeExtension[]) {
  for (const extension of installed) {
    const runtime = extension.activityRuntime;
    if (!runtime) continue;
    if (runtime.kind === 'sandboxed_web' && (!runtime.frameScript || frameScriptIntegrity(runtime.frameScript) !== extension.integrity))
      throw new Error(`Installed activity runtime ${extension.id} does not match its integrity.`);
    // A prior build's declaration would be served the current script: only the exact bytes count.
    if (runtime.kind === 'sandboxed_web' && extension.acceptedPriorBuilds?.length)
      throw new Error(`Sandboxed activity runtime ${extension.id} cannot accept prior builds.`);
    if (runtime.kind === 'declarative' && runtime.frameScript !== undefined) throw new Error(`Declarative runtime ${extension.id} cannot serve code.`);
  }
}

const platformOf = (target: PlatformTarget): Platform =>
  (Object.keys(PLATFORM_TARGETS) as Platform[]).find(platform => PLATFORM_TARGETS[platform].includes(target))!;
export const courseTargets = (course: CourseManifest): PlatformTarget[] => targetsForPlatforms(course.platforms);
export const activityBlocks = (episode: Episode) => episode.blocks.filter((block): block is Extract<ContentBlock, { type: 'activity' }> => block.type === 'activity');
export const isContractBlock = (block: Extract<ContentBlock, { type: 'activity' }>): block is ActivityBlock => 'activityId' in block;
export const blockConfiguration = (block: ActivityBlock): JsonObject => (block.configuration ?? {}) as JsonObject;
export function activityOf(course: CourseManifest, block: ActivityBlock) {
  return course.activities?.find(activity => activity.id === block.activityId);
}
/** A renderer reference names a renderer definition (whose extension runs it) or an extension. */
export const rendererExtensionId = (course: CourseManifest, rendererId: string) => course.renderers?.find(r => r.id === rendererId)?.extensionId ?? rendererId;

export type ResolvedActivity =
  | { mode: 'run'; target: PlatformTarget; rendererId: string; extension: RuntimeExtension; declaration: ExtensionManifest; runtime: ActivityRuntimePort; granted: string[] }
  | { mode: 'fallback'; target: PlatformTarget; fallback: ActivityDefinition['equivalentFallbacks'][number] };

/** How this host runs an activity on one target, or the author's objective-equivalent fallback.
 * Null when the target is supported in the contract but this host cannot run it. */
export function resolveActivity(course: CourseManifest, activity: ActivityDefinition, target: PlatformTarget, installed: readonly RuntimeExtension[]): ResolvedActivity | null {
  if (!activity.supportedTargets.includes(target)) {
    const fallback = activity.equivalentFallbacks.find(row => row.target === target);
    return fallback ? { mode: 'fallback', target, fallback } : null;
  }
  const rendererId = activity.rendererRefs.find(ref => ref.target === target)?.rendererId;
  if (!rendererId || !(ACTIVITY_EXECUTIONS as readonly string[]).includes(activity.executionAdapter)) return null;
  const id = rendererExtensionId(course, rendererId);
  const declaration = course.extensions.find(row => row.id === id), extension = installed.find(row => row.id === id);
  const runtime = extension?.activityRuntime;
  if (!declaration || !extension || !runtime || !declarationMatchesInstalled(declaration, extension)) return null;
  // Served code must be exactly the declared build, never one accepted as a prior build.
  if (runtime.kind === 'sandboxed_web' && (declaration.integrity !== extension.integrity || declaration.version !== extension.version)) return null;
  if (declaration.execution !== activity.executionAdapter || runtime.kind !== activity.executionAdapter) return null;
  if (!extension.platforms.includes(platformOf(target)) || !declaration.platforms.includes(platformOf(target))) return null;
  return { mode: 'run', target, rendererId, extension, declaration, runtime, granted: grantedCapabilities(activity, extension) };
}
/** Declared by the activity (required or optional), offered by the installed runtime and
 * implemented by the broker. Nothing else is ever granted. */
export function grantedCapabilities(activity: ActivityDefinition, extension: Pick<RuntimeExtension, 'capabilities'>) {
  return activity.capabilityRequirements.map(row => row.capability)
    .filter(capability => BROKER_CAPABILITIES.has(capability) && !FORBIDDEN_CAPABILITIES.has(capability) && extension.capabilities.includes(capability));
}

/** Evaluator resolution: a 0.5 evaluator definition (by its extension) or, for compatibility, an extension id. */
export function activityEvaluator(course: CourseManifest, activity: ActivityDefinition, installed: readonly RuntimeExtension[]) {
  if (!activity.evaluatorRef) return null;
  const definition = course.evaluators?.find(row => row.id === activity.evaluatorRef);
  // Observations are judged without a human in the loop here, so only evaluators that need no
  // confirmation qualify; model-assisted judgments need the review protocol instead.
  if (definition && (definition.humanConfirmation !== 'none' || !['deterministic', 'code_tests', 'external'].includes(definition.method))) return undefined;
  const extensionId = definition?.extensionId ?? activity.evaluatorRef;
  const declaration = course.extensions.find(row => row.id === extensionId), extension = installed.find(row => row.id === extensionId);
  if (!declaration || !extension?.activityEvaluator || !declarationMatchesInstalled(declaration, extension) || !extension.capabilities.includes('assessment.evaluate')) return undefined;
  return { ref: `${definition?.id ?? extensionId}@${definition?.version ?? extension.version}`, extension, evaluator: extension.activityEvaluator,
    ...(definition ? { evaluatorId: definition.id } : {}) };
}

const refuse = (code: string, details: Record<string, unknown>) => new ApiError(409, code, code, details);

/**
 * Publication check for every activity block (replaces the earlier blanket refusal). Every
 * declared course target must be runnable here or have a valid objective-equivalent fallback (U06);
 * required capabilities must be implemented and offered; an evaluator must be installed.
 */
export function assertActivitiesRunnable(course: CourseManifest, installed: readonly RuntimeExtension[]) {
  const targets = courseTargets(course);
  const textBlocks = new Set(course.chapters.flatMap(c => c.episodes.flatMap(e => e.blocks.filter(b => b.type === 'text').map(b => b.id))));
  for (const chapter of course.chapters) for (const episode of chapter.episodes) for (const block of activityBlocks(episode)) {
    // A 0.4 extension-backed block has none of the nine platform fields (targets, fallbacks, budget...).
    if (!isContractBlock(block)) throw refuse('PUBLISH_ACTIVITY_CONTRACT_REQUIRED', { blockId: block.id });
    const activity = activityOf(course, block);
    if (!activity) throw refuse('PUBLISH_ACTIVITY_CONTRACT_REQUIRED', { blockId: block.id });
    const at = { activityId: activity.id, blockId: block.id };
    if (!(ACTIVITY_EXECUTIONS as readonly string[]).includes(activity.executionAdapter))
      throw refuse('PUBLISH_ACTIVITY_EXECUTION_UNSUPPORTED', { ...at, executionAdapter: activity.executionAdapter, supported: [...ACTIVITY_EXECUTIONS] });
    const budget = activity.resourceBudget;
    if (budget.maxStateBytes > MAX_STATE_BYTES || budget.maxEventBytes > MAX_EVENT_BYTES || budget.maxEventsPerMinute < 1) throw refuse('PUBLISH_ACTIVITY_BUDGET_INVALID', at);
    for (const [name, schema] of [['stateSchema', activity.stateSchema], ['observationSchema', activity.observationSchema]] as const)
      if (schema !== undefined && schemaIssues(schema).length) throw refuse('PUBLISH_ACTIVITY_SCHEMA_UNSUPPORTED', { ...at, schema: name, unsupported: schemaIssues(schema).slice(0, 5) });
    for (const requirement of activity.capabilityRequirements)
      if (FORBIDDEN_CAPABILITIES.has(requirement.capability)) throw refuse('PUBLISH_CAPABILITY_FORBIDDEN', { ...at, capability: requirement.capability });
    const runtimes: Extract<ResolvedActivity, { mode: 'run' }>[] = [];
    for (const target of targets) {
      const resolved = resolveActivity(course, activity, target, installed);
      if (!resolved) throw refuse('PUBLISH_ACTIVITY_TARGET_UNSUPPORTED', { ...at, target });
      if (resolved.mode === 'fallback') {
        if (!fallbackRunnable(course, activity, resolved.fallback, textBlocks, installed)) throw refuse('PUBLISH_ACTIVITY_TARGET_UNSUPPORTED', { ...at, target, fallback: resolved.fallback.ref });
        continue;
      }
      runtimes.push(resolved);
    }
    for (const resolved of runtimes) {
      for (const requirement of activity.capabilityRequirements)
        if (requirement.required && !resolved.granted.includes(requirement.capability)) throw refuse('PUBLISH_CAPABILITY_MISSING', { ...at, target: resolved.target, capability: requirement.capability });
      // Completion and evaluation both depend on an observation reaching the server.
      if (!resolved.granted.includes('observation.emit')) throw refuse('PUBLISH_CAPABILITY_MISSING', { ...at, target: resolved.target, capability: 'observation.emit' });
      try { resolved.runtime.validateActivity(activity, blockConfiguration(block)); }
      catch { throw refuse('PUBLISH_ACTIVITY_CONFIGURATION_INVALID', at); }
    }
    if (activity.evaluatorRef === undefined) continue;
    const registered = activityEvaluator(course, activity, installed);
    if (!registered) throw refuse('PUBLISH_EVALUATOR_RUNTIME_UNAVAILABLE', at);
    try { registered.evaluator.validateActivity?.({ course, activity, configuration: blockConfiguration(block), ...(registered.evaluatorId ? { evaluatorId: registered.evaluatorId } : {}) }); }
    catch (error) {
      throw refuse('PUBLISH_EVALUATOR_CONFIGURATION_INVALID', { ...at, ...(error instanceof ApiError ? error.details : {}) });
    }
  }
}
function fallbackRunnable(course: CourseManifest, activity: ActivityDefinition, fallback: ActivityDefinition['equivalentFallbacks'][number], textBlocks: Set<string>, installed: readonly RuntimeExtension[]) {
  // Objective equivalence is validated by the SDK at import; re-check it here, cheaply.
  if (activity.objectiveIds.some(o => !fallback.objectiveIds.includes(o))) return false;
  if (fallback.kind === 'text_block') return textBlocks.has(fallback.ref);
  if (fallback.kind === 'assessment') {
    const item = course.assessments.find(row => row.id === fallback.ref);
    return Boolean(item && fallback.objectiveIds.every(o => item.objectiveIds.includes(o)));
  }
  const other = course.activities?.find(row => row.id === fallback.ref);
  // One level only: a fallback activity must itself run on the target.
  return Boolean(other && other.id !== activity.id && fallback.objectiveIds.every(o => other.objectiveIds.includes(o))
    && resolveActivity(course, other, fallback.target, installed)?.mode === 'run');
}

// ----------------------------------------------------------------- bounded JSON and schemas

export const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');
export const isJsonObject = (value: unknown): value is JsonObject => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
/** Plain JSON within a nesting bound (no NaN, functions or deep structures). */
export function boundedJson(value: unknown, depth = 0): boolean {
  if (depth > 16) return false;
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 1000 && value.every(item => boundedJson(item, depth + 1));
  if (isJsonObject(value)) return Object.keys(value).length <= 200 && Object.values(value).every(item => boundedJson(item, depth + 1));
  return false;
}

/** The JSON Schema subset Core enforces for declared activity state and observations. A course
 * using anything else is refused at publication rather than silently not checked. */
const SCHEMA_KEYWORDS = new Set(['type', 'properties', 'required', 'additionalProperties', 'enum', 'const', 'minimum', 'maximum',
  'minLength', 'maxLength', 'items', 'minItems', 'maxItems', 'maxProperties', 'title', 'description', '$comment']);
const SCHEMA_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
export function schemaIssues(schema: unknown, path = '', depth = 0): string[] {
  if (depth > 12 || !isJsonObject(schema)) return [path || '/'];
  const issues: string[] = [];
  for (const [key, value] of Object.entries(schema)) {
    const at = `${path}/${key}`;
    if (!SCHEMA_KEYWORDS.has(key)) issues.push(at);
    else if (key === 'type' && !(typeof value === 'string' ? SCHEMA_TYPES.has(value) : Array.isArray(value) && value.length > 0 && value.every(t => typeof t === 'string' && SCHEMA_TYPES.has(t)))) issues.push(at);
    else if (key === 'properties') {
      if (!isJsonObject(value)) issues.push(at);
      else for (const [name, child] of Object.entries(value)) issues.push(...schemaIssues(child, `${at}/${name}`, depth + 1));
    } else if (key === 'items') issues.push(...schemaIssues(value, at, depth + 1));
    else if (key === 'additionalProperties' && typeof value !== 'boolean') issues.push(at);
    else if (key === 'required' && !(Array.isArray(value) && value.every(v => typeof v === 'string'))) issues.push(at);
    else if (key === 'enum' && !Array.isArray(value)) issues.push(at);
    else if (['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'maxProperties'].includes(key) && (typeof value !== 'number' || !Number.isFinite(value))) issues.push(at);
  }
  return issues;
}
const typeOf = (value: unknown) => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** Validates against the subset accepted by schemaIssues (call that first). */
export function matchesSchema(schema: JsonObject, value: unknown): boolean {
  const s = schema as Record<string, unknown>;
  if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? s.type as string[] : [s.type as string], actual = typeOf(value);
    const ok = types.some(t => t === actual || (t === 'integer' && typeof value === 'number' && Number.isInteger(value)) || (t === 'number' && typeof value === 'number'));
    if (!ok) return false;
  }
  if (s.const !== undefined && !sameJson(s.const, value)) return false;
  if (Array.isArray(s.enum) && !s.enum.some(option => sameJson(option, value))) return false;
  if (typeof value === 'number') {
    if (typeof s.minimum === 'number' && value < s.minimum) return false;
    if (typeof s.maximum === 'number' && value > s.maximum) return false;
  }
  if (typeof value === 'string') {
    const length = [...value].length;
    if (typeof s.minLength === 'number' && length < s.minLength) return false;
    if (typeof s.maxLength === 'number' && length > s.maxLength) return false;
  }
  if (Array.isArray(value)) {
    if (typeof s.minItems === 'number' && value.length < s.minItems) return false;
    if (typeof s.maxItems === 'number' && value.length > s.maxItems) return false;
    if (isJsonObject(s.items) && !value.every(item => matchesSchema(s.items as JsonObject, item))) return false;
  }
  if (isJsonObject(value)) {
    const properties = isJsonObject(s.properties) ? s.properties : {};
    if (typeof s.maxProperties === 'number' && Object.keys(value).length > s.maxProperties) return false;
    if (Array.isArray(s.required) && !s.required.every(name => typeof name === 'string' && Object.hasOwn(value, name))) return false;
    for (const [name, child] of Object.entries(value)) {
      if (Object.hasOwn(properties, name)) { if (!matchesSchema(properties[name] as JsonObject, child)) return false; }
      else if (s.additionalProperties === false) return false;
    }
  }
  return true;
}

// ----------------------------------------------------------------- Core's declarative interpreter

export const DECLARATIVE_RUNTIME_ID = 'course-core-declarative-activity';
export const DECLARATIVE_RUNTIME_VERSION = '1.0.0';
/** The configuration language a course declares when it targets Core's interpreter. */
const declarativeDescriptor = JSON.stringify({
  id: DECLARATIVE_RUNTIME_ID, version: DECLARATIVE_RUNTIME_VERSION, protocol: 'declarative-controls-v1',
  configuration: { prompt: 'text 1..2000', controls: '1..12 of number(min,max,step?) | choice(2..12 options) | toggle', submitLabel: 'optional text 1..60' },
  state: { values: 'control id -> value or null' }, observation: { kind: 'submitted', values: 'control id -> value' },
  capabilities: [...BROKER_CAPABILITIES],
});
export const DECLARATIVE_RUNTIME_INTEGRITY = 'sha256-' + createHash('sha256').update(declarativeDescriptor).digest('hex');

export type DeclarativeControl =
  | { id: string; label: string; kind: 'number'; min: number; max: number; step?: number }
  | { id: string; label: string; kind: 'choice'; options: { id: string; label: string }[] }
  | { id: string; label: string; kind: 'toggle' };
export interface DeclarativeConfiguration { prompt: string; controls: DeclarativeControl[]; submitLabel?: string }
const ID = /^[a-z][a-z0-9._:-]{0,63}$/;
const text = (value: unknown, max: number) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
export function parseDeclarative(configuration: unknown): DeclarativeConfiguration | null {
  if (!isJsonObject(configuration) || Object.keys(configuration).some(key => !['prompt', 'controls', 'submitLabel'].includes(key))) return null;
  const { prompt, controls, submitLabel } = configuration;
  if (!text(prompt, 2000) || (submitLabel !== undefined && !text(submitLabel, 60)) || !Array.isArray(controls) || controls.length < 1 || controls.length > 12) return null;
  const ids = new Set<string>();
  for (const control of controls) {
    if (!isJsonObject(control) || typeof control.id !== 'string' || !ID.test(control.id) || ids.has(control.id) || !text(control.label, 200)) return null;
    ids.add(control.id);
    const keys = Object.keys(control);
    if (control.kind === 'number') {
      const { min, max, step } = control;
      if (keys.some(k => !['id', 'label', 'kind', 'min', 'max', 'step'].includes(k)) || typeof min !== 'number' || typeof max !== 'number' || !Number.isFinite(min) || !Number.isFinite(max) || min >= max
        || (step !== undefined && (typeof step !== 'number' || !(step > 0) || step > max - min))) return null;
    } else if (control.kind === 'choice') {
      const options = control.options;
      if (keys.some(k => !['id', 'label', 'kind', 'options'].includes(k)) || !Array.isArray(options) || options.length < 2 || options.length > 12) return null;
      const optionIds = new Set<string>();
      for (const option of options) {
        if (!isJsonObject(option) || Object.keys(option).some(k => k !== 'id' && k !== 'label') || typeof option.id !== 'string' || !ID.test(option.id) || optionIds.has(option.id) || !text(option.label, 200)) return null;
        optionIds.add(option.id);
      }
    } else if (control.kind === 'toggle') {
      if (keys.some(k => !['id', 'label', 'kind'].includes(k))) return null;
    } else return null;
  }
  return configuration as unknown as DeclarativeConfiguration;
}
function controlAccepts(control: DeclarativeControl, value: unknown) {
  if (control.kind === 'number') return typeof value === 'number' && Number.isFinite(value) && value >= control.min && value <= control.max
    && (control.step === undefined || Math.abs((value - control.min) / control.step - Math.round((value - control.min) / control.step)) < 1e-9);
  if (control.kind === 'choice') return typeof value === 'string' && control.options.some(option => option.id === value);
  return typeof value === 'boolean';
}
function valuesAccepted(configuration: DeclarativeConfiguration, values: unknown, complete: boolean) {
  if (!isJsonObject(values) || Object.keys(values).some(key => !configuration.controls.some(control => control.id === key))) return false;
  return configuration.controls.every(control => {
    const value = values[control.id];
    if (value === undefined || value === null) return !complete;
    return controlAccepts(control, value);
  });
}
/** Core's built-in interpreter for declarative activities: it renders author data with the
 * learner app's own controls, and the server re-checks every state patch and observation. */
export function declarativeActivityRuntime(): RuntimeExtension {
  const config = (configuration: JsonObject) => parseDeclarative(configuration);
  return {
    id: DECLARATIVE_RUNTIME_ID, version: DECLARATIVE_RUNTIME_VERSION, integrity: DECLARATIVE_RUNTIME_INTEGRITY,
    capabilities: [...BROKER_CAPABILITIES], platforms: ['web'],
    activityRuntime: {
      kind: 'declarative',
      validateActivity: (_activity, configuration) => { if (!config(configuration)) throw new ApiError(409, 'PUBLISH_ACTIVITY_CONFIGURATION_INVALID'); },
      initialState: (_activity, configuration) => ({ values: Object.fromEntries(config(configuration)!.controls.map(control => [control.id, null])) }),
      acceptsState: (_activity, configuration, state) => {
        const parsed = config(configuration);
        return Boolean(parsed) && Object.keys(state).every(key => key === 'values') && valuesAccepted(parsed!, state.values, false);
      },
      acceptsObservation: (_activity, configuration, observation) => {
        const parsed = config(configuration);
        return Boolean(parsed) && Object.keys(observation).every(key => key === 'kind' || key === 'values') && observation.kind === 'submitted' && valuesAccepted(parsed!, observation.values, true);
      },
    },
  };
}

// ----------------------------------------------------------------- the sandboxed frame document

/** Runs first inside the sandboxed frame, before the activity script. It removes WebRTC (peer
 * connections reach STUN/TURN servers outside connect-src), makes network hints and nested
 * documents impossible to create (WebKit preconnects to <link rel=preconnect> hosts regardless of
 * CSP; see the guard below and README "Activity runtime"), then says hello to the parent with
 * the per-load nonce from its URL fragment and accepts exactly one MessagePort, only from the
 * parent and only with that nonce. The frame has no other channel to the host. */
export const FRAME_BOOTSTRAP = String.raw`(() => {
  "use strict";
  const parent = window.parent, post = window.parent.postMessage.bind(window.parent);
  for (const name of Object.getOwnPropertyNames(window)) {
    if (!/^(?:webkit|moz)?RTC/.test(name)) continue;
    try { delete window[name]; } catch {}
    try { Object.defineProperty(window, name, { value: undefined, writable: false, configurable: false }); } catch {}
  }
  // Network hints and nested documents. WebKit opens connections for <link rel=preconnect>
  // (and may resolve dns-prefetch names) whatever the CSP says, and a nested document would not
  // run this guard. So, synchronously and before the activity script runs: no element that would
  // make a hint or a nested document can enter this document, and no link can become a hint.
  // Every patched property is pinned (non-writable, non-configurable) like the RTC constructors.
  // Hooks only use references captured here, never prototypes the activity script can change.
  {
    const apply = Reflect.apply, describe = Object.getOwnPropertyDescriptor, define = Object.defineProperty;
    const doc = document, NotAllowed = DOMException, exec = RegExp.prototype.exec, lower = String.prototype.toLowerCase;
    // Caller-supplied names and values are converted exactly once, with the captured String, and
    // those primitives are both checked and passed on: an object whose toString changes between
    // calls cannot pass the check as one value and reach the browser as another.
    const toString = String, Type = TypeError;
    const str = (value) => { if (typeof value === "symbol") throw new Type("Cannot convert a Symbol value to a string"); return toString(value); };
    const nullableStr = (value) => value === null || value === undefined ? null : str(value);
    const HINT = /(?:^|[\t\n\f\r ])(?:preconnect|dns-prefetch|prerender|prefetch|preload|modulepreload|next)(?:[\t\n\f\r ]|$)/i;
    const FRAMES = /^(?:iframe|frame|object|embed|portal|fencedframe)$/;
    const SELECTOR = "link,meta,iframe,frame,object,embed,portal,fencedframe";
    const get = (proto, key) => { const d = proto && describe(proto, key); return d && d.get; };
    const method = (proto, key) => { const d = proto && describe(proto, key); return d && d.value; };
    const nodeType = get(Node.prototype, "nodeType"), localName = get(Element.prototype, "localName");
    const getAttribute = method(Element.prototype, "getAttribute"), hasAttribute = method(Element.prototype, "hasAttribute");
    const removeAttribute = method(Element.prototype, "removeAttribute"), remove = method(Element.prototype, "remove");
    const parentNode = get(Node.prototype, "parentNode"), firstChild = get(Node.prototype, "firstChild"), nextSibling = get(Node.prototype, "nextSibling");
    const listLength = get(NodeList.prototype, "length"), listItem = method(NodeList.prototype, "item");
    const query = { 1: method(Element.prototype, "querySelectorAll"), 9: method(Document.prototype, "querySelectorAll"), 11: method(DocumentFragment.prototype, "querySelectorAll") };
    const attrName = get(Attr.prototype, "localName"), attrValue = get(Attr.prototype, "value"), attrOwner = get(Attr.prototype, "ownerElement");
    const createElement = method(Document.prototype, "createElement"), templateContent = get(HTMLTemplateElement.prototype, "content");
    const innerHTML = describe(Element.prototype, "innerHTML") || describe(HTMLElement.prototype, "innerHTML");
    const appendChild = method(Node.prototype, "appendChild"), insertBefore = method(Node.prototype, "insertBefore");
    const replaceChildren = { 1: method(Element.prototype, "replaceChildren"), 11: method(DocumentFragment.prototype, "replaceChildren") };
    const replaceWith = method(Element.prototype, "replaceWith");
    const refuse = () => { throw new NotAllowed("Blocked by the activity sandbox.", "NotAllowedError"); };
    // Both take primitives only (converted once by the caller of the hook).
    const isHint = (value) => typeof value === "string" && apply(exec, HINT, [value]) !== null;
    const isRel = (name) => typeof name === "string" && apply(lower, name, []) === "rel";
    const blocked = (element) => {
      const name = apply(localName, element, []);
      if (name === "link") return isHint(apply(getAttribute, element, ["rel"]));
      if (name === "meta") return apply(hasAttribute, element, ["http-equiv"]);
      return apply(exec, FRAMES, [name]) !== null;
    };
    // Removes every blocked element under node; refuses when node itself is one and is being inserted.
    const defuse = (node, inserting) => {
      if (node === null || typeof node !== "object") return node;
      let type;
      try { type = apply(nodeType, node, []); } catch { return node; }
      if (!query[type]) return node;
      if (type === 1 && blocked(node)) { if (inserting) refuse(); apply(removeAttribute, node, ["rel"]); }
      const list = apply(query[type], node, [SELECTOR]), count = apply(listLength, list, []), found = [];
      for (let i = 0; i < count; i++) { const element = apply(listItem, list, [i]); if (blocked(element)) found[found.length] = element; }
      for (let i = 0; i < found.length; i++) apply(remove, found[i], []);
      return node;
    };
    // HTML is parsed into an inert template first (no hints, no scripts run), defused, then inserted.
    const parse = (html) => {
      const template = apply(createElement, doc, ["template"]);
      apply(innerHTML.set, template, [html]);
      return defuse(apply(templateContent, template, []), false);
    };
    const pin = (proto, key, descriptor) => { if (proto && describe(proto, key)) define(proto, key, { ...descriptor, enumerable: true, configurable: false }); };
    const wrap = (proto, key, before, after) => {
      const original = method(proto, key);
      if (typeof original !== "function") return;
      pin(proto, key, { writable: false, value: function (...args) {
        if (before) before(args, this);
        const result = apply(original, this, args);
        return after ? after(result) : result;
      } });
    };
    const all = (args) => { for (let i = 0; i < args.length; i++) defuse(args[i], true); };
    const first = (args) => { defuse(args[0], true); }, second = (args) => { defuse(args[1], true); };
    const result = (value) => defuse(value, false);
    const forbid = (proto, key) => pin(proto, key, { writable: false, value: refuse });
    const setter = (proto, key, check) => {
      const d = proto && describe(proto, key);
      if (!d || !d.set) return;
      // check returns the exact value the original setter receives.
      pin(proto, key, { get: d.get, set: function (value) { apply(d.set, this, [check(this, value)]); } });
    };

    // Insertion of nodes.
    for (const key of ["appendChild", "insertBefore", "replaceChild"]) wrap(Node.prototype, key, first);
    for (const proto of [Element.prototype, Document.prototype, DocumentFragment.prototype]) {
      for (const key of ["append", "prepend", "replaceChildren"]) wrap(proto, key, all);
      wrap(proto, "moveBefore", first);
    }
    for (const proto of [Element.prototype, CharacterData.prototype, DocumentType.prototype]) for (const key of ["after", "before", "replaceWith"]) wrap(proto, key, all);
    wrap(Element.prototype, "insertAdjacentElement", second);
    wrap(Range.prototype, "insertNode", first);
    wrap(Range.prototype, "surroundContents", first);
    wrap(HTMLSelectElement.prototype, "add", first);
    if (typeof HTMLOptionsCollection !== "undefined") wrap(HTMLOptionsCollection.prototype, "add", first);
    for (const key of ["caption", "tHead", "tFoot"]) setter(HTMLTableElement.prototype, key, (_, value) => defuse(value, true));
    setter(Document.prototype, "body", (_, value) => defuse(value, true));
    // Copies and documents from elsewhere.
    wrap(Node.prototype, "cloneNode", null, result);
    wrap(Document.prototype, "importNode", null, result);
    wrap(Document.prototype, "adoptNode", null, result);
    wrap(Range.prototype, "createContextualFragment", null, result);
    wrap(Range.prototype, "cloneContents", null, result);
    wrap(DOMParser.prototype, "parseFromString", null, result);
    if (typeof XSLTProcessor !== "undefined") wrap(XSLTProcessor.prototype, "transformToFragment", null, result);
    // Markup strings.
    for (const proto of [Element.prototype, HTMLElement.prototype, typeof ShadowRoot === "undefined" ? null : ShadowRoot.prototype]) {
      const d = proto && describe(proto, "innerHTML");
      if (d && d.set) pin(proto, "innerHTML", { get: d.get, set: function (html) {
        const markup = html === null ? "" : str(html); // [LegacyNullToEmptyString]
        if (apply(nodeType, this, []) === 1 && apply(localName, this, []) === "template") { apply(d.set, this, [markup]); return; }
        apply(replaceChildren[apply(nodeType, this, [])] || replaceChildren[1], this, [parse(markup)]);
      } });
    }
    for (const proto of [Element.prototype, HTMLElement.prototype]) {
      const d = describe(proto, "outerHTML");
      if (d && d.set) pin(proto, "outerHTML", { get: d.get, set: function (html) {
        const parent = apply(parentNode, this, []);
        const markup = html === null ? "" : str(html); // [LegacyNullToEmptyString]
        if (parent) apply(replaceWith, this, [parse(markup)]);
      } });
    }
    pin(Element.prototype, "insertAdjacentHTML", { writable: false, value: function (position, html) {
      const where = apply(lower, str(position), []), fragment = parse(str(html)), parent = apply(parentNode, this, []);
      if (where === "beforebegin") { if (parent) apply(insertBefore, parent, [fragment, this]); }
      else if (where === "afterbegin") apply(insertBefore, this, [fragment, apply(firstChild, this, [])]);
      else if (where === "beforeend") apply(appendChild, this, [fragment]);
      else if (where === "afterend") { if (parent) apply(insertBefore, parent, [fragment, apply(nextSibling, this, [])]); }
      else throw new NotAllowed("Invalid position.", "SyntaxError");
    } });
    for (const key of ["write", "writeln", "open", "execCommand"]) forbid(Document.prototype, key);
    if (typeof HTMLDocument !== "undefined") for (const key of ["write", "writeln", "open"]) forbid(HTMLDocument.prototype, key);
    forbid(Element.prototype, "setHTMLUnsafe");
    forbid(Element.prototype, "setHTML");
    forbid(Element.prototype, "attachShadow");
    if (typeof ShadowRoot !== "undefined") { forbid(ShadowRoot.prototype, "setHTMLUnsafe"); forbid(ShadowRoot.prototype, "setHTML"); }
    for (const key of ["parseHTMLUnsafe", "parseHTML"]) if (describe(Document, key)) define(Document, key, { value: refuse, writable: false, configurable: false });
    setter(Document.prototype, "designMode", (_, value) => { const mode = str(value); if (apply(lower, mode, []) === "on") refuse(); return mode; });
    // A link that would become a hint through its attributes.
    // A link that would become a hint, or a meta that would gain http-equiv (refresh and similar
    // pragmas act as soon as the attribute is set on a connected meta). Primitives only.
    const isEquiv = (name) => typeof name === "string" && apply(lower, name, []) === "http-equiv";
    const blockedAttribute = (element, name, value) => {
      const tag = element ? apply(localName, element, []) : null;
      return (tag === "link" && isRel(name) && isHint(value)) || (tag === "meta" && isEquiv(name));
    };
    const linkRel = (element, name, value) => { if (blockedAttribute(element, name, value)) refuse(); };
    // An unowned attribute could later be attached to a link or meta.
    const blockedAttr = (attr, owner) => {
      const name = apply(attrName, attr, []), value = apply(attrValue, attr, []);
      return owner ? blockedAttribute(owner, name, value) : (isRel(name) && isHint(value)) || isEquiv(name);
    };
    const indexOf = String.prototype.indexOf, slice = String.prototype.slice;
    wrap(Element.prototype, "setAttribute", (args, self) => {
      if (args.length < 2) return;
      args[0] = str(args[0]); args[1] = str(args[1]);
      linkRel(self, args[0], args[1]);
    });
    wrap(Element.prototype, "setAttributeNS", (args, self) => {
      if (args.length < 3) return;
      args[0] = nullableStr(args[0]); args[1] = str(args[1]); args[2] = str(args[2]);
      const colon = apply(indexOf, args[1], [":"]);
      linkRel(self, colon < 0 ? args[1] : apply(slice, args[1], [colon + 1]), args[2]);
    });
    for (const key of ["setAttributeNode", "setAttributeNodeNS"]) wrap(Element.prototype, key, (args, self) => { if (args[0] && blockedAttr(args[0], self)) refuse(); });
    // A NamedNodeMap does not expose its element, so these are refused whatever it belongs to.
    for (const key of ["setNamedItem", "setNamedItemNS"]) wrap(NamedNodeMap.prototype, key, (args) => { if (args[0] && blockedAttr(args[0], null)) refuse(); });
    setter(HTMLLinkElement.prototype, "rel", (self, value) => { const rel = str(value); linkRel(self, "rel", rel); return rel; });
    setter(HTMLMetaElement.prototype, "httpEquiv", (self, value) => { const equiv = str(value); linkRel(self, "http-equiv", equiv); return equiv; });
    const detached = apply(createElement, doc, ["link"]), relList = get(HTMLLinkElement.prototype, "relList");
    if (relList) pin(HTMLLinkElement.prototype, "relList", { get: function () { return apply(relList, detached, []); } });
    const attrCheck = (self, text) => {
      if (apply(nodeType, self, []) !== 2) return text;
      const name = apply(attrName, self, []), owner = apply(attrOwner, self, []);
      if (owner ? blockedAttribute(owner, name, text) : (isRel(name) && isHint(text)) || isEquiv(name)) refuse();
      return text;
    };
    setter(Attr.prototype, "value", (self, value) => attrCheck(self, str(value)));
    // nodeValue and textContent are nullable: null (and undefined) mean the empty string.
    setter(Node.prototype, "nodeValue", (self, value) => attrCheck(self, nullableStr(value)));
    setter(Node.prototype, "textContent", (self, value) => attrCheck(self, nullableStr(value)));
  }
  const match = /^#([A-Za-z0-9_-]{16,64})$/.exec(location.hash), nonce = match ? match[1] : null;
  let port = null, context = null, sequence = 0;
  const waiting = new Map(), listeners = [];
  const api = Object.freeze({
    request(capability, payload) {
      return new Promise((resolve, reject) => {
        if (!port) { reject(Object.assign(new Error("NOT_CONNECTED"), { code: "NOT_CONNECTED" })); return; }
        const id = ++sequence;
        waiting.set(id, { resolve, reject });
        port.postMessage({ type: "call", id, capability: String(capability), payload: payload === undefined ? null : payload });
      });
    },
    onInit(listener) { if (typeof listener !== "function") return; listeners.push(listener); if (context) listener(context); },
  });
  window.addEventListener("message", (event) => {
    if (port || !nonce || event.source !== parent || !event.ports || event.ports.length !== 1) return;
    if (!event.data || event.data.type !== "course-activity-init" || event.data.nonce !== nonce) return;
    port = event.ports[0];
    port.onmessage = (message) => {
      const data = message.data;
      if (!data || data.type !== "result" || !waiting.has(data.id)) return;
      const pending = waiting.get(data.id); waiting.delete(data.id);
      if (data.ok) pending.resolve(data.value); else pending.reject(Object.assign(new Error(String(data.error)), { code: String(data.error) }));
    };
    context = Object.freeze(event.data.context);
    port.postMessage({ type: "ready" });
    for (const listener of listeners) listener(context);
  });
  Object.defineProperty(window, "courseActivity", { value: api });
  if (nonce) post({ type: "course-activity-hello", nonce }, "*");
})();`;
/** Script text cannot end its element early or enter the HTML parser's escaped script states. */
const inlineScript = (script: string) => script.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');
const scriptHash = (script: string) => `'sha256-${createHash('sha256').update(inlineScript(script), 'utf8').digest('base64')}'`;
/** No fetch/XHR/WebSocket, subresources, forms, nested frames, workers or plugins; opaque origin
 * even if the frame is opened directly. This policy does not stop WebRTC or WebKit's network hints
 * (the bootstrap closes both, see FRAME_BOOTSTRAP); where the frame may navigate is decided by the
 * embedding learner page's frame-src. */
export function frameContentSecurityPolicy(script: string) {
  return [`default-src 'none'`, `script-src ${scriptHash(FRAME_BOOTSTRAP)} ${scriptHash(script)}`, `style-src 'unsafe-inline'`, `img-src data:`,
    `connect-src 'none'`, `font-src 'none'`, `media-src 'none'`, `frame-src 'none'`, `worker-src 'none'`, `manifest-src 'none'`, `object-src 'none'`,
    `form-action 'none'`, `base-uri 'none'`, `frame-ancestors 'self'`, `sandbox allow-scripts`].join('; ');
}
export function frameDocument(script: string, title: string) {
  const safeTitle = title.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${safeTitle}</title>`
    + `<style>html{color-scheme:light}body{margin:0;padding:12px;font:16px/1.5 system-ui,sans-serif;color:#1b1b1b;background:#fff}</style></head>`
    + `<body><main id="activity"></main><script>${inlineScript(FRAME_BOOTSTRAP)}</script><script>${inlineScript(script)}</script></body></html>`;
}
