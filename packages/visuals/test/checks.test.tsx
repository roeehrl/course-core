import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  assertSceneChecks,
  checkFrame,
  frameAtWidth,
  frameDigest,
  goldenFrames,
  layoutModes,
  runSceneChecks,
  sha256,
} from "../src/checks.js";
import { motionStudyDemo, primitivesDemo } from "../src/demos.js";
import { sceneFeatures } from "../src/features.js";
import {
  DevicePreview,
  PREVIEW_DEVICES,
  VisualInspector,
} from "../src/react.js";
import { englishVisualMessages } from "../src/messages.js";
import { VisualRuntime } from "../src/runtime.js";
import { parseScene } from "../src/schema.js";
import { renderSvg } from "../src/svg.js";

type Mutable = Record<string, any>;
const clone = <T,>(v: T): Mutable => JSON.parse(JSON.stringify(v)) as Mutable;
const code = (fn: () => unknown, expected: string, message?: RegExp) =>
  assert.throws(fn, (e: Error & { code?: string }) => {
    assert.equal(e.code, expected, e.message);
    if (message) assert.match(e.message, message);
    return true;
  });
const failing = (scene: unknown) =>
  runSceneChecks(parseScene(scene)).map((f) => `${f.check}:${f.id}`);

test("sha256 matches the platform implementation", () => {
  for (const text of [
    "",
    "abc",
    "x".repeat(4097),
    "é→∑ 😀",
    JSON.stringify(motionStudyDemo),
  ])
    assert.equal(sha256(text), createHash("sha256").update(text).digest("hex"));
});

test("the motion study passes its invariants and goldens at every layout", () => {
  assert.deepEqual(runSceneChecks(motionStudyDemo), []);
  assertSceneChecks(motionStudyDemo);
  assert.deepEqual(layoutModes(motionStudyDemo), [
    "compact",
    "tabletPortrait",
    "tabletLandscape",
    "wide",
  ]);
  // The embedded goldens are exactly what goldenFrames produces for this build.
  const regenerated = goldenFrames(motionStudyDemo, [0, 2950, 6600]).filter(
    (g) => g.layout === "compact" || g.layout === "wide",
  );
  assert.deepEqual(regenerated, motionStudyDemo.goldens);
  assert.ok(
    sceneFeatures(motionStudyDemo).includes("invariants") &&
      sceneFeatures(motionStudyDemo).includes("goldens"),
  );
  // A digest is a function of what is drawn: same frame, same digest; another time, another digest.
  assert.equal(
    frameDigest(checkFrame(motionStudyDemo, "wide", 2950)),
    frameDigest(checkFrame(motionStudyDemo, "wide", 2950)),
  );
  assert.notEqual(
    frameDigest(checkFrame(motionStudyDemo, "wide", 2950)),
    frameDigest(checkFrame(motionStudyDemo, "wide", 2960)),
  );
});

test("divergence (S05): contradicting any one representation is caught and named", () => {
  const withoutGoldens = () => {
    const scene = clone(motionStudyDemo);
    delete scene.goldens;
    return scene;
  };
  assert.deepEqual(failing(withoutGoldens()), []);
  // The trace table claims a different running maximum at row 3.
  const table = withoutGoldens();
  table.panes[1].rows[3][2] = 8;
  assert.ok(failing(table).includes("invariant:line-at-traced-best"));
  assert.ok(failing(table).includes("invariant:formula-matches-trace"));
  // The formula reports a different value than the table.
  const formula = withoutGoldens();
  formula.panes[2].values[2].value = 7;
  assert.deepEqual(
    [...new Set(failing(formula))],
    ["invariant:formula-matches-trace"],
  );
  // The pointer animates to the wrong bar.
  const pointer = withoutGoldens();
  pointer.timeline.tracks[0].keyframes[4].value = 28;
  assert.deepEqual(
    [...new Set(failing(pointer))],
    ["invariant:pointer-on-traced-bar"],
  );
  // The orange line is drawn at the wrong height.
  const line = withoutGoldens();
  line.timeline.tracks[1].keyframes[6].value = 0;
  assert.deepEqual(
    [...new Set(failing(line))],
    ["invariant:line-at-traced-best"],
  );
  code(
    () => assertSceneChecks(parseScene(line)),
    "INVARIANT_FAILED",
    /line-at-traced-best/,
  );
  // Failures carry the layout, time and state where they occurred.
  const first = runSceneChecks(parseScene(line))[0]!;
  assert.equal(first.check, "invariant");
  assert.ok(layoutModes(motionStudyDemo).includes(first.layout));
});

test("goldens detect geometry drift that no invariant covers", () => {
  const drift = clone(motionStudyDemo);
  drift.nodes[1].children[0].height = 61; // the first bar, 3 × 20 = 60
  assert.ok(failing(drift).every((f) => f.startsWith("golden:")));
  assert.ok(failing(drift).length > 0);
  code(
    () => assertSceneChecks(parseScene(drift)),
    "GOLDEN_MISMATCH",
    /differs from the golden/,
  );
});

test("invariants over listed states, and a hidden node is a failure, not a pass", () => {
  const scene = clone(primitivesDemo);
  scene.invariants = [
    {
      id: "tokens-match-count",
      description: "The last visible token is the one the count names",
      assert: { op: "gte", args: [{ state: "count" }, 1] },
      states: [{ count: 1 }, { count: 5 }],
    },
    {
      id: "token5-visible",
      description: "Token 5 is drawn",
      assert: { op: "gte", args: [{ node: "token5", property: "worldX" }, 0] },
      states: [{ count: 5 }],
    },
  ];
  // token5 is hidden in the initial state (count 3), so that frame fails and names the reason.
  const failures = runSceneChecks(parseScene(scene));
  assert.ok(
    failures.length > 0 &&
      failures.every(
        (f) =>
          f.id === "token5-visible" &&
          f.state === undefined &&
          /hidden/.test(f.message),
      ),
  );
});

test("check validation: probes only in invariants, references resolve, bounded work", () => {
  const scene = (patch: Mutable) => ({
    ...clone(motionStudyDemo),
    goldens: undefined,
    ...patch,
  });
  const strip = (s: Mutable) => (delete s.goldens, s);
  const inv = (assert: unknown, extra: Mutable = {}) =>
    strip(
      scene({ invariants: [{ id: "i", description: "d", assert, ...extra }] }),
    );
  parseScene(inv(true));
  code(
    () => parseScene(inv({ node: "missing", property: "x" })),
    "SCHEMA",
    /unknown node/,
  );
  code(
    () => parseScene(inv({ cell: { pane: "trace", row: 0, column: 5 } })),
    "SCHEMA",
    /unknown table cell/,
  );
  code(
    () => parseScene(inv({ cell: { pane: "rule", row: 0, column: 0 } })),
    "SCHEMA",
    /unknown table cell/,
  );
  code(
    () => parseScene(inv({ value: { pane: "rule", symbol: "nope" } })),
    "SCHEMA",
    /unknown formula value/,
  );
  code(
    () => parseScene(inv({ highlight: "rule" })),
    "SCHEMA",
    /unknown highlight/,
  );
  code(() => parseScene(inv(true, { times: [999999] })), "SCHEMA");
  code(
    () => parseScene(inv(true, { times: [7000, 7300] })),
    "SCHEMA",
    /outside duration/,
  );
  code(() => parseScene(inv(true, { states: [{ missing: 1 }] })), "STATE");
  const many = strip(
    scene({
      invariants: Array.from({ length: 5 }, (_, i) => ({
        id: `i${i}`,
        description: "d",
        assert: true,
        times: Array.from({ length: 30 }, (_, k) => i * 30 + k),
      })),
    }),
  );
  code(() => parseScene(many), "SCHEMA", /too many checked frames/);
  code(
    () =>
      parseScene(
        strip(
          scene({
            invariants: [
              { id: "i", description: "d", assert: true },
              { id: "i", description: "e", assert: true },
            ],
          }),
        ),
      ),
    "SCHEMA",
    /Duplicate invariant/,
  );
  // Probes are not expressions: a node cannot read another node's geometry.
  const probeInNode = clone(motionStudyDemo);
  probeInNode.nodes[0].x = { node: "pointer", property: "x" };
  code(() => parseScene(probeInNode), "SCHEMA");
  const golden = (g: Mutable) =>
    scene({
      goldens: [
        { atMs: 0, layout: "wide", digest: `sha256-${"0".repeat(64)}`, ...g },
      ],
    });
  parseScene(golden({}));
  code(
    () => parseScene(golden({ layout: "expanded" })),
    "SCHEMA",
    /not a layout of this scene/,
  );
  code(() => parseScene(golden({ digest: "sha256-xyz" })), "SCHEMA");
  code(() => parseScene(golden({ atMs: 99999 })), "SCHEMA", /outside duration/);
});

test("device preview frames follow the runtime and render like the headless export", () => {
  const runtime = new VisualRuntime(primitivesDemo, { viewportWidth: 1300 });
  runtime.setState({ count: 5 });
  runtime.seek(2500);
  for (const device of PREVIEW_DEVICES) {
    const frame = frameAtWidth(runtime, device.width);
    const direct = new VisualRuntime(primitivesDemo, {
      viewportWidth: device.width,
    });
    direct.restoreReplay(runtime.exportReplay());
    assert.deepEqual(frame, direct.seek(2500));
    assert.equal(frame.state.count, 5);
  }
  const motion = new VisualRuntime(motionStudyDemo);
  motion.seek(2950);
  const html = renderToStaticMarkup(<DevicePreview runtime={motion} />);
  const captions = [...html.matchAll(/<figcaption>([^<]+)<\/figcaption>/g)].map(
    (m) => m[1],
  );
  assert.deepEqual(captions, [
    "Phone · 390 px · COMPACT",
    "Tablet portrait · 768 px · TABLET PORTRAIT",
    "Tablet landscape · 1024 px · TABLET LANDSCAPE",
    "Desktop · 1440 px · WIDE",
  ]);
  // Each preview's SVG is exactly the headless export of the same frame.
  const svgs = [...html.matchAll(/<svg[\s\S]*?<\/svg>/g)].map((m) => m[0]);
  PREVIEW_DEVICES.forEach((device, i) => {
    const prefix = /aria-labelledby="([^"]+)-title"/.exec(svgs[i]!)![1]!;
    assert.equal(
      renderSvg(frameAtWidth(motion, device.width), {
        idPrefix: prefix,
        title: `${motionStudyDemo.title} (${englishVisualMessages.devices[device.id as "phone"]})`,
      }),
      svgs[i],
    );
  });
});

test("the inspector lists every parameter, keyframes, node properties and check counts", () => {
  const runtime = new VisualRuntime(primitivesDemo);
  const html = renderToStaticMarkup(<VisualInspector runtime={runtime} />);
  assert.match(html, /Inspector · Reveal, repeat, relate/);
  assert.match(html, /<legend>Parameters<\/legend>/);
  assert.match(html, /Tokens shown <code>count<\/code>/);
  assert.match(html, /aria-label="Keyframes"/);
  assert.match(html, /Computed properties of primitivesKicker/);
  assert.match(html, /0 invariants, 0 goldens/);
  const motion = renderToStaticMarkup(
    <VisualInspector runtime={new VisualRuntime(motionStudyDemo)} />,
  );
  assert.doesNotMatch(motion, /<legend>Parameters/);
  assert.match(motion, /3 invariants, 6 goldens/);
  assert.match(
    motion,
    /goldens, invariants, layout_set, panes, spring, stagger/,
  );
});
