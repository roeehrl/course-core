import { sha256 } from "./digest.js";
import { visualError } from "./errors.js";
import { evaluate, finite, VisualError } from "./expression.js";
import { flattenNodes } from "./geometry.js";
import { hasLayoutSet, layoutWidth } from "./motion.js";
import { VisualRuntime } from "./runtime.js";
import type {
  Expression,
  Frame,
  LayoutMode,
  Probe,
  Scene,
  Value,
} from "./types.js";

/**
 * Publish-time checks a scene carries as data:
 *
 * - invariants: boolean assertions over state, time and probes into the computed frame
 *   (node properties, pane cells, formula values, highlights). One assertion can tie the
 *   SVG, a trace table and a formula together, so contradictory representations (S05) are
 *   caught before publication. They run at every layout the scene has, at their times, for
 *   the initial state and each listed state.
 * - goldens: the expected digest of the frame at a time and layout, so a renderer change
 *   that moves geometry is detected.
 *
 * Both are deterministic and run headless; the API runs them when a course is published.
 */
export { sha256 };

/** Numbers to 10 significant digits (|x| < 1e-9 is 0), so platforms agree. */
const stable = (text: string) =>
  text.replace(/-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/g, (n) =>
    Math.abs(Number(n)) < 1e-9
      ? "0"
      : String(Number(Number(n).toPrecision(10))),
  );
/** Digest of what a frame draws: layout, geometry, definitions, panes and text. */
export function frameDigest(frame: Frame): string {
  const { layout, width, height, timeMs, nodes, panes, text, cue, camera } =
    frame;
  // An image counts by its verified digest, not its bytes.
  const defs = frame.defs?.images
    ? {
        ...frame.defs,
        images: frame.defs.images.map(({ data: _, ...image }) => image),
      }
    : frame.defs;
  return `sha256-${sha256(stable(JSON.stringify({ layout, width, height, timeMs, nodes, defs, panes, text, cue, ...(camera ? { camera } : {}) })))}`;
}

/** The layout modes a scene has. */
export function layoutModes(scene: Scene): LayoutMode[] {
  return hasLayoutSet(scene)
    ? ["compact", "tabletPortrait", "tabletLandscape", "wide"]
    : ["compact", "expanded"];
}
/** The frame at a layout and time, from the initial state plus `state` overrides. */
export function checkFrame(
  scene: Scene,
  layout: LayoutMode,
  atMs: number,
  state?: Record<string, Value>,
): Frame {
  const runtime = new VisualRuntime(scene, {
    viewportWidth: layoutWidth(scene, layout),
  });
  if (state && Object.keys(state).length) runtime.setState(state);
  return runtime.seek(atMs);
}
/** Goldens for the given times at every layout, for authors to embed. */
export function goldenFrames(scene: Scene, times: number[]) {
  return layoutModes(scene).flatMap((layout) =>
    times.map((atMs) => ({
      atMs,
      layout,
      digest: frameDigest(checkFrame(scene, layout, atMs)),
    })),
  );
}

/** Replaces probes with the values they read from the frame. */
function resolve(
  probe: Probe,
  scene: Scene,
  frame: Frame,
  read: (e: Expression) => Value,
): Expression {
  if (probe === null || typeof probe !== "object") return probe;
  if ("op" in probe)
    return {
      op: probe.op,
      args: probe.args.map((a) => resolve(a, scene, frame, read)),
    };
  if ("node" in probe) {
    const node = flattenNodes(frame.nodes).find((n) => n.id === probe.node);
    if (!node) throw new VisualError("PROBE", `Unknown node ${probe.node}`);
    if (!node.visible)
      throw new VisualError("PROBE", `Node ${probe.node} is hidden`);
    const value =
      probe.property === "worldX"
        ? node.matrix[4]
        : probe.property === "worldY"
          ? node.matrix[5]
          : node[probe.property];
    if (value === undefined)
      throw visualError("PROBE", "probeMissingProperty", {
        node: probe.node,
        property: probe.property,
      });
    return value;
  }
  if ("cell" in probe) {
    const pane = scene.panes?.find((p) => p.id === probe.cell.pane);
    if (pane?.kind !== "table")
      throw new VisualError("PROBE", `Unknown table ${probe.cell.pane}`);
    const row = read(resolve(probe.cell.row, scene, frame, read));
    const cell =
      typeof row === "number" ? pane.rows[row]?.[probe.cell.column] : undefined;
    if (cell === undefined)
      throw new VisualError("PROBE", `No cell in ${pane.id}`);
    return read(cell);
  }
  if ("value" in probe) {
    const pane = scene.panes?.find((p) => p.id === probe.value.pane);
    const row =
      pane?.kind === "formula"
        ? pane.values?.find((v) => v.symbol === probe.value.symbol)
        : undefined;
    if (!row)
      throw new VisualError(
        "PROBE",
        `Unknown formula value ${probe.value.symbol}`,
      );
    return read(row.value);
  }
  if ("highlight" in probe) {
    const pane = frame.panes?.find((p) => p.id === probe.highlight);
    if (!pane || pane.kind === "formula")
      throw new VisualError("PROBE", `Unknown highlight ${probe.highlight}`);
    const at = pane.kind === "table" ? pane.highlightRow : pane.highlightLine;
    return at ?? -1;
  }
  return probe;
}

export interface CheckFailure {
  check: "invariant" | "golden";
  id: string;
  layout: LayoutMode;
  atMs: number;
  state?: Record<string, Value>;
  message: string;
}
/** Runs every invariant and golden; returns failures (empty when the scene passes). */
export function runSceneChecks(scene: Scene): CheckFailure[] {
  const failures: CheckFailure[] = [];
  const cues = scene.timeline.cues.map((c) => c.atMs);
  const defaults = [...new Set([0, ...cues, scene.timeline.durationMs])];
  const frames = new Map<string, Frame>();
  const frameFor = (
    layout: LayoutMode,
    atMs: number,
    state?: Record<string, Value>,
  ) => {
    const key = JSON.stringify([layout, atMs, state ?? null]);
    let frame = frames.get(key);
    if (!frame)
      frames.set(key, (frame = checkFrame(scene, layout, atMs, state)));
    return frame;
  };
  for (const invariant of scene.invariants ?? [])
    for (const layout of layoutModes(scene))
      for (const state of [undefined, ...(invariant.states ?? [])])
        for (const atMs of invariant.times ?? defaults) {
          const fail = (message: string) =>
            failures.push({
              check: "invariant",
              id: invariant.id,
              layout,
              atMs,
              ...(state ? { state } : {}),
              message,
            });
          try {
            const frame = frameFor(layout, atMs, state);
            const context = {
              state: frame.state,
              timeMs: frame.timeMs,
              seed: scene.simulation?.seed ?? 1,
              tick: scene.simulation
                ? Math.floor(frame.timeMs / scene.simulation.stepMs)
                : 0,
              budget: { remaining: 50_000 },
            };
            const read = (e: Expression) => evaluate(e, context);
            const result = read(resolve(invariant.assert, scene, frame, read));
            if (result !== true) fail(`${invariant.description} does not hold`);
          } catch (error) {
            fail(error instanceof Error ? error.message : "Check failed");
          }
        }
  for (const golden of scene.goldens ?? []) {
    const digest = frameDigest(frameFor(golden.layout, golden.atMs));
    if (digest !== golden.digest)
      failures.push({
        check: "golden",
        id: `${golden.layout}@${golden.atMs}`,
        layout: golden.layout,
        atMs: golden.atMs,
        message: `Frame digest ${digest} differs from the golden ${golden.digest}`,
      });
  }
  return failures;
}
/** Throws a VisualError (INVARIANT_FAILED or GOLDEN_MISMATCH) naming the first failure. */
export function assertSceneChecks(scene: Scene): void {
  const first = runSceneChecks(scene)[0];
  if (!first) return;
  throw new VisualError(
    first.check === "invariant" ? "INVARIANT_FAILED" : "GOLDEN_MISMATCH",
    `${first.check} ${first.id} at ${first.layout}, ${finite(first.atMs)} ms: ${first.message}`,
  );
}

/** The runtime's current frame (same replay, seed and time) at another viewport width. */
export function frameAtWidth(runtime: VisualRuntime, width: number): Frame {
  const replay = runtime.exportReplay(),
    current = runtime.getSnapshot().frame;
  const copy = new VisualRuntime(runtime.scene, {
    viewportWidth: width,
    seed: replay.seed,
    reducedMotion: current.reducedMotion,
  });
  copy.restoreReplay(replay);
  return copy.seek(current.timeMs);
}
