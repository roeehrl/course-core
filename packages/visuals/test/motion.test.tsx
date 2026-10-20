import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { motionStudyDemo, primitivesDemo } from "../src/demos.js";
import { sceneFeatures, SUPPORTED_FEATURES } from "../src/features.js";
import { flattenNodes, interpolate } from "../src/geometry.js";
import { sanitizeMarkup, serializeMarkup } from "../src/markup.js";
import type { MarkupElement } from "../src/markup.js";
import {
  DEFAULT_SPRING,
  LAYOUT_SET_BREAKPOINTS,
  SPRING_STEP_MS,
  layoutMode,
  layoutWidth,
  springProgress,
} from "../src/motion.js";
import { buildPanesMarkup, renderPanes } from "../src/panes.js";
import { SceneView, VisualPlayer } from "../src/react.js";
import { VisualRuntime } from "../src/runtime.js";
import { parseScene } from "../src/schema.js";
import { toVisualExperience, fromVisualExperience } from "../src/sdk.js";
import { renderSvg } from "../src/svg.js";
import type { LayoutMode, Track } from "../src/types.js";
import { OffscreenPause } from "../src/visibility.js";

const SNAPSHOTS = new URL("./fixtures/motion/", import.meta.url);
function snapshot(name: string, actual: string) {
  const file = new URL(name, SNAPSHOTS);
  if (process.env.UPDATE_SNAPSHOTS === "1") {
    mkdirSync(SNAPSHOTS, { recursive: true });
    writeFileSync(file, actual);
  }
  assert.ok(
    existsSync(file),
    `Missing snapshot ${name}; run with UPDATE_SNAPSHOTS=1`,
  );
  assert.equal(actual, readFileSync(file, "utf8"), `${name} changed`);
}
const code = (fn: () => unknown, expected: string, message?: RegExp) =>
  assert.throws(fn, (e: Error & { code?: string }) => {
    assert.equal(e.code, expected, e.message);
    if (message) assert.match(e.message, message);
    return true;
  });
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
type Mutable = Record<string, any>;
const frameAt = (input: unknown, timeMs: number, viewportWidth = 1300) => {
  const runtime = new VisualRuntime(input, { viewportWidth });
  runtime.seek(timeMs);
  return runtime.getSnapshot().frame;
};
const base = (patch: Mutable = {}) => ({
  version: 1,
  id: "motion",
  title: "Motion",
  description: "Synthetic motion scene",
  state: {},
  nodes: [
    { kind: "rect", id: "a", width: 10, height: 10 },
    { kind: "rect", id: "b", width: 10, height: 10 },
    { kind: "rect", id: "c", width: 10, height: 10 },
  ],
  layouts: {
    compact: { width: 320, height: 240 },
    expanded: { width: 640, height: 480 },
  },
  timeline: { durationMs: 2000, tracks: [], cues: [] },
  accessibility: {
    text: "A synthetic scene.",
    reducedMotion: { atMs: 0, description: "Still." },
  },
  ...patch,
});

test("springs integrate at a fixed step with arithmetic only, so every engine agrees", () => {
  // Re-derive the documented integration independently.
  const manual = (ms: number) => {
    const dt = SPRING_STEP_MS / 1000;
    let x = 0,
      v = 0;
    const xs = [0];
    for (let i = 1; i <= Math.floor(ms / SPRING_STEP_MS) + 1; i++) {
      v +=
        ((-DEFAULT_SPRING.stiffness * (x - 1) - DEFAULT_SPRING.damping * v) /
          DEFAULT_SPRING.mass) *
        dt;
      x += v * dt;
      xs.push(x);
    }
    const n = Math.floor(ms / SPRING_STEP_MS),
      f = (ms - n * SPRING_STEP_MS) / SPRING_STEP_MS;
    return xs[n]! + (xs[n + 1]! - xs[n]!) * f;
  };
  for (const ms of [0.5, 16, 100, 333.3, 1000, 2500])
    assert.equal(springProgress(DEFAULT_SPRING, ms), manual(ms));
  assert.equal(springProgress(DEFAULT_SPRING, 0), 0);
  assert.ok(
    Math.abs(springProgress(DEFAULT_SPRING, 3000) - 1) < 1e-4,
    "settles",
  );
  const bouncy = { stiffness: 300, damping: 6, mass: 1 };
  assert.ok(
    Math.max(
      ...[100, 150, 200, 250, 300].map((t) => springProgress(bouncy, t)),
    ) > 1.2,
    "underdamped overshoots",
  );
  // Pinned values: any change to the integrator is visible here.
  snapshot(
    "spring.json",
    JSON.stringify(
      [10, 50, 120, 300, 700, 1500].map((ms) => [
        ms,
        springProgress(DEFAULT_SPRING, ms),
        springProgress(bouncy, ms),
      ]),
    ) + "\n",
  );
});

test("a spring segment ends exactly on its keyframe and overshoot stays in the property's range", () => {
  const track = (property: Track["property"]): Track => ({
    node: "a",
    property,
    keyframes: [
      { atMs: 0, value: 0 },
      {
        atMs: 400,
        value: 1,
        ease: "spring",
        spring: { stiffness: 400, damping: 4, mass: 1 },
      },
    ],
  });
  assert.equal(interpolate(track("x"), 400), 1);
  assert.equal(interpolate(track("x"), 900), 1);
  const xs = Array.from({ length: 40 }, (_, i) =>
    interpolate(track("x"), i * 10),
  );
  assert.ok(Math.max(...xs) > 1, "x overshoots freely");
  const opacities = Array.from({ length: 40 }, (_, i) =>
    interpolate(track("opacity"), i * 10),
  );
  assert.ok(
    Math.max(...opacities) <= 1 && Math.min(...opacities) >= 0,
    "opacity is clamped",
  );
  // Rendered through the runtime, the overshoot never trips a geometry bound.
  const input = base({
    timeline: { durationMs: 1000, cues: [], tracks: [track("opacity")] },
  });
  for (let t = 0; t <= 1000; t += 25) frameAt(input, t);
});

test("spring and stagger validation", () => {
  const withTracks = (tracks: unknown[], staggers?: unknown[]) =>
    base({
      timeline: {
        durationMs: 2000,
        cues: [],
        tracks,
        ...(staggers ? { staggers } : {}),
      },
    });
  code(
    () =>
      parseScene(
        withTracks([
          {
            node: "a",
            property: "x",
            keyframes: [
              {
                atMs: 0,
                value: 0,
                spring: { stiffness: 100, damping: 10, mass: 1 },
              },
            ],
          },
        ]),
      ),
    "SCHEMA",
    /require ease: spring/,
  );
  code(
    () =>
      parseScene(
        withTracks([
          {
            node: "a",
            property: "x",
            keyframes: [
              {
                atMs: 0,
                value: 0,
                ease: "spring",
                spring: { stiffness: 1000, damping: 10, mass: 0.1 },
              },
            ],
          },
        ]),
      ),
    "SCHEMA",
    /too stiff/,
  );
  code(
    () =>
      parseScene(
        withTracks([
          {
            node: "a",
            property: "x",
            keyframes: [
              {
                atMs: 0,
                value: 0,
                ease: "spring",
                spring: { stiffness: 100, damping: 500, mass: 1 },
              },
            ],
          },
        ]),
      ),
    "SCHEMA",
  );
  const stagger = (patch: Mutable = {}) => ({
    nodes: ["a", "b", "c"],
    property: "x",
    delayMs: 100,
    keyframes: [
      { atMs: 0, value: 0 },
      { atMs: 500, value: 50 },
    ],
    ...patch,
  });
  parseScene(withTracks([], [stagger()]));
  code(
    () => parseScene(withTracks([], [stagger({ nodes: ["a", "missing"] })])),
    "SCHEMA",
    /Invalid\/duplicate track missing.x/,
  );
  code(
    () => parseScene(withTracks([], [stagger({ property: "radius" })])),
    "SCHEMA",
    /Invalid\/duplicate track/,
  );
  code(
    () =>
      parseScene(
        withTracks(
          [{ node: "b", property: "x", keyframes: [{ atMs: 0, value: 1 }] }],
          [stagger()],
        ),
      ),
    "SCHEMA",
    /duplicate track b.x/,
  );
  code(
    () => parseScene(withTracks([], [stagger({ delayMs: 800 })])),
    "SCHEMA",
    /within duration/,
  );
  code(() => parseScene(withTracks([], [stagger({ nodes: ["a"] })])), "SCHEMA");
});

test("a stagger is the same keyframes per node, each shifted by its delay", () => {
  const keyframes = [
    { atMs: 0, value: 0 },
    { atMs: 500, value: 50, ease: "spring" as const },
  ];
  const input = base({
    timeline: {
      durationMs: 2000,
      cues: [],
      tracks: [],
      staggers: [
        { nodes: ["a", "b", "c"], property: "x", delayMs: 150, keyframes },
      ],
    },
  });
  for (const t of [0, 120, 300, 640, 900]) {
    const nodes = frameAt(input, t).nodes;
    nodes.forEach((n, i) =>
      assert.equal(
        n.x,
        interpolate({ node: n.id, property: "x", keyframes }, t - i * 150),
        `${n.id}@${t}`,
      ),
    );
  }
});

test("the four-layout set: complete or absent, fixed breakpoints, same logical nodes in every layout", () => {
  const layouts = clone(motionStudyDemo.layouts) as Mutable;
  const { wide: _, ...partial } = layouts;
  code(
    () => parseScene({ ...clone(motionStudyDemo), layouts: partial }),
    "SCHEMA",
    /layout set needs/,
  );
  code(
    () =>
      parseScene({
        ...clone(motionStudyDemo),
        layouts: { ...layouts, breakpoint: 700 },
      }),
    "SCHEMA",
    /breakpoint applies only/,
  );
  const b = LAYOUT_SET_BREAKPOINTS;
  const expected: [number, LayoutMode][] = [
    [b.tabletPortrait - 1, "compact"],
    [b.tabletPortrait, "tabletPortrait"],
    [b.tabletLandscape - 1, "tabletPortrait"],
    [b.tabletLandscape, "tabletLandscape"],
    [b.wide - 1, "tabletLandscape"],
    [b.wide, "wide"],
  ];
  for (const [width, mode] of expected)
    assert.equal(layoutMode(motionStudyDemo, width), mode, String(width));
  const ids = (mode: LayoutMode) =>
    flattenNodes(
      frameAt(motionStudyDemo, 3000, layoutWidth(motionStudyDemo, mode)).nodes,
    ).map((n) => n.id);
  for (const mode of [
    "compact",
    "tabletPortrait",
    "tabletLandscape",
    "wide",
  ] as const) {
    assert.equal(
      frameAt(motionStudyDemo, 0, layoutWidth(motionStudyDemo, mode)).layout,
      mode,
    );
    assert.deepEqual(
      ids(mode),
      ids("compact"),
      `${mode} keeps the logical ids`,
    );
  }
  // Scenes without a set keep the two-layout behaviour.
  assert.equal(layoutMode(primitivesDemo, 700), "expanded");
  assert.equal(layoutMode(primitivesDemo, 500), "compact");
  // The SDK experience keeps compact/expanded; the set travels inside the scene.
  const experience = toVisualExperience(motionStudyDemo);
  assert.deepEqual(Object.keys(experience.layouts).sort(), [
    "compact",
    "expanded",
  ]);
  assert.deepEqual(fromVisualExperience(clone(experience)), motionStudyDemo);
});

test("panes follow the same step as the geometry (one computation drives every representation)", () => {
  for (let t = 1500; t <= 6600; t += 300) {
    const frame = frameAt(motionStudyDemo, t);
    const trace = frame.panes!.find((p) => p.id === "trace")!;
    const rule = frame.panes!.find((p) => p.id === "rule")!;
    assert.ok(trace.kind === "table" && rule.kind === "formula");
    const row = trace.highlightRow!;
    assert.equal(rule.values[0]!.value, String(row));
    assert.equal(rule.values[1]!.value, trace.rows[row]![1]);
    assert.equal(rule.values[2]!.value, trace.rows[row]![2]);
  }
  // After each spring settles, the pointer sits on the highlighted bar.
  for (let step = 0; step < 6; step++) {
    const frame = frameAt(motionStudyDemo, 1500 + step * 900 + 850);
    const trace = frame.panes!.find((p) => p.id === "trace")!;
    const pointer = flattenNodes(frame.nodes).find((n) => n.id === "pointer")!;
    assert.equal(trace.kind === "table" && trace.highlightRow, step);
    assert.ok(
      Math.abs(pointer.x - (step * 80 + 28)) < 1.5,
      `pointer settled at step ${step}`,
    );
  }
});

test("pane validation and safe output", () => {
  const scene = (panes: unknown[]) => base({ panes });
  code(
    () =>
      parseScene(
        scene([
          {
            id: "t",
            kind: "table",
            title: "T",
            columns: ["a", "b"],
            rows: [[1]],
          },
        ]),
      ),
    "SCHEMA",
    /one cell per column/,
  );
  code(
    () =>
      parseScene(
        scene([
          {
            id: "f",
            kind: "formula",
            title: "F",
            tex: "\\href{https://example.com}{x}",
            label: "x",
          },
        ]),
      ),
    "EQUATION_UNSAFE",
  );
  code(
    () =>
      parseScene(
        scene([
          {
            id: "c",
            kind: "code",
            title: "C",
            language: "Py<th>",
            lines: ["x"],
          },
        ]),
      ),
    "SCHEMA",
  );
  code(
    () =>
      parseScene(
        scene([
          { id: "c", kind: "code", title: "C", language: "py", lines: ["x"] },
          { id: "c", kind: "code", title: "D", language: "py", lines: ["y"] },
        ]),
      ),
    "SCHEMA",
    /Duplicate pane/,
  );
  code(
    () =>
      parseScene(
        scene([
          {
            id: "t",
            kind: "table",
            title: "T",
            columns: ["a"],
            rows: [[{ state: "missing" }]],
          },
        ]),
      ),
    "SCHEMA",
    /Unknown state/,
  );
  const hostile = parseScene(
    scene([
      {
        id: "c",
        kind: "code",
        title: "<img src=x onerror=alert(1)>",
        language: "html",
        lines: ["<script>alert(1)</script>"],
        highlightLine: 9,
      },
      {
        id: "t",
        kind: "table",
        title: "T",
        columns: ["<b>"],
        rows: [["</td><script>"]],
        highlightRow: -1,
      },
    ]),
  );
  const frame = frameAt(hostile, 0);
  const html = renderPanes(frame, { idPrefix: "h" });
  assert.doesNotMatch(html, /<script|<img|<b>|aria-current/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  const bad = parseScene(
    scene([
      {
        id: "c",
        kind: "code",
        title: "C",
        language: "py",
        lines: ["x"],
        highlightLine: "one",
      },
    ]),
  );
  code(() => frameAt(bad, 0), "TYPE");
  // HTML panes have their own allowlist: no scripts, frames, styles or SVG reuse.
  const div = (
    children: MarkupElement[],
    attrs: MarkupElement["attrs"] = {},
  ): MarkupElement => ({ tag: "div", attrs, children });
  for (const tree of [
    div([{ tag: "script", attrs: {}, children: [] }]),
    div([{ tag: "iframe", attrs: {}, children: [] }]),
    div([{ tag: "a", attrs: { href: "https://example.com" }, children: [] }]),
    div([{ tag: "use", attrs: {}, children: [] }]),
    div([], { style: "color:red" }),
    div([{ tag: "td", attrs: { onclick: "x" }, children: [] }]),
    { tag: "table", attrs: {}, children: [] },
    {
      tag: "svg",
      attrs: {},
      children: [{ tag: "table", attrs: {}, children: [] }],
    },
  ])
    assert.throws(() => sanitizeMarkup(tree), { code: "SANITIZE" });
});

test("headless and React render the same SVG and panes at every layout", () => {
  for (const width of [380, 700, 1000, 1300])
    for (const t of [0, 900, 2950, 6600]) {
      const frame = frameAt(motionStudyDemo, t, width);
      const svg = renderToStaticMarkup(
        <SceneView frame={frame} title={motionStudyDemo.title} />,
      );
      const prefix = /aria-labelledby="([^"]+)-title"/.exec(svg)![1]!;
      assert.equal(
        renderSvg(frame, { idPrefix: prefix, title: motionStudyDemo.title }),
        svg,
      );
    }
  for (const t of [0, 2950, 6600]) {
    const runtime = new VisualRuntime(motionStudyDemo, { viewportWidth: 1300 });
    runtime.seek(t);
    const html = renderToStaticMarkup(
      <VisualPlayer
        scene={motionStudyDemo}
        options={{ viewportWidth: 1300 }}
      />,
    );
    // The player starts at time 0; compare at that frame, then pin headless output at others.
    if (t === 0) {
      const prefix =
        /<div class="ccv-panes"><section[^>]*aria-labelledby="([^"]+)-pane-code"/.exec(
          html,
        )![1]!;
      assert.ok(
        html.includes(
          renderPanes(runtime.getSnapshot().frame, { idPrefix: prefix }),
        ),
      );
    }
    const frame = runtime.getSnapshot().frame;
    snapshot(
      `running-max-${t}.svg`,
      renderSvg(frame, { idPrefix: "m", title: motionStudyDemo.title }),
    );
    snapshot(`running-max-${t}.html`, renderPanes(frame, { idPrefix: "m" }));
  }
  assert.equal(
    buildPanesMarkup(frameAt(primitivesDemo, 0), { idPrefix: "x" }),
    undefined,
  );
  assert.match(
    renderToStaticMarkup(
      <VisualPlayer scene={motionStudyDemo} options={{ viewportWidth: 700 }} />,
    ),
    /TABLET PORTRAIT/,
  );
});

test("off-screen pause suspends playback, resumes it, and respects the viewer", () => {
  const runtime = new VisualRuntime(motionStudyDemo);
  const offscreen = new OffscreenPause(runtime);
  runtime.play();
  runtime.advance(500);
  offscreen.update(false, false);
  assert.equal(runtime.getSnapshot().playing, false);
  assert.equal(offscreen.suspended, true);
  const held = runtime.getSnapshot().frame.timeMs;
  runtime.advance(1000);
  assert.equal(
    runtime.getSnapshot().frame.timeMs,
    held,
    "no time passes off-screen",
  );
  offscreen.update(true, false);
  assert.equal(runtime.getSnapshot().playing, true);
  assert.equal(offscreen.suspended, false);
  // A paused runtime stays paused when it scrolls out and back.
  runtime.pause();
  offscreen.update(false, false);
  offscreen.update(true, false);
  assert.equal(runtime.getSnapshot().playing, false);
  // Reduced motion: never resumes automatically.
  runtime.play();
  offscreen.update(false, false);
  offscreen.update(true, true);
  assert.equal(runtime.getSnapshot().playing, false);
  // A viewer action while off-screen cancels the resume.
  runtime.play();
  offscreen.update(false, false);
  offscreen.cancel();
  offscreen.update(true, false);
  assert.equal(runtime.getSnapshot().playing, false);
});

test("render features of the motion study, and 0.2 scenes are unchanged", () => {
  assert.deepEqual(sceneFeatures(motionStudyDemo), [
    "goldens",
    "invariants",
    "layout_set",
    "panes",
    "spring",
    "stagger",
  ]);
  assert.deepEqual(sceneFeatures(primitivesDemo), [
    "clip",
    "equation",
    "gradient",
    "mask",
    "symbol",
  ]);
  for (const f of sceneFeatures(motionStudyDemo))
    assert.ok(SUPPORTED_FEATURES.includes(f));
  assert.equal(
    serializeMarkup(
      buildPanesMarkup(frameAt(motionStudyDemo, 0), { idPrefix: "q" })!,
    ),
    renderPanes(frameAt(motionStudyDemo, 0), { idPrefix: "q" }),
  );
});
