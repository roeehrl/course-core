import type { Scene, SceneFeature, SceneNode } from "./types.js";

/**
 * Render features this build implements. SDK RenderFeature values (gradient, path_draw,
 * clip, mask, equation) plus `symbol`, `spring`, `stagger`, `layout_set`, `panes`,
 * `invariants` and `goldens`,
 * which the released SDK enum does not name yet.
 */
export const SUPPORTED_FEATURES: readonly SceneFeature[] = Object.freeze([
  "clip",
  "equation",
  "goldens",
  "gradient",
  "invariants",
  "layout_set",
  "mask",
  "panes",
  "path_draw",
  "spring",
  "stagger",
  "symbol",
]);

/** The features a parsed scene requires, sorted. Hosts compare them with a renderer's. */
export function sceneFeatures(scene: Scene): SceneFeature[] {
  const found = new Set<SceneFeature>();
  const visit = (nodes: readonly SceneNode[]) => {
    for (const n of nodes) {
      if (n.fill !== undefined && typeof n.fill !== "string")
        found.add("gradient");
      if ("progress" in n && n.progress !== undefined) found.add("path_draw");
      if (n.clip !== undefined) found.add("clip");
      if (n.mask !== undefined) found.add("mask");
      if (n.kind === "use") found.add("symbol");
      if (n.kind === "equation") found.add("equation");
      if (n.kind === "group") visit(n.children);
    }
  };
  visit(scene.nodes);
  for (const row of scene.defs?.clips ?? [])
    (found.add("clip"), visit(row.nodes));
  for (const row of scene.defs?.masks ?? [])
    (found.add("mask"), visit(row.nodes));
  for (const row of scene.defs?.symbols ?? [])
    (found.add("symbol"), visit(row.nodes));
  for (const track of [
    ...scene.timeline.tracks,
    ...(scene.timeline.staggers ?? []),
  ]) {
    if (track.property === "progress") found.add("path_draw");
    if (track.keyframes.some((k) => k.ease === "spring")) found.add("spring");
  }
  if (scene.timeline.staggers?.length) found.add("stagger");
  if (scene.layouts.wide) found.add("layout_set");
  if (scene.panes?.length) found.add("panes");
  if (scene.invariants?.length) found.add("invariants");
  if (scene.goldens?.length) found.add("goldens");
  for (const layout of [
    scene.layouts.compact,
    scene.layouts.expanded,
    scene.layouts.tabletPortrait,
    scene.layouts.tabletLandscape,
    scene.layouts.wide,
  ])
    if (layout)
      for (const patch of Object.values(layout.overrides ?? {}))
        if (patch.progress !== undefined) found.add("path_draw");
  return [...found].sort();
}
