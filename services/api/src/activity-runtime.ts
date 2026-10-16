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
 *   (sandbox="allow-scripts", never allow-same-origin) and a CSP without network access.
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
/** A registered (installed, trusted) evaluator of activity observations. */
export interface ActivityEvaluatorPort {
  evaluate(input: { activity: ActivityDefinition; configuration: JsonObject; observation: JsonObject; state: JsonObject }): Promise<ActivityEvaluation>;
}

export const frameScriptIntegrity = (script: string) => 'sha256-' + createHash('sha256').update(script, 'utf8').digest('hex');
/** Installed sandboxed runtimes must identify exactly the script they serve. */
export function assertInstalledActivityRuntimes(installed: readonly RuntimeExtension[]) {
  for (const extension of installed) {
    const runtime = extension.activityRuntime;
    if (!runtime) continue;
    if (runtime.kind === 'sandboxed_web' && (!runtime.frameScript || frameScriptIntegrity(runtime.frameScript) !== extension.integrity))
      throw new Error(`Installed activity runtime ${extension.id} does not match its integrity.`);
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
  return { ref: `${definition?.id ?? extensionId}@${definition?.version ?? extension.version}`, extension, evaluator: extension.activityEvaluator };
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
    if (activity.evaluatorRef !== undefined && !activityEvaluator(course, activity, installed)) throw refuse('PUBLISH_EVALUATOR_RUNTIME_UNAVAILABLE', at);
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

/** Runs first inside the sandboxed frame. It accepts exactly one MessagePort from the parent
 * window and exposes a request API over it; the frame has no other channel to the host. */
export const FRAME_BOOTSTRAP = `(() => {
  "use strict";
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
    if (port || event.source !== window.parent || !event.ports || event.ports.length !== 1) return;
    if (!event.data || event.data.type !== "course-activity-init") return;
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
})();`;
/** Script text cannot end its element early or enter the HTML parser's escaped script states. */
const inlineScript = (script: string) => script.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');
const scriptHash = (script: string) => `'sha256-${createHash('sha256').update(inlineScript(script), 'utf8').digest('base64')}'`;
/** No network, no forms, no nested frames, no plugins, opaque origin even if opened directly. */
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
