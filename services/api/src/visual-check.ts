import { fromVisualExperience, sceneFeatures, VisualRuntime } from '@course-core/visuals/headless';
import type { CourseManifest } from '@course-core/sdk';

/**
 * The installed SVG renderer's server-side visual check: parse the scene, then build and
 * seek the runtime at both layout widths, with and without reduced motion. Throws on any
 * failure; on success returns the render features the scene requires (sorted). This validates rendering/data bounds, not the lesson's scientific claims;
 * course-specific numerical/source verification remains a separate release gate.
 *
 * Kept free of relative imports and non-erasable TypeScript so the validation worker
 * (visual-check-worker) can load this exact module from src (tests) and dist alike.
 */
export function checkVisual(visual: CourseManifest['visuals'][number]): readonly string[] {
  const scene = fromVisualExperience(visual);
  for (const viewportWidth of [320, 960]) for (const reducedMotion of [false, true]) {
    const runtime = new VisualRuntime(scene, { viewportWidth, reducedMotion });
    for (const time of [0, scene.timeline.durationMs / 2, scene.timeline.durationMs]) runtime.seek(time);
  }
  return sceneFeatures(scene);
}
