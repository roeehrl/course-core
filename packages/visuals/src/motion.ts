import { finite } from "./expression.js";
import type { LayoutMode, Scene, Spring } from "./types.js";

/**
 * Springs are integrated with semi-implicit Euler at a fixed 1/240 s step, using only
 * addition and multiplication, so every JavaScript engine computes the same values: the
 * headless runtime, the server check and the browser agree exactly. Between two steps the
 * position is interpolated linearly. A spring segment always ends exactly on its target
 * keyframe value.
 */
export const SPRING_STEP_MS = 1000 / 240;
export const DEFAULT_SPRING: Readonly<Spring> = Object.freeze({
  stiffness: 170,
  damping: 26,
  mass: 1,
});
/** Bounds keep the fixed-step integration stable (ω·dt and c/m·dt well below 1). */
export const SPRING_LIMITS = Object.freeze({
  stiffness: [1, 1000] as const,
  damping: [0, 200] as const,
  mass: [0.1, 10] as const,
  stiffnessPerMass: 5000,
  dampingPerMass: 200,
});

const tables = new Map<string, number[]>();
/** Normalized spring position (0 → 1) after `elapsedMs`. */
export function springProgress(spring: Spring, elapsedMs: number): number {
  finite(elapsedMs);
  if (elapsedMs <= 0) return 0;
  const key = `${spring.stiffness}/${spring.damping}/${spring.mass}`;
  let table = tables.get(key);
  if (!table) {
    if (tables.size >= 64) tables.delete(tables.keys().next().value!);
    tables.set(key, (table = [0]));
  }
  const steps = Math.floor(elapsedMs / SPRING_STEP_MS);
  const dt = SPRING_STEP_MS / 1000;
  if (table.length < steps + 2) {
    let x = 0,
      v = 0;
    const out = [0];
    for (let i = 1; i < steps + 2; i++) {
      const a =
        (-spring.stiffness * (x - 1) - spring.damping * v) / spring.mass;
      v += a * dt;
      x += v * dt;
      out.push(x);
    }
    tables.set(key, (table = out));
  }
  const frac = (elapsedMs - steps * SPRING_STEP_MS) / SPRING_STEP_MS;
  return finite(table[steps]! + (table[steps + 1]! - table[steps]!) * frac);
}

/** Viewport widths (container CSS pixels) where the four-layout set changes mode. */
export const LAYOUT_SET_BREAKPOINTS = Object.freeze({
  tabletPortrait: 600,
  tabletLandscape: 905,
  wide: 1240,
});
export const hasLayoutSet = (scene: Scene) => scene.layouts.wide !== undefined;
/** The layout mode a scene uses at a viewport width. */
export function layoutMode(scene: Scene, viewportWidth: number): LayoutMode {
  if (!hasLayoutSet(scene))
    return viewportWidth < (scene.layouts.breakpoint ?? 640)
      ? "compact"
      : "expanded";
  const b = LAYOUT_SET_BREAKPOINTS;
  return viewportWidth < b.tabletPortrait
    ? "compact"
    : viewportWidth < b.tabletLandscape
      ? "tabletPortrait"
      : viewportWidth < b.wide
        ? "tabletLandscape"
        : "wide";
}
/** A viewport width that selects `mode` (for hosts that report a mode, not a width). */
export function layoutWidth(scene: Scene, mode: LayoutMode): number {
  if (mode === "compact") return 1;
  if (!hasLayoutSet(scene) || mode === "expanded" || mode === "wide")
    return 100_000;
  return LAYOUT_SET_BREAKPOINTS[mode];
}
