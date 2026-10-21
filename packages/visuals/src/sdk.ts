import type { Json, VisualExperience } from "@course-core/sdk";
import { visualError } from "./errors.js";
import { parseScene, preflight } from "./schema.js";
import type { Scene } from "./types.js";

export const RENDERER_ID = "course-core-svg-v1";
/** Uses the published v0.1.0 SDK; no sibling source imports. */
export function toVisualExperience(input: unknown): VisualExperience {
  const scene = parseScene(input);
  const sdkId = /^[a-z][a-z0-9._:-]{0,127}$/;
  if (!sdkId.test(scene.id) || (scene.referenceChecks ?? []).some(id => !sdkId.test(id)))
    throw visualError('SDK_IDENTIFIER', 'sdkIdentifier');
  return {
    id: scene.id,
    rendererId: RENDERER_ID,
    platforms: ["web"],
    state: Object.fromEntries(
      Object.entries(scene.state).map(([key, field]) => [key, field.initial]),
    ),
    scene: JSON.parse(JSON.stringify(scene)) as Record<string, Json>,
    layouts: {
      compact: JSON.parse(JSON.stringify(scene.layouts.compact)),
      expanded: JSON.parse(JSON.stringify(scene.layouts.expanded)),
    },
    timeline: {
      durationMs: scene.timeline.durationMs,
      seekable: true,
      cues: scene.timeline.cues.map((c, index) => ({ atMs: c.atMs, event: `cue-${index}` })),
    },
    accessibility: {
      description: scene.accessibility.text,
      reducedMotion: { ...scene.accessibility.reducedMotion },
    },
    referenceChecks: [...(scene.referenceChecks ?? [])],
  };
}
export function fromVisualExperience(experience: VisualExperience): Scene {
  preflight(experience);
  if (experience.rendererId !== RENDERER_ID)
    throw visualError("RENDERER", "unsupportedRenderer");
  const scene = parseScene(experience.scene),
    expected = toVisualExperience(scene);
  // The scene is authoritative. Divergent outer SDK metadata is rejected, never silently ignored.
  function canonical(v: unknown): string {
    return v && typeof v === "object"
      ? Array.isArray(v)
        ? `[${v.map(canonical)}]`
        : `{${Object.keys(v)
            .sort()
            .map(
              (k) =>
                `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`,
            )}}`
      : JSON.stringify(v);
  }
  for (const key of [
    "id",
    "platforms",
    "state",
    "layouts",
    "timeline",
    "accessibility",
    "referenceChecks",
  ] as const)
    if (canonical(experience[key]) !== canonical(expected[key]))
      throw visualError("SDK_METADATA", "sdkMetadataDiffers", { field: key });
  return scene;
}
