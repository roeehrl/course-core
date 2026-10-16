import type { ActivityDefinition, CourseManifest } from '@course-core/sdk';
import { fixture } from './fixture.js';
import { DECLARATIVE_RUNTIME_ID, DECLARATIVE_RUNTIME_INTEGRITY, DECLARATIVE_RUNTIME_VERSION, frameScriptIntegrity } from '../src/activity-runtime.js';
import type { RuntimeExtension } from '../src/publication.js';

/** Public, synthetic activity fixtures: the ordering course with one interactive activity. */
export const EVALUATOR_ID = 'synthetic-activity-evaluator';
export const SANDBOX_ID = 'synthetic-sandboxed-activity';

export function declarativeDeclaration(): CourseManifest['extensions'][number] {
  return { id: DECLARATIVE_RUNTIME_ID, version: DECLARATIVE_RUNTIME_VERSION, integrity: DECLARATIVE_RUNTIME_INTEGRITY, execution: 'declarative',
    entrypoint: 'runtimes/declarative-controls-v1.json', platforms: ['web'], capabilities: ['state.read', 'state.patch', 'observation.emit'],
    accessibility: { keyboard: true, reducedMotion: true, textAlternative: 'Form controls for an activity.' } };
}
export function evaluatorDeclaration(): CourseManifest['extensions'][number] {
  return { id: EVALUATOR_ID, version: '1.0.0', integrity: 'sha256-' + 'e'.repeat(64), execution: 'server', entrypoint: 'evaluators/minimum.js', platforms: ['web'],
    capabilities: ['assessment.evaluate'], accessibility: { keyboard: true, reducedMotion: true, textAlternative: 'Checks a submitted value.' } };
}
/** Overrides may set an optional field to undefined to leave it out (for example, no evaluator). */
export function activityDefinition(overrides: { [K in keyof ActivityDefinition]?: ActivityDefinition[K] | undefined } = {}): ActivityDefinition {
  const activity: ActivityDefinition = {
    id: 'min-explore', version: '1.0.0', title: 'Explore the minimum', objectiveIds: ['minimum'],
    supportedTargets: ['web_desktop', 'web_mobile'],
    rendererRefs: [{ target: 'web_desktop', rendererId: DECLARATIVE_RUNTIME_ID }, { target: 'web_mobile', rendererId: DECLARATIVE_RUNTIME_ID }],
    executionAdapter: 'declarative',
    capabilityRequirements: [{ capability: 'state.read', required: true }, { capability: 'state.patch', required: true }, { capability: 'observation.emit', required: true }],
    equivalentFallbacks: [], offlineBehavior: 'unavailable',
    resourceBudget: { timeoutMs: 5000, maxMemoryMb: 64, maxStateBytes: 2048, maxEventBytes: 1024, maxEventsPerMinute: 5 },
    accessibleSemantics: { keyboard: true, screenReader: true, reducedMotion: true, nonPointerPath: true, textAlternative: 'Pick the smaller value with the number field.' },
    stateMigration: { stateVersion: 1, strategy: 'none', migratesFrom: [] },
    layoutInputs: ['effective_window_bounds', 'font_scale'], layouts: { compact: { columns: 1 }, expanded: { columns: 2 } },
    evaluatorRef: EVALUATOR_ID,
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete (activity as unknown as Record<string, unknown>)[key];
    else (activity as unknown as Record<string, unknown>)[key] = value;
  }
  return activity;
}
export const declarativeConfiguration = () => ({
  prompt: 'Set the field to the smaller of 4 and 9, then submit.',
  controls: [{ id: 'value', label: 'Smaller value', kind: 'number', min: 0, max: 10, step: 1 }, { id: 'sure', label: 'I checked both values', kind: 'toggle' }],
  submitLabel: 'Submit my value',
});
/** The ordering fixture with an activity block in the "min" episode. */
export function activityCourse(activity: ActivityDefinition = activityDefinition(), configuration: Record<string, unknown> = declarativeConfiguration()): CourseManifest {
  const course = fixture();
  course.extensions.push(declarativeDeclaration(), evaluatorDeclaration());
  course.activities = [activity];
  course.chapters[0]!.episodes[0]!.blocks.splice(1, 0, { id: 'min-activity', type: 'activity', activityId: activity.id, configuration: configuration as never });
  return course;
}
/** A synthetic registered evaluator: passes exactly the value 4. Counts its calls. */
export function syntheticActivityEvaluator(behavior: 'normal' | 'throws' | 'out_of_scope' = 'normal'): RuntimeExtension & { calls: number } {
  const extension = {
    id: EVALUATOR_ID, version: '1.0.0', integrity: 'sha256-' + 'e'.repeat(64), capabilities: ['assessment.evaluate'], platforms: ['web'], calls: 0,
    activityEvaluator: {
      evaluate: async ({ observation }: { observation: Record<string, unknown> }) => {
        extension.calls++;
        if (behavior === 'throws') throw new Error('synthetic evaluator failure');
        const values = observation.values as Record<string, unknown> | undefined;
        if (behavior === 'out_of_scope') return { passed: true, objectiveIds: ['maximum'] };
        return { passed: values?.value === 4, objectiveIds: ['minimum'], explanation: values?.value === 4 ? '4 is the smaller value.' : 'Compare both values again.' };
      },
    },
  };
  return extension as RuntimeExtension & { calls: number };
}

/** A synthetic sandboxed_web activity. It reports, through the broker only, what the sandbox
 * let it do, then tries capabilities it never declared. Test hosts only. */
export const SANDBOX_SCRIPT = `(() => {
  "use strict";
  const main = document.getElementById("activity");
  const heading = document.createElement("h1"); heading.textContent = "Sandbox report"; main.append(heading);
  const status = document.createElement("p"); status.id = "status"; status.setAttribute("role", "status"); main.append(status);
  const probes = {};
  try { probes.cookie = document.cookie; probes.cookieReadable = true; } catch { probes.cookieReadable = false; }
  try { probes.parentDom = Boolean(window.parent.document); } catch { probes.parentDom = false; }
  try { window.localStorage.getItem("x"); probes.storage = true; } catch { probes.storage = false; }
  probes.origin = String(self.origin);
  window.courseActivity.onInit(async (context) => {
    const button = document.createElement("button"); button.type = "button"; button.textContent = "Report the sandbox";
    main.append(button);
    const results = { granted: context.grantedCapabilities };
    try { await fetch("/api/workspaces"); results.fetch = "allowed"; } catch { results.fetch = "blocked"; }
    for (const capability of ["network.fetch", "evidence.write", "learner.profile.read"]) {
      try { await window.courseActivity.request(capability, {}); results[capability] = "allowed"; } catch (error) { results[capability] = error.code; }
    }
    button.addEventListener("click", async () => {
      try {
        const answer = await window.courseActivity.request("observation.emit", { observation: { kind: "probe", probes, results } });
        status.textContent = "Reported: " + answer.evaluation.status;
      } catch (error) { status.textContent = "Report failed: " + error.code; }
    });
    status.textContent = "Ready";
  });
})();`;
export function sandboxedActivityRuntime(script = SANDBOX_SCRIPT): RuntimeExtension {
  return { id: SANDBOX_ID, version: '1.0.0', integrity: frameScriptIntegrity(script), capabilities: ['state.read', 'observation.emit'], platforms: ['web'],
    activityRuntime: { kind: 'sandboxed_web', frameScript: script, validateActivity: () => {}, initialState: () => ({}) } };
}
export function sandboxedDeclaration(script = SANDBOX_SCRIPT): CourseManifest['extensions'][number] {
  return { id: SANDBOX_ID, version: '1.0.0', integrity: frameScriptIntegrity(script), execution: 'sandboxed_web', entrypoint: 'activities/probe.js', platforms: ['web'],
    capabilities: ['state.read', 'observation.emit'], accessibility: { keyboard: true, reducedMotion: true, textAlternative: 'A sandbox report.' } };
}
/** A practice (no evaluator) sandboxed activity that also declares, but is not offered, state.patch. */
export function sandboxedActivity(): ActivityDefinition {
  return activityDefinition({ id: 'sandbox-probe', title: 'Sandbox probe', executionAdapter: 'sandboxed_web',
    rendererRefs: [{ target: 'web_desktop', rendererId: SANDBOX_ID }, { target: 'web_mobile', rendererId: SANDBOX_ID }],
    capabilityRequirements: [{ capability: 'state.read', required: true }, { capability: 'observation.emit', required: true }, { capability: 'state.patch', required: false }],
    evaluatorRef: undefined });
}
export function sandboxedCourse(): CourseManifest {
  const activity = sandboxedActivity();
  const course = activityCourse(activity, {});
  course.extensions.push(sandboxedDeclaration());
  return course;
}
