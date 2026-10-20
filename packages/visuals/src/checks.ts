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

// SHA-256 over UTF-8, without platform crypto (the headless build loads no builtins).
const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];
export function sha256(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const length = bytes.length,
    total = (((length + 9 + 63) >> 6) << 6) >>> 0;
  const data = new Uint8Array(total);
  data.set(bytes);
  data[length] = 0x80;
  const bits = length * 8;
  for (let i = 0; i < 8; i++)
    data[total - 1 - i] = Math.floor(bits / 2 ** (8 * i)) & 0xff;
  const h = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ];
  const w = new Array<number>(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let offset = 0; offset < total; offset += 64) {
    for (let i = 0; i < 16; i++)
      w[i] =
        (data[offset + i * 4]! << 24) |
        (data[offset + i * 4 + 1]! << 16) |
        (data[offset + i * 4 + 2]! << 8) |
        data[offset + i * 4 + 3]!;
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15]!,
        b = w[i - 2]!;
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3),
        s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) | 0;
    }
    let [a, b, c, d, e, f, g, hh] = h as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + s1 + ch + K[i]! + w[i]!) | 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) | 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h[0] = (h[0]! + a) | 0;
    h[1] = (h[1]! + b) | 0;
    h[2] = (h[2]! + c) | 0;
    h[3] = (h[3]! + d) | 0;
    h[4] = (h[4]! + e) | 0;
    h[5] = (h[5]! + f) | 0;
    h[6] = (h[6]! + g) | 0;
    h[7] = (h[7]! + hh) | 0;
  }
  return h.map((x) => (x >>> 0).toString(16).padStart(8, "0")).join("");
}

/** Numbers to 10 significant digits (|x| < 1e-9 is 0), so platforms agree. */
const stable = (text: string) =>
  text.replace(/-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/g, (n) =>
    Math.abs(Number(n)) < 1e-9
      ? "0"
      : String(Number(Number(n).toPrecision(10))),
  );
/** Digest of what a frame draws: layout, geometry, definitions, panes and text. */
export function frameDigest(frame: Frame): string {
  const { layout, width, height, timeMs, nodes, defs, panes, text, cue } =
    frame;
  return `sha256-${sha256(stable(JSON.stringify({ layout, width, height, timeMs, nodes, defs, panes, text, cue })))}`;
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
    return probe.property === "worldX"
      ? node.matrix[4]
      : probe.property === "worldY"
        ? node.matrix[5]
        : node[probe.property];
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
