import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { frameDigest, runSceneChecks } from "../src/checks.js";
import { CompletionLatch } from "../src/completion.js";
import type { VisualCompletion } from "../src/completion.js";
import { lensDemo, motionStudyDemo, primitivesDemo } from "../src/demos.js";
import { equationMathML, layoutEquation, parseTex } from "../src/equation.js";
import { SUPPORTED_FEATURES, sceneFeatures } from "../src/features.js";
import { interpolateColor, flattenNodes } from "../src/geometry.js";
import { decodeBase64, verifyImageAsset } from "../src/image.js";
import { sanitizeMarkup, serializeMarkup } from "../src/markup.js";
import { englishVisualMessages, visualMessages } from "../src/messages.js";
import {
  ExportControls,
  LazyVisualPlayer,
  VisualInspector,
  VisualPlayer,
  exportFileName,
} from "../src/react.js";
import { evaluateScene, VisualRuntime } from "../src/runtime.js";
import { LIMITS, parseScene } from "../src/schema.js";
import { cameraViewBox, renderSvg } from "../src/svg.js";

type Mutable = Record<string, any>;
const clone = <T,>(v: T): Mutable => JSON.parse(JSON.stringify(v)) as Mutable;
const code = (fn: () => unknown, expected: string, message?: RegExp) =>
  assert.throws(fn, (e: Error & { code?: string }) => {
    assert.equal(e.code, expected, e.message);
    if (message) assert.match(e.message, message);
    return true;
  });
const base = (patch: Record<string, unknown> = {}): Mutable => ({
  version: 1,
  id: "studio",
  title: "Studio",
  description: "Synthetic 0.5 scene",
  state: {},
  nodes: [{ kind: "rect", id: "box", width: 10, height: 10 }],
  layouts: {
    compact: { width: 320, height: 240 },
    expanded: { width: 640, height: 480 },
  },
  timeline: { durationMs: 1000, tracks: [], cues: [] },
  accessibility: {
    text: "A synthetic scene.",
    reducedMotion: { atMs: 0, description: "Still." },
  },
  ...patch,
});
const node = (frame: ReturnType<typeof evaluateScene>, id: string) =>
  flattenNodes(frame.nodes).find((n) => n.id === id)!;
const tile = () => clone(lensDemo.defs!.images![0]!);
const asset = (bytes: Buffer, mediaType = "image/png") => ({
  id: "img",
  mediaType,
  width: 4,
  height: 4,
  sha256: `sha256-${createHash("sha256").update(bytes).digest("hex")}`,
  data: bytes.toString("base64"),
});

test("image assets: decoded, signature and digest checked, rendered only as embedded data", () => {
  const image = tile();
  const scene = base({
    defs: { images: [image] },
    nodes: [
      {
        kind: "image",
        id: "pic",
        image: "tile",
        width: 64,
        height: 32,
        fit: "cover",
        label: "Checkered tile",
      },
    ],
  });
  const frame = evaluateScene(scene);
  const svg = renderSvg(frame, { idPrefix: "s", title: "T" });
  assert.match(
    svg,
    /<image href="data:image\/png;base64,iVBOR[^"]+" width="64" height="32" preserveAspectRatio="xMidYMid slice" role="img" aria-label="Checkered tile">/,
  );
  // Strict base64 decoding matches Node's.
  assert.deepEqual(
    Buffer.from(decodeBase64(image.data)),
    Buffer.from(image.data, "base64"),
  );
  // The digest counts the image by its sha256, not its bytes.
  assert.match(frameDigest(frame), /^sha256-[0-9a-f]{64}$/);
  // A tampered byte fails the digest.
  const tampered = Buffer.from(image.data, "base64");
  tampered[tampered.length - 1]! ^= 1;
  code(
    () =>
      parseScene(
        base({
          defs: {
            images: [{ ...image, data: tampered.toString("base64") }],
          },
        }),
      ),
    "IMAGE_DIGEST",
  );
  // An SVG or HTML document declared as PNG is refused even with a matching digest.
  for (const text of [
    "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>",
    "<html><body>hello</body></html>",
  ])
    code(
      () => verifyImageAsset(asset(Buffer.from(text)) as never),
      "IMAGE_INVALID",
    );
  // A real JPEG signature declared as PNG is refused; declared as JPEG it passes.
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46]);
  code(() => verifyImageAsset(asset(jpeg) as never), "IMAGE_INVALID");
  verifyImageAsset(asset(jpeg, "image/jpeg") as never);
  const webp = Buffer.from("RIFF\x10\x00\x00\x00WEBPVP8 ", "latin1");
  verifyImageAsset(asset(webp, "image/webp") as never);
  // Not base64 / not padded.
  for (const data of ["iVBOR w0K", "iVBORw0KGgo", "iVBORw0KGgo=@==="])
    code(() => verifyImageAsset({ ...image, data } as never), "IMAGE_INVALID");
  // Schema: unknown media types, URLs, oversize data and too many images.
  code(
    () =>
      parseScene(
        base({
          defs: { images: [{ ...image, data: "https://example.com/a.png" }] },
        }),
      ),
    "IMAGE_INVALID",
  );
  for (const bad of [
    { ...image, mediaType: "image/svg+xml" },
    { ...image, data: "A".repeat(LIMITS.imageChars + 4) },
    { ...image, sha256: "abc" },
    { ...image, url: "https://example.com" },
  ])
    code(() => parseScene(base({ defs: { images: [bad] } })), "SCHEMA");
  code(
    () =>
      parseScene(
        base({
          defs: {
            images: Array.from({ length: LIMITS.images + 1 }, (_, i) => ({
              ...image,
              id: `i${i}`,
            })),
          },
        }),
      ),
    "SCHEMA",
  );
  // References and text alternatives.
  code(
    () =>
      parseScene(
        base({
          defs: { images: [image] },
          nodes: [
            {
              kind: "image",
              id: "p",
              image: "missing",
              width: 1,
              height: 1,
              label: "x",
            },
          ],
        }),
      ),
    "UNDEFINED_REFERENCE",
  );
  code(
    () =>
      parseScene(
        base({
          defs: { images: [image] },
          nodes: [
            { kind: "image", id: "p", image: "tile", width: 1, height: 1 },
          ],
        }),
      ),
    "SCHEMA",
    /label/,
  );
  code(
    () => parseScene(base({ defs: { images: [image, { ...image }] } })),
    "SCHEMA",
    /Duplicate image/,
  );
  // Images are allowed in symbols and masks, never in clips.
  code(
    () =>
      parseScene(
        base({
          defs: {
            images: [image],
            clips: [
              {
                id: "c",
                nodes: [
                  {
                    kind: "image",
                    id: "p",
                    image: "tile",
                    width: 1,
                    height: 1,
                    label: "x",
                  },
                ],
              },
            ],
          },
        }),
      ),
    "SCHEMA",
  );
});

test("the sanitizer allows only embedded raster images and local radial gradients", () => {
  const svg = (children: unknown[]) =>
    ({
      tag: "svg",
      attrs: { viewBox: "0 0 10 10" },
      children,
    }) as never;
  const image = (href: string) => ({
    tag: "image",
    attrs: { href, width: 1, height: 1 },
    children: [],
  });
  sanitizeMarkup(svg([image("data:image/png;base64,iVBORw0KGgo=")]));
  for (const href of [
    "https://example.com/a.png",
    "javascript:alert(1)",
    "data:image/svg+xml;base64,PHN2Zz4=",
    "data:text/html;base64,PGh0bWw+",
    "#local",
    "data:image/png;base64,iVBOR w0KGgo=",
  ])
    code(() => sanitizeMarkup(svg([image(href)])), "SANITIZE");
  code(
    () =>
      sanitizeMarkup(
        svg([
          {
            tag: "image",
            attrs: {
              href: "data:image/png;base64,AAAA",
              preserveAspectRatio: "xMinYMin meet",
            },
            children: [],
          },
        ]),
      ),
    "SANITIZE",
  );
  sanitizeMarkup(
    svg([
      {
        tag: "defs",
        attrs: {},
        children: [
          {
            tag: "radialGradient",
            attrs: { id: "g", cx: 0.5, cy: 0.5, r: 0.5 },
            children: [],
          },
        ],
      },
      { tag: "rect", attrs: { fill: "url(#g)" }, children: [] },
    ]),
  );
  code(
    () =>
      sanitizeMarkup(
        svg([
          { tag: "radialGradient", attrs: { id: "g", fx: 1 }, children: [] },
        ]),
      ),
    "SANITIZE",
  );
});

test("radial gradients render with their centre and radius; bounds are validated", () => {
  const scene = base({
    nodes: [
      {
        kind: "circle",
        id: "sun",
        radius: 40,
        fill: {
          kind: "radial",
          from: "#fff",
          to: "#f59e0b",
          cx: 0.4,
          cy: 0.35,
          r: 0.8,
        },
      },
      {
        kind: "rect",
        id: "plain",
        width: 4,
        height: 4,
        fill: { kind: "radial", from: "#000", to: "#fff" },
      },
    ],
  });
  const svg = renderSvg(evaluateScene(scene), { idPrefix: "r", title: "T" });
  assert.match(
    svg,
    /<radialGradient id="r-fill-sun" cx="0.4" cy="0.35" r="0.8"><stop stop-color="#fff"><\/stop><stop offset="1" stop-color="#f59e0b"><\/stop><\/radialGradient>/,
  );
  assert.match(
    svg,
    /<radialGradient id="r-fill-plain" cx="0.5" cy="0.5" r="0.5">/,
  );
  assert.match(svg, /fill="url\(#r-fill-sun\)"/);
  assert.deepEqual(sceneFeatures(parseScene(scene)), ["radial_gradient"]);
  for (const fill of [
    { kind: "radial", from: "#fff", to: "#000", cx: 1.5 },
    { kind: "radial", from: "#fff", to: "#000", r: 0 },
    { kind: "radial", from: "#fff", to: "url(#x)" },
    { kind: "conic", from: "#fff", to: "#000" },
  ])
    code(
      () =>
        parseScene(
          base({
            nodes: [{ kind: "rect", id: "x", width: 1, height: 1, fill }],
          }),
        ),
      "SCHEMA",
    );
});

test("matrix and environment equations: parse, lay out, MathML, and refuse anything else", () => {
  for (const tex of [
    "\\begin{matrix} a & b \\\\ c & d \\end{matrix}",
    "\\begin{pmatrix} 1 & 0 \\\\ 0 & 1 \\end{pmatrix}",
    "A = \\begin{bmatrix} x_1 \\\\ x_2 \\\\ \\end{bmatrix}",
    "\\begin{Bmatrix} a \\end{Bmatrix} + \\begin{vmatrix} a & b \\\\ c & d \\end{vmatrix} + \\begin{Vmatrix} v \\end{Vmatrix}",
    "f(x) = \\begin{cases} x & x \\geq 0 \\\\ -x & \\text{otherwise} \\end{cases}",
    "\\begin{aligned} a &= b + c \\\\ d &= e \\end{aligned}",
    "\\begin{pmatrix} \\begin{bmatrix} 1 \\end{bmatrix} & \\frac{1}{2} \\end{pmatrix}",
  ])
    parseTex(tex);
  const layout = layoutEquation(
    "\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}",
    20,
  );
  // Two rows centred on the math axis: the box extends above and below the baseline.
  assert.ok(layout.ascent > 20 && layout.descent > 10, JSON.stringify(layout));
  assert.equal(layout.glyphs.length, 4);
  assert.equal(layout.strokes.length, 2); // the two parentheses
  const [a, b, c] = layout.glyphs;
  assert.ok(a!.y < 0 && c!.y > 0 && a!.y === b!.y && a!.x === c!.x);
  assert.deepEqual(
    layoutEquation("\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}", 20),
    layout,
  );
  const cases = serializeMarkup(
    equationMathML(
      "|x| = \\begin{cases} x & x > 0 \\\\ -x & x < 0 \\end{cases}",
      "abs",
    ),
  );
  assert.match(cases, /<mo>\{<\/mo><mtable columnalign="left left"><mtr><mtd>/);
  assert.match(
    serializeMarkup(
      equationMathML("\\begin{aligned} a &= b \\end{aligned}", "a"),
    ),
    /<mtable columnalign="right left">/,
  );
  assert.match(
    serializeMarkup(equationMathML("\\begin{vmatrix} a \\end{vmatrix}", "v")),
    /<mrow><mo>\|<\/mo><mtable><mtr><mtd><mrow><mi>a<\/mi><\/mrow><\/mtd><\/mtr><\/mtable><mo>\|<\/mo><\/mrow>/,
  );
  const refused: [string, string][] = [
    ["a & b", "EQUATION_CHAR"],
    ["a \\\\ b", "EQUATION_SYNTAX"],
    ["\\end{matrix}", "EQUATION_SYNTAX"],
    ["\\begin{array}{cc} a \\end{array}", "EQUATION_MACRO"],
    ["\\begin{tabular} a \\end{tabular}", "EQUATION_MACRO"],
    ["\\begin{matrix} a \\end{pmatrix}", "EQUATION_SYNTAX"],
    ["\\begin{matrix} a & b", "EQUATION_SYNTAX"],
    ["\\begin{matrix} a } \\end{matrix}", "EQUATION_SYNTAX"],
    ["\\begin{cases} a & b & c \\end{cases}", "EQUATION_SYNTAX"],
    ["\\begin{matrix} \\href{x}{y} \\end{matrix}", "EQUATION_UNSAFE"],
    [
      `\\begin{matrix} ${Array(17).fill("a").join(" & ")} \\end{matrix}`,
      "EQUATION_LIMIT",
    ],
    [
      `\\begin{matrix} ${Array(17).fill("a").join(" \\\\ ")} \\end{matrix}`,
      "EQUATION_LIMIT",
    ],
    [
      `${"\\begin{matrix} ".repeat(9)}a${" \\end{matrix}".repeat(9)}`,
      "EQUATION_LIMIT",
    ],
  ];
  for (const [tex, expected] of refused) code(() => parseTex(tex), expected);
  // Exactly 16 rows with a trailing \\ is still within the limit.
  parseTex(
    `\\begin{matrix} ${Array(16).fill("a").join(" \\\\ ")} \\\\ \\end{matrix}`,
  );
  const scene = base({
    nodes: [
      {
        kind: "equation",
        id: "m",
        tex: "\\begin{bmatrix} 1 \\end{bmatrix}",
        label: "one",
      },
    ],
  });
  assert.deepEqual(sceneFeatures(parseScene(scene)), [
    "equation",
    "equation_environments",
  ]);
  assert.deepEqual(
    sceneFeatures(
      parseScene(
        base({
          panes: [
            {
              id: "f",
              kind: "formula",
              title: "F",
              label: "F",
              tex: "\\begin{matrix} a \\end{matrix}",
            },
          ],
        }),
      ),
    ),
    ["equation_environments", "panes"],
  );
});

const morphing = (patch: Mutable = {}) =>
  base({
    nodes: [
      {
        kind: "path",
        id: "p",
        commands: [
          { command: "M", x: 0, y: 0 },
          { command: "Q", x1: 10, y1: 0, x: 10, y: 10 },
          { command: "Z" },
        ],
        morphTo: [
          { command: "M", x: 20, y: 0 },
          { command: "Q", x1: 30, y1: 20, x: 40, y: 40 },
          { command: "Z" },
        ],
        ...patch,
      },
    ],
    timeline: {
      durationMs: 1000,
      tracks: [
        {
          node: "p",
          property: "morph",
          keyframes: [
            { atMs: 0, value: 0 },
            { atMs: 1000, value: 1 },
          ],
        },
      ],
      cues: [],
    },
  });

test("path morph interpolates every coordinate between same-shaped command lists", () => {
  const at = (t: number) => node(evaluateScene(morphing(), { timeMs: t }), "p");
  assert.equal(at(0).path, "M0 0 Q10 0 10 10 Z");
  assert.equal(at(500).path, "M10 0 Q20 10 25 25 Z");
  assert.equal(at(1000).path, "M20 0 Q30 20 40 40 Z");
  assert.equal(at(500).morph, 0.5);
  // Bounds follow the morphed geometry.
  assert.deepEqual(at(1000).bounds, { x: 20, y: 0, width: 20, height: 40 });
  // A path without morphTo has no morph property, so 0.4 frames are unchanged.
  const plain = base({
    nodes: [
      {
        kind: "path",
        id: "q",
        commands: [
          { command: "M", x: 0, y: 0 },
          { command: "L", x: 1, y: 1 },
        ],
      },
    ],
  });
  assert.equal("morph" in node(evaluateScene(plain), "q"), false);
  // Static morph as an expression; a layout override.
  assert.equal(
    node(evaluateScene(morphing({ morph: 0.25 }), { timeMs: 0 }), "p").path,
    "M0 0 Q10 0 10 10 Z",
  );
  const overridden = morphing();
  overridden.timeline.tracks = [];
  overridden.nodes[0].morph = 0.25;
  overridden.layouts.expanded.overrides = { p: { morph: 1 } };
  assert.equal(
    node(evaluateScene(overridden), "p").path,
    "M20 0 Q30 20 40 40 Z",
  );
  assert.equal(
    node(evaluateScene(overridden, { viewportWidth: 320 }), "p").path,
    "M5 0 Q15 5 17.5 17.5 Z",
  );
  assert.deepEqual(sceneFeatures(parseScene(morphing())), ["morph"]);
  // Refusals.
  code(
    () =>
      parseScene(
        morphing({
          morphTo: [
            { command: "M", x: 0, y: 0 },
            { command: "L", x: 1, y: 1 },
            { command: "Z" },
          ],
        }),
      ),
    "SCHEMA",
    /same commands/,
  );
  code(
    () => parseScene(morphing({ morphTo: [{ command: "M", x: 0, y: 0 }] })),
    "SCHEMA",
    /same commands/,
  );
  code(
    () =>
      parseScene(
        base({
          nodes: [
            {
              kind: "path",
              id: "p",
              commands: [{ command: "M", x: 0, y: 0 }],
              morph: 0.5,
            },
          ],
        }),
      ),
    "SCHEMA",
    /morph needs morphTo/,
  );
  code(() => parseScene(morphing({ morph: 2 })), "SCHEMA");
  const wrongTarget = morphing();
  wrongTarget.nodes.push({ kind: "rect", id: "r", width: 1, height: 1 });
  wrongTarget.timeline.tracks.push({
    node: "r",
    property: "morph",
    keyframes: [{ atMs: 0, value: 0 }],
  });
  code(
    () => parseScene(wrongTarget),
    "SCHEMA",
    /Invalid\/duplicate track r.morph/,
  );
  // A dynamic value outside 0..1 fails closed at evaluation.
  const dynamic = morphing({ morph: { op: "mul", args: [{ time: true }, 1] } });
  dynamic.timeline.tracks = [];
  assert.throws(() => evaluateScene(dynamic, { timeMs: 500 }), /outside 0..1/);
  // A spring overshoot is clamped to the valid range.
  const spring = morphing();
  spring.timeline.tracks[0].keyframes[1].ease = "spring";
  spring.timeline.tracks[0].keyframes[1].spring = {
    stiffness: 400,
    damping: 2,
    mass: 1,
  };
  for (let t = 0; t <= 1000; t += 50) {
    const m = node(evaluateScene(spring, { timeMs: t }), "p").morph!;
    assert.ok(m >= 0 && m <= 1, String(m));
  }
});

test("colour tracks animate solid fills and strokes per channel, alpha included", () => {
  const keys = [
    { atMs: 0, color: "#000000" },
    { atMs: 1000, color: "#ff8000" },
    { atMs: 2000, color: "#ff800000", ease: "step" as const },
  ];
  assert.equal(interpolateColor(keys, -5), "#000000");
  assert.equal(interpolateColor(keys, 500), "#804000");
  assert.equal(interpolateColor(keys, 1000), "#ff8000");
  assert.equal(interpolateColor(keys, 1500), "#ff8000"); // step holds until the keyframe
  assert.equal(interpolateColor(keys, 2000), "#ff800000");
  assert.equal(
    interpolateColor(
      [
        { atMs: 0, color: "#fff" },
        { atMs: 10, color: "#0008" },
      ],
      5,
    ),
    "#808080c4",
  );
  const scene = base({
    nodes: [
      { kind: "circle", id: "c", radius: 5, fill: "#000", stroke: "#000" },
    ],
    timeline: {
      durationMs: 1000,
      tracks: [],
      cues: [],
      colorTracks: [
        {
          node: "c",
          property: "fill",
          keyframes: [
            { atMs: 0, color: "#000000" },
            { atMs: 1000, color: "#ffffff", ease: "smooth" },
          ],
        },
        {
          node: "c",
          property: "stroke",
          keyframes: [{ atMs: 0, color: "#ff0000" }],
        },
      ],
    },
  });
  const c = node(evaluateScene(scene, { timeMs: 500 }), "c");
  assert.equal(c.fill, "#808080");
  assert.equal(c.stroke, "#ff0000");
  assert.match(
    renderSvg(evaluateScene(scene, { timeMs: 500 }), {
      idPrefix: "c",
      title: "T",
    }),
    /fill="#808080" stroke="#ff0000"/,
  );
  assert.deepEqual(sceneFeatures(parseScene(scene)), ["color_animation"]);
  const bad = (patch: Mutable, message?: RegExp) => {
    const s = clone(scene);
    Object.assign(s.timeline.colorTracks[0], patch);
    code(() => parseScene(s), "SCHEMA", message);
  };
  bad({ node: "missing" }, /colour track/);
  bad({ keyframes: [{ atMs: 0, color: "none" }] });
  bad({ keyframes: [{ atMs: 0, color: "url(#x)" }] });
  bad({ keyframes: [{ atMs: 0, color: "#000", ease: "spring" }] });
  bad(
    {
      keyframes: [
        { atMs: 500, color: "#000" },
        { atMs: 400, color: "#fff" },
      ],
    },
    /increase/,
  );
  bad(
    { keyframes: [{ atMs: 2000, color: "#000" }] },
    /increase within duration/,
  );
  bad({ property: "stroke" }, /duplicate/);
  const gradient = clone(scene);
  gradient.nodes[0].fill = { kind: "linear", from: "#000", to: "#fff" };
  code(() => parseScene(gradient), "SCHEMA", /gradient/);
  const group = clone(scene);
  group.nodes = [{ kind: "group", id: "c", children: [] }];
  group.timeline.colorTracks.pop();
  code(() => parseScene(group), "SCHEMA", /colour track/);
});

test("the camera sets the viewBox: zoom about a centre, from expressions or tracks", () => {
  const scene = base({
    state: {
      z: {
        label: "Zoom",
        kind: "number",
        initial: 2,
        min: 0.5,
        max: 4,
        step: 0.5,
      },
    },
    camera: { zoom: { state: "z" } },
  });
  const frame = evaluateScene(scene);
  assert.deepEqual(frame.camera, { x: 320, y: 240, zoom: 2 });
  assert.equal(cameraViewBox(frame), "160 120 320 240");
  assert.match(
    renderSvg(frame, { idPrefix: "k", title: "T" }),
    /viewBox="160 120 320 240"/,
  );
  // Without a camera the frame is unchanged (no camera key) and the viewBox is the layout.
  const plain = evaluateScene(base());
  assert.equal("camera" in plain, false);
  assert.equal(cameraViewBox(plain), "0 0 640 480");
  // Tracks win over expressions and the layout changes the default centre.
  const tracked = base({
    camera: { x: 100 },
    timeline: {
      durationMs: 1000,
      tracks: [],
      cues: [],
      cameraTracks: [
        {
          property: "x",
          keyframes: [
            { atMs: 0, value: 0 },
            { atMs: 1000, value: 200 },
          ],
        },
        {
          property: "zoom",
          keyframes: [
            { atMs: 0, value: 1 },
            { atMs: 1000, value: 0.5 },
          ],
        },
      ],
    },
  });
  assert.deepEqual(
    evaluateScene(tracked, { timeMs: 500, viewportWidth: 320 }).camera,
    { x: 100, y: 120, zoom: 0.75 },
  );
  assert.equal(
    cameraViewBox(evaluateScene(tracked, { timeMs: 1000 })),
    "-440 -240 1280 960",
  );
  // Geometry and probes are in scene coordinates whatever the camera does.
  assert.deepEqual(
    node(evaluateScene(tracked, { timeMs: 1000 }), "box").matrix,
    [1, 0, 0, 1, 0, 0],
  );
  assert.deepEqual(sceneFeatures(parseScene(tracked)), ["camera"]);
  // A camera changes the digest; the same frame without one keeps its 0.4 digest.
  assert.notEqual(
    frameDigest(evaluateScene(tracked)),
    frameDigest(evaluateScene(base())),
  );
  // Refusals and runtime bounds.
  code(
    () => parseScene(base({ camera: { zoom: 50 } })),
    "SCHEMA",
    /camera zoom/,
  );
  code(() => parseScene(base({ camera: { x: 1e6 } })), "SCHEMA", /camera x/);
  code(() => parseScene(base({ camera: { tilt: 1 } })), "SCHEMA");
  const noCamera = clone(tracked);
  delete noCamera.camera;
  code(() => parseScene(noCamera), "SCHEMA", /need a camera/);
  const dup = clone(tracked);
  dup.timeline.cameraTracks.push(dup.timeline.cameraTracks[0]);
  code(() => parseScene(dup), "SCHEMA", /Duplicate camera track/);
  const outOfRange = clone(tracked);
  outOfRange.timeline.cameraTracks[1].keyframes[1].value = 30;
  code(() => parseScene(outOfRange), "SCHEMA", /camera zoom/);
  const dynamic = clone(scene);
  dynamic.state.z.max = 100;
  code(
    () =>
      evaluateScene(dynamic, { replay: undefined, timeMs: 0 }) &&
      new VisualRuntime(dynamic).setState({ z: 50 }),
    "SCHEMA",
    /camera zoom/,
  );
  // A spring overshooting the zoom limit is held at the limit.
  const spring = clone(tracked);
  spring.timeline.cameraTracks[1].keyframes = [
    { atMs: 0, value: 19 },
    {
      atMs: 1000,
      value: 20,
      ease: "spring",
      spring: { stiffness: 900, damping: 1, mass: 1 },
    },
  ];
  for (let t = 0; t <= 1000; t += 25)
    assert.ok(evaluateScene(spring, { timeMs: t }).camera!.zoom <= 20);
});

test("the lens demo uses every 0.5 primitive and stays inside the frame budget", () => {
  assert.deepEqual(sceneFeatures(lensDemo), [
    "camera",
    "color_animation",
    "equation",
    "equation_environments",
    "image",
    "morph",
    "radial_gradient",
  ]);
  for (const feature of sceneFeatures(lensDemo))
    assert.ok(SUPPORTED_FEATURES.includes(feature));
  assert.deepEqual(runSceneChecks(lensDemo), []);
  // The headless frame and the React player draw the same markup.
  const runtime = new VisualRuntime(lensDemo);
  runtime.seek(2000);
  assert.match(
    renderSvg(runtime.getSnapshot().frame, { idPrefix: "l", title: "T" }),
    /viewBox="120 57.5 400 225"/,
  );
  // Performance: a second of 60 fps playback evaluates well inside a frame each, with the
  // image verified once (parse caches the verified digest).
  const start = performance.now();
  for (let i = 0; i < 60; i++) runtime.seek((i * 4000) / 60);
  const perFrame = (performance.now() - start) / 60;
  assert.ok(perFrame < 8, `${perFrame.toFixed(2)} ms per frame`);
  const parse = performance.now();
  for (let i = 0; i < 20; i++) new VisualRuntime(lensDemo);
  assert.ok(
    (performance.now() - parse) / 20 < 20,
    "parse with a verified image stays fast",
  );
});

test("completion is emitted once per runtime: replay, scrub, reset and restore never repeat it", () => {
  const runtime = new VisualRuntime(lensDemo);
  const emitted: VisualCompletion[] = [];
  const latch = new CompletionLatch(runtime, (c) => emitted.push(c));
  const show = () => latch.observe(runtime.getSnapshot().frame);
  assert.equal(show(), false);
  runtime.play();
  for (let t = 0; t < 4100; t += 100) {
    runtime.advance(100);
    show();
  }
  assert.equal(runtime.getSnapshot().frame.timeMs, 4000);
  assert.equal(emitted.length, 1);
  assert.deepEqual(emitted[0], {
    sceneId: "lens-study",
    sceneFingerprint: runtime.exportReplay().sceneFingerprint,
    durationMs: 4000,
  });
  // Scrub back and to the end, replay, reset, restore a replay: still once.
  for (const t of [1000, 4000, 0, 4000, 3999, 4000]) {
    runtime.seek(t);
    show();
  }
  runtime.play();
  runtime.advance(5000);
  show();
  runtime.reset();
  show();
  runtime.setState({ angle: 45 });
  runtime.restoreReplay(runtime.exportReplay());
  runtime.seek(4000);
  show();
  assert.equal(emitted.length, 1);
  assert.equal(latch.completed, true);
  // A host that already recorded completion is never told again.
  const again = new CompletionLatch(runtime, (c) => emitted.push(c), true);
  assert.equal(again.observe(runtime.seek(4000)), false);
  // Scrubbing straight to the end completes (still mode has no playback).
  const scrubbed = new VisualRuntime(lensDemo, { reducedMotion: true });
  let count = 0;
  const still = new CompletionLatch(scrubbed, () => count++);
  still.observe(scrubbed.getSnapshot().frame); // the still frame is the final frame
  assert.equal(count, 1);
  // A scene without a timeline never completes.
  const none = new VisualRuntime(
    base({ timeline: { durationMs: 0, tracks: [], cues: [] } }),
  );
  const never = new CompletionLatch(none, () => assert.fail("completed"));
  assert.equal(never.observe(none.getSnapshot().frame), false);
});

test("messages: every player and inspector text can be replaced, numbers follow the locale", () => {
  const he = {
    play: "הפעלה",
    pause: "השהיה",
    playAnimation: "הפעלת ההנפשה",
    timeline: "ציר זמן",
    reset: "איפוס",
    textEquivalent: "חלופה טקסטואלית",
    exploreState: "שינוי המצב",
    eyebrow: "תרגול אינטראקטיבי",
    liveCanvas: "תצוגה חיה",
    stillMode: "מצב סטטי",
    timeReadout: (current: string, total: string) =>
      `${current} / ${total} שנ׳`,
    layout: { ...englishVisualMessages.layout, expanded: "רחב" },
    dragHint: "משתמשים במקשי החצים.",
  };
  const html = renderToStaticMarkup(
    <VisualPlayer
      scene={primitivesDemo}
      messages={he}
      locale="ar-EG"
      reducedMotion={false}
    />,
  );
  for (const text of [
    "הפעלה",
    "ציר זמן",
    "איפוס",
    "חלופה טקסטואלית",
    "שינוי המצב",
    "תרגול אינטראקטיבי",
    "רחב",
    "תצוגה חיה",
  ])
    assert.ok(html.includes(text), text);
  for (const text of [
    ">Play<",
    ">Reset<",
    "Text equivalent",
    "Explore the state",
    "INTERACTIVE STUDY",
  ])
    assert.ok(!html.includes(text), text);
  // Arabic-Indic digits from the locale, in the readout.
  assert.match(html, /٠٫٠ \/ ٥٫٠ שנ׳/);
  // English is the default, and missing keys fall back to it.
  assert.match(
    renderToStaticMarkup(<VisualPlayer scene={primitivesDemo} />),
    /Text equivalent/,
  );
  assert.equal(visualMessages({ play: "x" }).pause, "Pause");
  assert.ok(Object.isFrozen(englishVisualMessages));
  const inspector = renderToStaticMarkup(
    <VisualInspector
      runtime={new VisualRuntime(motionStudyDemo)}
      messages={{
        runChecks: "הרצת בדיקות",
        inspectorTitle: (s) => `בודק · ${s}`,
      }}
    />,
  );
  assert.match(inspector, /הרצת בדיקות/);
  assert.match(inspector, /בודק · /);
  assert.match(inspector, /Download SVG/);
  // The drag hint reaches interactive markup.
  const drag = renderToStaticMarkup(
    <VisualPlayer scene={primitivesDemo} messages={he} />,
  );
  if (drag.includes('class="ccv-handle"'))
    assert.match(drag, /משתמשים במקשי החצים\./);
});

test("lazy player and export controls render accessibly before any browser API runs", () => {
  const lazy = renderToStaticMarkup(
    <LazyVisualPlayer
      scene={lensDemo}
      placeholder={<p>{lensDemo.accessibility.text}</p>}
    />,
  );
  assert.match(lazy, /data-lazy="waiting"/);
  assert.match(lazy, /aria-busy="true"/);
  assert.match(lazy, /Show the visual now/);
  assert.match(lazy, /A purple square/);
  assert.doesNotMatch(lazy, /<svg/);
  const controls = renderToStaticMarkup(
    <ExportControls runtime={new VisualRuntime(lensDemo)} />,
  );
  assert.match(controls, /role="group" aria-label="Export"/);
  assert.match(controls, />Download SVG<.*>Download PNG</);
  assert.match(controls, /role="status"/);
  assert.equal(
    exportFileName("lens-study", 2000.4, "png"),
    "lens-study-2000ms.png",
  );
});
