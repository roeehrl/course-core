import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluate,
  MAX_VALUE,
  seededSample,
  VisualError,
} from "../src/expression.js";
import {
  anchorPoint,
  curveBounds,
  flattenNodes,
  interpolate,
  inversePoint,
  multiply,
  transformPoint,
} from "../src/geometry.js";
import { evaluateScene, VisualRuntime } from "../src/runtime.js";
import { LIMITS, parseScene } from "../src/schema.js";
import { fromVisualExperience, toVisualExperience } from "../src/sdk.js";
import {
  demoReferenceChecks,
  demoScenes,
  motionDemo,
  sortingDemo,
  transitionsDemo,
} from "../src/demos.js";
import type { Expression, Scene, SceneNode } from "../src/types.js";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
function minimal(
  nodes: SceneNode[] = [{ kind: "rect", id: "box", width: 20, height: 10 }],
): Scene {
  return {
    version: 1,
    id: "test",
    title: "Test",
    description: "Test geometry",
    state: {
      n: {
        kind: "number",
        label: "Number",
        initial: 0,
        min: 0,
        max: 100,
        step: 1,
      },
    },
    nodes,
    layouts: {
      compact: { width: 320, height: 400 },
      expanded: { width: 800, height: 400 },
    },
    timeline: { durationMs: 1000, tracks: [], cues: [] },
    accessibility: {
      text: "Rectangle",
      reducedMotion: { atMs: 500, description: "Still rectangle" },
    },
  };
}
const context = { state: { a: 4 }, timeMs: 250, seed: 42, tick: 3 };
const expr = (op: string, ...args: unknown[]) => ({ op, args }) as Expression;
const rejects = (fn: () => unknown, code?: string) =>
  assert.throws(
    fn,
    (e: unknown) => e instanceof VisualError && (!code || e.code === code),
  );

test("actual transformed rectangle, ellipse, group bounds and inverse pointer geometry", () => {
  const scene = minimal([
    {
      kind: "group",
      id: "group",
      x: 100,
      y: 50,
      rotation: 90,
      scale: 2,
      children: [
        { kind: "rect", id: "rect", x: 10, width: 20, height: 10 },
        { kind: "ellipse", id: "ellipse", x: 40, width: 20, height: 10 },
      ],
    },
  ]);
  const frame = evaluateScene(scene),
    nodes = flattenNodes(frame.nodes),
    rect = nodes[1]!;
  assert.ok(Math.abs(rect.bounds.x - 80) < 1e-9);
  assert.equal(rect.bounds.y, 70);
  assert.ok(Math.abs(rect.bounds.width - 20) < 1e-9);
  assert.equal(rect.bounds.height, 40);
  const ellipse = nodes[2]!;
  assert.equal(ellipse.bounds.width, 20);
  assert.equal(ellipse.bounds.height, 40);
  const p = inversePoint(
    rect.matrix,
    transformPoint(rect.matrix, { x: 7, y: 9 }),
  );
  assert.ok(Math.abs(p.x - 7) < 1e-9);
  assert.ok(Math.abs(p.y - 9) < 1e-9);
  assert.deepEqual(
    anchorPoint({ x: 10, y: 20, width: 30, height: 40 }, "right"),
    { x: 40, y: 40 },
  );
});
test("quadratic/cubic extrema use actual curve, not control point hull", () => {
  assert.deepEqual(
    curveBounds([
      { x: 0, y: 0 },
      { x: 50, y: 100 },
      { x: 100, y: 0 },
    ]),
    { x: 0, y: 0, width: 100, height: 50 },
  );
  assert.deepEqual(
    curveBounds([
      { x: 0, y: 0 },
      { x: 0, y: 100 },
      { x: 100, y: 100 },
      { x: 100, y: 0 },
    ]),
    { x: 0, y: 0, width: 100, height: 75 },
  );
  const frame = evaluateScene(
    minimal([
      {
        kind: "path",
        id: "curve",
        commands: [
          { command: "M", x: 0, y: 0 },
          { command: "C", x1: 0, y1: 100, x2: 100, y2: 100, x: 100, y: 0 },
        ],
        fill: "none",
      },
    ]),
  );
  assert.equal(frame.nodes[0]!.bounds.height, 75);
  assert.equal(frame.nodes[0]!.path, "M0 0 C0 100 100 100 100 0");
});
test("plot maps domains into geometry and links follow transformed targets", () => {
  const frame = evaluateScene(
    minimal([
      { kind: "rect", id: "a", x: 20, y: 30, width: 20, height: 10 },
      { kind: "rect", id: "b", x: 100, y: 70, width: 20, height: 10 },
      {
        kind: "link",
        id: "link",
        from: { node: "a", anchor: "right" },
        to: { node: "b", anchor: "left" },
        bend: 0.5,
      },
      {
        kind: "plot",
        id: "plot",
        width: 100,
        height: 50,
        domainX: [0, 10],
        domainY: [-1, 1],
        points: [
          { x: 0, y: -1 },
          { x: 5, y: 1 },
          { x: 10, y: 0 },
        ],
      },
    ]),
  );
  assert.deepEqual(frame.nodes[3]!.points, [
    { x: 0, y: 50 },
    { x: 50, y: 0 },
    { x: 100, y: 25 },
  ]);
  assert.equal(frame.nodes[2]!.path, "M40 35 C70 35 70 75 100 75");
});
test("linear, smooth, in, out, step keyframe interpolation and boundaries", () => {
  const track = {
    node: "box",
    property: "x" as const,
    keyframes: [
      { atMs: 0, value: 0 },
      { atMs: 1000, value: 100 },
    ],
  };
  assert.equal(interpolate(track, -10), 0);
  assert.equal(interpolate(track, 250), 25);
  assert.equal(interpolate(track, 1500), 100);
  const withEase = (ease: "smooth" | "in" | "out" | "step") => ({
    ...track,
    keyframes: [track.keyframes[0]!, { ...track.keyframes[1]!, ease }],
  });
  assert.equal(interpolate(withEase("smooth"), 250), 15.625);
  assert.equal(interpolate(withEase("in"), 250), 6.25);
  assert.equal(interpolate(withEase("out"), 250), 43.75);
  assert.equal(interpolate(withEase("step"), 999), 0);
  assert.equal(interpolate(withEase("step"), 1000), 100);
});
test("safe expressions are typed, bounded, short-circuiting and deterministic", () => {
  assert.equal(evaluate(expr("add", { state: "a" }, 6), context), 10);
  assert.equal(evaluate(expr("if", true, 7, expr("div", 1, 0)), context), 7);
  assert.equal(evaluate(expr("and", false, expr("div", 1, 0)), context), false);
  assert.equal(
    evaluate(expr("concat", "time ", { time: true }), context),
    "time 250",
  );
  assert.equal(
    evaluate({ sample: "noise" }, context),
    seededSample(42, 3, "noise"),
  );
  assert.notEqual(seededSample(42, 3, "noise"), seededSample(42, 4, "noise"));
  for (const e of [
    expr("constructor", 1),
    expr("add", 1),
    expr("mul", "2", 2),
    expr("not", 0),
    expr("div", 1, 0),
    expr("mod", 1, 0),
    expr("sqrt", -1),
    expr("pow", 2, 999),
    expr("add", MAX_VALUE, 1),
    expr("mul", MAX_VALUE, MAX_VALUE),
    Infinity,
    NaN,
    { state: "missing" },
    expr("concat", "x".repeat(2048), "x"),
  ])
    rejects(() => evaluate(e as Expression, context));
});
test("rejects JS, HTML, URLs, unknown fields, malicious keys and accessors", () => {
  for (const attack of [
    { kind: "image", id: "x", src: "https://example.com" },
    {
      kind: "rect",
      id: "x",
      width: 1,
      height: 1,
      fill: "url(https://example.com)",
    },
    { kind: "rect", id: "x", width: 1, height: 1, onClick: "alert(1)" },
    { kind: "path", id: "x", d: "M0 0" },
    { kind: "rect", id: "x", width: { js: "new Function()" }, height: 1 },
  ]) {
    const scene = minimal();
    scene.nodes = [attack as SceneNode];
    rejects(() => parseScene(scene));
  }
  rejects(() => parseScene(JSON.parse('{"__proto__":{}}')));
  const scene = minimal();
  Object.defineProperty(scene, "title", {
    get() {
      throw new Error("MUST NOT RUN");
    },
  });
  rejects(() => parseScene(scene), "JSON");
  const unsafe = clone(minimal()) as unknown as Record<string, unknown>;
  unsafe.nodes = unsafe;
  rejects(() => parseScene(unsafe), "CYCLE");
  const text = evaluateScene(
    minimal([{ kind: "text", id: "safe", text: "<script>alert(1)</script>" }]),
  );
  assert.equal(text.nodes[0]!.text, "<script>alert(1)</script>");
});
test("bounds nodes, payload, nesting, expression depth, state count, duration and keyframes", () => {
  const nodes = minimal(
    Array.from({ length: LIMITS.nodes + 1 }, (_, i) => ({
      kind: "rect",
      id: `r${i}`,
      width: 1,
      height: 1,
    })),
  );
  rejects(() => parseScene(nodes));
  let child: SceneNode = { kind: "circle", id: "inner", radius: 1 };
  for (let i = 0; i < 13; i++)
    child = { kind: "group", id: `g${i}`, children: [child] };
  rejects(() => parseScene(minimal([child])));
  const large = minimal();
  large.description = "x".repeat(LIMITS.bytes);
  rejects(() => parseScene(large));
  let expression: Expression = 0;
  for (let i = 0; i < 18; i++) expression = expr("add", expression, 1);
  rejects(() =>
    parseScene(minimal([{ kind: "circle", id: "deep", radius: expression }])),
  );
  const duration = minimal();
  duration.timeline.durationMs = 120001;
  rejects(() => parseScene(duration));
  const state = minimal();
  for (let i = 0; i < 65; i++) state.state[`n${i}`] = state.state.n!;
  rejects(() => parseScene(state));
  const tracks = minimal();
  tracks.timeline.tracks = [
    {
      node: "box",
      property: "x",
      keyframes: [
        { atMs: 100, value: 1 },
        { atMs: 0, value: 2 },
      ],
    },
  ];
  rejects(() => parseScene(tracks));
});
test("rejects invalid references, ranges, unsupported overrides, duplicate tracks and nonfinite geometry", () => {
  const bad = minimal();
  bad.nodes[0]!.x = { state: "unknown" };
  rejects(() => parseScene(bad));
  bad.nodes[0]!.x = 0;
  bad.layouts.compact.overrides = { box: { radius: 2 } };
  rejects(() => parseScene(bad));
  const dup = minimal();
  dup.nodes.push(dup.nodes[0]!);
  rejects(() => parseScene(dup));
  const plot = minimal([
    {
      kind: "plot",
      id: "p",
      width: 20,
      height: 20,
      domainX: [1, 1],
      domainY: [0, 1],
      points: [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ],
    },
  ]);
  rejects(() => parseScene(plot));
  rejects(
    () => evaluateScene(minimal([{ kind: "circle", id: "c", radius: -1 }])),
    "SCHEMA",
  );
  rejects(
    () =>
      evaluateScene(
        minimal([{ kind: "rect", id: "r", width: 1, height: 1, opacity: 1.1 }]),
      ),
    "SCHEMA",
  );
  rejects(() =>
    evaluateScene(
      minimal([
        {
          kind: "rect",
          id: "r",
          width: 1,
          height: 1,
          x: expr("mul", MAX_VALUE, 2),
        },
      ]),
    ),
  );
  rejects(() =>
    multiply([100, 0, 0, 100, 0, 0], [100, 0, 0, 100, MAX_VALUE, 0]),
  );
});
test("timeline play/pause/seek, responsive layout and reduced motion preserve user controls", () => {
  const runtime = new VisualRuntime(motionDemo);
  runtime.play();
  runtime.advance(100);
  assert.equal(runtime.getSnapshot().frame.timeMs, 100);
  runtime.pause();
  runtime.advance(100);
  assert.equal(runtime.getSnapshot().frame.timeMs, 100);
  runtime.setState({ target: 30 });
  runtime.setViewport(375);
  assert.equal(runtime.getSnapshot().frame.layout, "compact");
  assert.equal(runtime.getSnapshot().frame.state.target, 30);
  runtime.setReducedMotion(true);
  assert.equal(runtime.getSnapshot().playing, false);
  assert.equal(runtime.getSnapshot().frame.timeMs, 3000);
  runtime.play();
  runtime.advance(1000);
  assert.equal(runtime.getSnapshot().frame.timeMs, 3000);
  assert.match(runtime.getSnapshot().frame.text, /No automatic animation/);
  runtime.seek(500);
  assert.equal(runtime.getSnapshot().frame.timeMs, 500);
  runtime.setReducedMotion(false);
  runtime.play();
  runtime.advance(6000);
  assert.equal(runtime.getSnapshot().frame.timeMs, 6000);
  assert.equal(runtime.getSnapshot().playing, false);
});
test("seeded fixed-step simulation is frame-rate independent and replay round-trips", () => {
  const a = new VisualRuntime(motionDemo),
    b = new VisualRuntime(motionDemo);
  a.play();
  for (let i = 0; i < 75; i++) a.advance(40);
  b.seek(3000);
  assert.deepEqual(a.getSnapshot().frame, b.getSnapshot().frame);
  a.setState({ target: 25 });
  a.seek(4000);
  a.setState({ target: 75 });
  a.seek(6000);
  const replay = JSON.parse(JSON.stringify(a.exportReplay()));
  const c = new VisualRuntime(motionDemo);
  c.restoreReplay(replay);
  c.seek(6000);
  assert.deepEqual(c.getSnapshot().frame, a.getSnapshot().frame);
  a.seek(3000);
  a.setState({ target: 40 });
  assert.equal(a.exportReplay().events.length, 1);
  assert.equal(a.exportReplay().events[0]!.changes.target, 40);
  const other = new VisualRuntime(motionDemo, { seed: 43 });
  other.seek(3000);
  assert.notEqual(
    other.getSnapshot().frame.state.spark,
    b.getSnapshot().frame.state.spark,
  );
});
test("simulation updates are simultaneous; events at a tick apply after that tick", () => {
  const scene = minimal();
  scene.state.n = {
    kind: "number",
    label: "Counter",
    initial: 0,
    min: 0,
    max: 100,
    step: 1,
  };
  scene.state.copy = {
    kind: "number",
    label: "Copy",
    initial: 0,
    min: 0,
    max: 100,
    step: 1,
  };
  scene.simulation = {
    seed: 1,
    stepMs: 100,
    updates: { n: expr("add", { state: "n" }, 1), copy: { state: "n" } },
  };
  const runtime = new VisualRuntime(scene);
  runtime.seek(100);
  assert.equal(runtime.getSnapshot().frame.state.n, 1);
  assert.equal(runtime.getSnapshot().frame.state.copy, 0);
  runtime.setState({ n: 50 });
  assert.equal(runtime.getSnapshot().frame.state.n, 50);
  runtime.seek(200);
  assert.equal(runtime.getSnapshot().frame.state.n, 51);
  assert.equal(runtime.getSnapshot().frame.state.copy, 50);
});
test("malformed replay, invalid seed, out-of-bounds and failed expressions never corrupt last valid frame", () => {
  const runtime = new VisualRuntime(motionDemo),
    before = runtime.getSnapshot();
  rejects(() => runtime.setState({ target: 101 }));
  assert.equal(runtime.getSnapshot(), before);
  const replay = clone(runtime.exportReplay());
  replay.events = [{ atMs: 0, changes: { target: NaN } }];
  rejects(() => runtime.restoreReplay(replay));
  assert.equal(runtime.getSnapshot(), before);
  const different = new VisualRuntime(sortingDemo);
  rejects(() => runtime.restoreReplay(different.exportReplay()));
  rejects(() => new VisualRuntime(motionDemo, { seed: -1 }));
  const bad = minimal([
    {
      kind: "rect",
      id: "box",
      width: expr("div", 10, expr("sub", 10, { state: "n" })),
      height: 10,
    },
  ]);
  const r = new VisualRuntime(bad);
  const safe = r.getSnapshot();
  rejects(() => r.setState({ n: 10 }));
  assert.equal(r.getSnapshot(), safe);
  assert.equal(r.exportReplay().events.length, 0);
});
test("keyboard, pointer mapping, numeric clamp and activation work without DOM", () => {
  const runtime = new VisualRuntime(motionDemo);
  assert.equal(runtime.manipulateKey("target", "ArrowRight"), true);
  assert.equal(runtime.getSnapshot().frame.state.target, 81);
  runtime.manipulateKey("target", "ArrowLeft", true);
  assert.equal(runtime.getSnapshot().frame.state.target, 71);
  runtime.manipulateKey("target", "Home");
  assert.equal(runtime.getSnapshot().frame.state.target, 0);
  runtime.manipulateKey("target", "End");
  assert.equal(runtime.getSnapshot().frame.state.target, 100);
  runtime.manipulatePointer("target", { x: 330, y: 316 });
  assert.equal(runtime.getSnapshot().frame.state.target, 50);
  runtime.setViewport(375);
  runtime.manipulatePointer("target", {
    x: 20 + 0.69 * 280,
    y: 95 + 0.69 * 210,
  });
  assert.equal(runtime.getSnapshot().frame.state.target, 50);
  const flow = new VisualRuntime(transitionsDemo);
  flow.manipulateKey("stage2", " ");
  assert.equal(flow.getSnapshot().frame.state.stage, "Reflect");
  assert.equal(flow.manipulateKey("stage2", "a"), false);
});
test("reference checks are explicit registered trusted hooks and isolate exceptions", () => {
  const runtime = new VisualRuntime(sortingDemo, {
    referenceChecks: demoReferenceChecks,
  });
  runtime.seek(sortingDemo.timeline.durationMs);
  assert.equal(runtime.runReferenceChecks()[0]!.passed, true);
  const missing = new VisualRuntime(sortingDemo);
  assert.equal(missing.runReferenceChecks()[0]!.passed, false);
  const throwing = new VisualRuntime(sortingDemo, {
    referenceChecks: {
      "sort-invariant": () => {
        throw new Error("boom");
      },
    },
  });
  assert.equal(
    throwing.runReferenceChecks()[0]!.message,
    "Reference check failed",
  );
});
test("released SDK contract round-trips and rejects drift or unknown renderer", () => {
  for (const scene of demoScenes) {
    const experience = toVisualExperience(scene);
    assert.deepEqual(fromVisualExperience(experience), scene);
    assert.deepEqual(experience.platforms, ["web"]);
  }
  const experience = toVisualExperience(sortingDemo);
  experience.timeline.durationMs = 1;
  rejects(() => fromVisualExperience(experience), "SDK_METADATA");
  experience.rendererId = "unknown";
  rejects(() => fromVisualExperience(experience), "RENDERER");
});
test("all demos evaluate finite geometry at compact/tablet/wide widths and reference times", () => {
  for (const scene of demoScenes)
    for (const width of [320, 375, 768, 1440])
      for (const timeMs of [
        0,
        scene.timeline.durationMs / 2,
        scene.timeline.durationMs,
      ]) {
        const frame = evaluateScene(scene, { viewportWidth: width, timeMs });
        for (const node of flattenNodes(frame.nodes)) {
          assert.ok(node.matrix.every(Number.isFinite));
          assert.ok(Object.values(node.bounds).every(Number.isFinite));
        }
        assert.ok(frame.text.length > 30);
      }
});

test("standalone expression entrypoint rejects malformed tags, extra fields and accessors", () => {
  for (const e of [
    { time: false },
    { state: "a", extra: 1 },
    { op: "add", args: [1, 2], code: "x" },
    { sample: "bad label" },
    { state: "constructor" },
  ])
    rejects(() => evaluate(e as Expression, context));
  const getter = Object.defineProperty({}, "op", {
    get() {
      throw new Error("MUST NOT RUN");
    },
    enumerable: true,
  });
  rejects(() => evaluate(getter as Expression, context), "EXPRESSION");
  const args = [1, 2];
  Object.defineProperty(args, 0, {
    get() {
      throw new Error("MUST NOT RUN");
    },
  });
  rejects(() => evaluate({ op: "add", args }, context), "EXPRESSION");
  rejects(() => seededSample(NaN, 1, "sample"), "SAMPLE");
  rejects(() => seededSample(1, -1, "sample"), "SAMPLE");
});
test("evaluation work budget fails closed without changing playback frame", () => {
  const scene = minimal();
  scene.timeline.durationMs = 120000;
  scene.simulation = {
    seed: 1,
    stepMs: 16,
    updates: { n: expr("mod", expr("add", { state: "n" }, 1), 100) },
  };
  for (let i = 0; i < 64; i++)
    scene.nodes.push({ kind: "rect", id: `node${i}`, width: 1, height: 1 });
  const budget = { remaining: 1 };
  rejects(
    () => evaluate(expr("add", 1, 2), { ...context, budget }),
    "EXPRESSION_LIMIT",
  );
  // Many safe updates can exhaust the shared simulation budget at a long seek.
  for (let i = 1; i < 30; i++) {
    scene.state[`n${i}`] = scene.state.n!;
    scene.simulation.updates[`n${i}`] = expr(
      "mod",
      expr("add", { state: "n" }, 1),
      100,
    );
  }
  const runtime = new VisualRuntime(scene),
    before = runtime.getSnapshot();
  rejects(() => runtime.seek(120000), "EXPRESSION_LIMIT");
  assert.equal(runtime.getSnapshot(), before);
});
test("group manipulation works through transformed children, and auto anchors reflow", () => {
  const scene = minimal([
    {
      kind: "group",
      id: "g",
      x: 20,
      y: 30,
      label: "Move group",
      manipulate: { x: { state: "n", from: 0, to: 100 } },
      children: [{ kind: "rect", id: "child", width: 20, height: 10 }],
    },
    { kind: "rect", id: "dest", x: 200, y: 30, width: 20, height: 10 },
    {
      kind: "link",
      id: "connector",
      from: { node: "g", anchor: "auto" },
      to: { node: "dest", anchor: "auto" },
      bend: 0,
    },
  ]);
  scene.layouts.compact.overrides = { dest: { x: 20, y: 150 } };
  const runtime = new VisualRuntime(scene);
  runtime.manipulatePointer("g", { x: 50, y: 30 });
  assert.equal(runtime.getSnapshot().frame.state.n, 50);
  assert.match(runtime.getSnapshot().frame.nodes[2]!.path!, /^M40 35/);
  runtime.setViewport(320);
  assert.match(runtime.getSnapshot().frame.nodes[2]!.path!, /^M30 40/);
});

test("literal invalid geometry and future invalid keyframes fail before playback", () => {
  const scene = minimal();
  scene.timeline.tracks = [
    {
      node: "box",
      property: "opacity",
      keyframes: [
        { atMs: 0, value: 1 },
        { atMs: 1000, value: 2 },
      ],
    },
  ];
  rejects(() => parseScene(scene), "SCHEMA");
  const invalid = minimal();
  invalid.layouts.compact.overrides = { box: { width: -1 } };
  rejects(() => parseScene(invalid), "SCHEMA");
  const bad = minimal();
  bad.nodes[0]!.x = true;
  rejects(() => parseScene(bad), "SCHEMA");
});

test("sparse and oversized arrays are rejected before recursive parser work", () => {
  const oversized = minimal();
  oversized.nodes = new Array(10_000_000);
  rejects(() => parseScene(oversized), "PAYLOAD_LIMIT");
  const sparse = minimal();
  sparse.nodes = new Array(3);
  rejects(() => parseScene(sparse), "JSON");
  rejects(
    () => evaluate({ op: "and", args: new Array(2) }, context),
    "EXPRESSION",
  );
  rejects(
    () => evaluate({ op: "add", args: new Array(10_000_000) }, context),
    "EXPRESSION",
  );
});
