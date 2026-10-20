import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { primitivesDemo, sortingDemo } from "../src/demos.js";
import { equationMathML, layoutEquation, parseTex } from "../src/equation.js";
import { SUPPORTED_FEATURES, sceneFeatures } from "../src/features.js";
import { sanitizeMarkup, serializeMarkup } from "../src/markup.js";
import type { MarkupElement } from "../src/markup.js";
import { SceneView, VisualPlayer } from "../src/react.js";
import { evaluateScene, VisualRuntime } from "../src/runtime.js";
import { LIMITS, parseScene } from "../src/schema.js";
import { buildSceneMarkup, renderSvg } from "../src/svg.js";
import { toVisualExperience, fromVisualExperience } from "../src/sdk.js";

const SNAPSHOTS = new URL("./fixtures/primitives/", import.meta.url);
/** Deterministic snapshots; regenerate with UPDATE_SNAPSHOTS=1 after reviewing the change. */
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
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const base = () => ({
  version: 1,
  id: "prim",
  title: "Primitives",
  description: "Synthetic primitive scene",
  state: {},
  nodes: [] as unknown[],
  layouts: {
    compact: { width: 320, height: 240 },
    expanded: { width: 640, height: 480 },
  },
  timeline: { durationMs: 1000, tracks: [] as unknown[], cues: [] },
  accessibility: {
    text: "A synthetic scene.",
    reducedMotion: { atMs: 0, description: "Still." },
  },
});
const scene = (patch: Record<string, unknown>) => ({ ...base(), ...patch });
const code = (fn: () => unknown, expected: string, message?: RegExp) =>
  assert.throws(fn, (e: Error & { code?: string }) => {
    assert.equal(e.code, expected, e.message);
    if (message) assert.match(e.message, message);
    return true;
  });
const frameAt = (input: unknown, timeMs = 0, viewportWidth = 960) => {
  const runtime = new VisualRuntime(input, { viewportWidth });
  runtime.seek(timeMs);
  return runtime.getSnapshot().frame;
};
const idsAndRefs = (markup: string) => ({
  ids: [...markup.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]!),
  refs: [...markup.matchAll(/(?:url\(#|href="#)([A-Za-z0-9_-]+)/g)].map(
    (m) => m[1]!,
  ),
});

const clipped = () =>
  scene({
    defs: {
      clips: [
        {
          id: "window",
          nodes: [
            { kind: "rect", id: "win", x: 10, y: 10, width: 50, height: 40 },
          ],
        },
      ],
    },
    nodes: [
      {
        kind: "circle",
        id: "dot",
        x: 30,
        y: 30,
        radius: 40,
        fill: "#335577",
        clip: "window",
      },
    ],
    timeline: {
      durationMs: 1000,
      cues: [],
      tracks: [
        {
          node: "win",
          property: "width",
          keyframes: [
            { atMs: 0, value: 0 },
            { atMs: 1000, value: 100 },
          ],
        },
      ],
    },
  });

test("clip: shapes in scene coordinates, animated by tracks, scoped ids, deterministic snapshot", () => {
  const frame = frameAt(clipped(), 500);
  assert.equal(frame.nodes[0]!.clip, "window");
  assert.equal(frame.defs!.clips[0]!.nodes[0]!.width, 50);
  const svg = renderSvg(frame, { idPrefix: "a", title: "Clip" });
  assert.match(
    svg,
    /<clipPath id="a-clip-window" clipPathUnits="userSpaceOnUse"><rect width="50" height="40" rx="0" transform="matrix\(1 0 0 1 10 10\)"><\/rect><\/clipPath>/,
  );
  assert.match(
    svg,
    /<g clip-path="url\(#a-clip-window\)"><g data-node-id="dot"/,
  );
  snapshot("clip.svg", svg);
});

test("mask: luminance content may use gradients, groups and text", () => {
  const input = scene({
    defs: {
      masks: [
        {
          id: "fade",
          nodes: [
            {
              kind: "rect",
              id: "m",
              width: 100,
              height: 100,
              fill: { kind: "linear", from: "#ffffff", to: "#000000" },
            },
            {
              kind: "group",
              id: "mg",
              children: [
                { kind: "text", id: "mt", text: "A", y: 20, fill: "#ffffff" },
              ],
            },
          ],
        },
      ],
    },
    nodes: [
      {
        kind: "group",
        id: "bars",
        mask: "fade",
        children: [{ kind: "rect", id: "b1", width: 40, height: 80 }],
      },
    ],
  });
  const svg = renderSvg(frameAt(input), { idPrefix: "m1", title: "Mask" });
  assert.match(
    svg,
    /<mask id="m1-mask-fade" maskUnits="userSpaceOnUse" x="0" y="0" width="640" height="480">/,
  );
  assert.match(svg, /<linearGradient id="m1-fill-m"/);
  assert.match(svg, /<g mask="url\(#m1-mask-fade\)"><g data-node-id="bars"/);
  snapshot("mask.svg", svg);
});

test("validation rejects undefined clips, masks and symbols with a precise code", () => {
  code(
    () =>
      parseScene(
        scene({
          nodes: [{ kind: "rect", id: "r", width: 1, height: 1, clip: "nope" }],
        }),
      ),
    "UNDEFINED_REFERENCE",
    /undefined clip nope/,
  );
  code(
    () =>
      parseScene(
        scene({
          nodes: [{ kind: "rect", id: "r", width: 1, height: 1, mask: "nope" }],
        }),
      ),
    "UNDEFINED_REFERENCE",
    /undefined mask nope/,
  );
  code(
    () =>
      parseScene(scene({ nodes: [{ kind: "use", id: "u", symbol: "nope" }] })),
    "UNDEFINED_REFERENCE",
    /undefined symbol nope/,
  );
  // Definition ids are a namespace per kind: a mask id is not a clip.
  code(
    () =>
      parseScene(
        scene({
          defs: {
            masks: [
              {
                id: "x",
                nodes: [{ kind: "rect", id: "m", width: 1, height: 1 }],
              },
            ],
          },
          nodes: [{ kind: "rect", id: "r", width: 1, height: 1, clip: "x" }],
        }),
      ),
    "UNDEFINED_REFERENCE",
  );
});

test("definition content is restricted: no groups in clips, no links/uses/manipulation, no nested references", () => {
  const withClip = (nodes: unknown[]) =>
    scene({
      defs: { clips: [{ id: "c", nodes }] },
      nodes: [{ kind: "rect", id: "r", width: 1, height: 1, clip: "c" }],
    });
  code(
    () => parseScene(withClip([{ kind: "group", id: "g", children: [] }])),
    "SCHEMA",
    /clip cannot contain group/,
  );
  code(
    () => parseScene(withClip([{ kind: "text", id: "t", text: "x" }])),
    "SCHEMA",
    /clip cannot contain text/,
  );
  code(
    () =>
      parseScene(
        withClip([{ kind: "rect", id: "t", width: 1, height: 1, clip: "c" }]),
      ),
    "SCHEMA",
    /cannot be manipulated, clipped or masked/,
  );
  code(
    () =>
      parseScene(
        withClip([
          {
            kind: "rect",
            id: "t",
            label: "t",
            width: 1,
            height: 1,
            manipulate: { activate: { state: "s", value: 1 } },
          },
        ]),
      ),
    "SCHEMA",
  );
  code(
    () =>
      parseScene(
        scene({
          defs: {
            symbols: [
              {
                id: "s",
                width: 10,
                height: 10,
                nodes: [{ kind: "use", id: "inner", symbol: "s" }],
              },
            ],
          },
          nodes: [{ kind: "use", id: "u", symbol: "s" }],
        }),
      ),
    "SCHEMA",
    /symbol cannot contain use/,
  );
  code(
    () =>
      parseScene(
        scene({
          defs: {
            symbols: [
              {
                id: "s",
                width: 10,
                height: 10,
                nodes: [{ kind: "rect", id: "inner", width: 1, height: 1 }],
              },
            ],
          },
          nodes: [
            { kind: "rect", id: "r", width: 1, height: 1 },
            {
              kind: "link",
              id: "l",
              from: { node: "r", anchor: "auto" },
              to: { node: "inner", anchor: "auto" },
            },
          ],
        }),
      ),
    "SCHEMA",
    /Links must reference/,
  );
  code(
    () =>
      parseScene(
        scene({
          defs: {
            clips: [
              {
                id: "c",
                nodes: [{ kind: "rect", id: "dup", width: 1, height: 1 }],
              },
            ],
          },
          nodes: [{ kind: "rect", id: "dup", width: 1, height: 1, clip: "c" }],
        }),
      ),
    "SCHEMA",
    /Duplicate node dup/,
  );
});

const symbolScene = (uses: number) =>
  scene({
    defs: {
      symbols: [
        {
          id: "chip",
          width: 20,
          height: 10,
          nodes: [
            {
              kind: "rect",
              id: "chipBody",
              width: 20,
              height: 10,
              fill: "#224466",
            },
          ],
        },
      ],
    },
    nodes: Array.from({ length: uses }, (_, i) => ({
      kind: "use",
      id: `u${i}`,
      symbol: "chip",
      x: i * 22,
      y: 5,
    })),
  });

test("symbol/use: one definition, sized instances, local href only, deterministic snapshot", () => {
  const input = symbolScene(3);
  (input.nodes[1] as Record<string, unknown>).width = 40;
  (input.nodes[1] as Record<string, unknown>).height = 20;
  const frame = frameAt(input);
  assert.deepEqual(
    frame.nodes.map((n) => [n.symbol, n.width, n.height]),
    [
      ["chip", 20, 10],
      ["chip", 40, 20],
      ["chip", 20, 10],
    ],
  );
  assert.deepEqual(frame.nodes[1]!.bounds, {
    x: 22,
    y: 5,
    width: 40,
    height: 20,
  });
  const svg = renderSvg(frame, { idPrefix: "s", title: "Symbols" });
  assert.equal(svg.match(/<symbol /g)?.length, 1);
  assert.equal(svg.match(/<use href="#s-symbol-chip"/g)?.length, 3);
  assert.doesNotMatch(svg, /xlink|href="(?!#s-symbol-chip")/);
  snapshot("symbol.svg", svg);
});

test("symbol uses are bounded", () => {
  parseScene(symbolScene(LIMITS.uses));
  code(() => parseScene(symbolScene(LIMITS.uses + 1)), "USE_LIMIT");
  // Expansion budget: a large symbol used many times.
  const big = symbolScene(40);
  (
    big as unknown as { defs: { symbols: { nodes: unknown[] }[] } }
  ).defs.symbols[0]!.nodes = Array.from({ length: 120 }, (_, i) => ({
    kind: "rect",
    id: `p${i}`,
    width: 1,
    height: 1,
  }));
  code(() => parseScene(big), "USE_LIMIT", /rendered node limit/);
});

test("use has no URL surface: href fields, javascript:/external symbol names and foreignObject are refused", () => {
  const js = ["java", "script:alert(1)"].join("");
  code(
    () =>
      parseScene(
        scene({
          ...symbolScene(1),
          nodes: [{ kind: "use", id: "u", symbol: "chip", href: js }],
        }),
      ),
    "SCHEMA",
  );
  code(
    () =>
      parseScene(
        scene({
          ...symbolScene(1),
          nodes: [{ kind: "use", id: "u", symbol: js }],
        }),
      ),
    "SCHEMA",
  );
  code(
    () =>
      parseScene(
        scene({
          ...symbolScene(1),
          nodes: [
            { kind: "use", id: "u", symbol: "https://example.com/x.svg#chip" },
          ],
        }),
      ),
    "SCHEMA",
  );
  code(
    () =>
      parseScene(
        scene({
          nodes: [
            {
              kind: "foreignObject",
              id: "f",
              html: "<script>alert(1)</script>",
            },
          ],
        }),
      ),
    "SCHEMA",
  );
});

test("sanitizer allowlist: refuses script, foreignObject, handlers, external and unknown references", () => {
  const svg = (
    children: MarkupElement[],
    attrs: MarkupElement["attrs"] = {},
  ): MarkupElement => ({ tag: "svg", attrs, children });
  const js = ["java", "script:alert(1)"].join("");
  const refused: [string, MarkupElement][] = [
    ["script", svg([{ tag: "script", attrs: {}, children: ["alert(1)"] }])],
    [
      "foreignObject",
      svg([
        {
          tag: "foreignObject",
          attrs: {},
          children: [{ tag: "div", attrs: {}, children: [] }],
        },
      ]),
    ],
    [
      "event handler",
      svg([{ tag: "g", attrs: { onload: "alert(1)" }, children: [] }]),
    ],
    [
      "use javascript: href",
      svg([{ tag: "use", attrs: { href: js }, children: [] }]),
    ],
    [
      "use external href",
      svg([
        {
          tag: "use",
          attrs: { href: "https://example.com/a.svg#x" },
          children: [],
        },
      ]),
    ],
    [
      "use href to a missing id",
      svg([{ tag: "use", attrs: { href: "#missing" }, children: [] }]),
    ],
    [
      "use href to a non-symbol",
      svg([
        { tag: "rect", attrs: { id: "r" }, children: [] },
        { tag: "use", attrs: { href: "#r" }, children: [] },
      ]),
    ],
    [
      "external fill",
      svg([
        {
          tag: "g",
          attrs: { fill: "url(https://example.com/p.svg#g)" },
          children: [],
        },
      ]),
    ],
    [
      "clip-path to a gradient",
      svg([
        { tag: "linearGradient", attrs: { id: "lg" }, children: [] },
        { tag: "g", attrs: { "clip-path": "url(#lg)" }, children: [] },
      ]),
    ],
    [
      "duplicate id",
      svg([
        { tag: "g", attrs: { id: "x" }, children: [] },
        { tag: "g", attrs: { id: "x" }, children: [] },
      ]),
    ],
    ["style injection", svg([], { style: "background:url(x)" })],
    [
      "URL in an ordinary attribute",
      svg([{ tag: "g", attrs: { class: js }, children: [] }]),
    ],
    [
      "non-finite number",
      svg([{ tag: "rect", attrs: { width: Number.NaN }, children: [] }]),
    ],
    [
      "path data with letters",
      svg([{ tag: "path", attrs: { d: "M0 0 A1 1 0 0 0 1 1" }, children: [] }]),
    ],
  ];
  for (const [label, tree] of refused)
    assert.throws(() => sanitizeMarkup(tree), { code: "SANITIZE" }, label);
  // Text content is escaped, never parsed.
  assert.equal(
    serializeMarkup(
      sanitizeMarkup(
        svg([
          {
            tag: "title",
            attrs: {},
            children: ["<script>alert('x')</script>"],
          },
        ]),
      ),
    ),
    "<svg><title>&lt;script&gt;alert(&#x27;x&#x27;)&lt;/script&gt;</title></svg>",
  );
});

test("equations: constrained TeX lays out deterministically with a required text alternative", () => {
  const tex =
    "\\sigma(z)_i = \\frac{e^{z_i}}{\\sum_{j} e^{z_j}} + \\sqrt{x^2} \\cdot \\hat{y} \\leq \\text{max}";
  const layout = layoutEquation(tex, 20, "middle");
  assert.deepEqual(layout, layoutEquation(tex, 20, "middle"));
  assert.ok(layout.width > 100 && layout.ascent > 15 && layout.descent > 5);
  assert.equal(layout.offset, -layout.width / 2);
  assert.ok(layout.rules.length >= 1, "fraction bar");
  assert.ok(layout.strokes.length >= 2, "radical and hat");
  const input = scene({
    nodes: [
      {
        kind: "equation",
        id: "eq",
        label: "sigma of z sub i equals softmax",
        tex,
        x: 320,
        y: 100,
        fontSize: 20,
        align: "middle",
        fill: "#112233",
      },
    ],
  });
  const svg = renderSvg(frameAt(input), { idPrefix: "e", title: "Equation" });
  assert.match(
    svg,
    /<g role="img" aria-label="sigma of z sub i equals softmax" font-family="[^"]+">/,
  );
  assert.match(
    svg,
    /textLength="[0-9.]+" lengthAdjust="spacingAndGlyphs">σ<\/text>/,
  );
  snapshot("equation.svg", svg);
  snapshot("equation-mathml.txt", serializeMarkup(equationMathML(tex, "softmax")));
  assert.match(
    serializeMarkup(equationMathML("\\frac{a}{b}", "a over b")),
    /^<math display="inline" alttext="a over b"><mrow><mfrac><mrow><mi>a<\/mi><\/mrow><mrow><mi>b<\/mi><\/mrow><\/mfrac><\/mrow><\/math>$/,
  );
  code(
    () =>
      parseScene(scene({ nodes: [{ kind: "equation", id: "eq", tex: "x" }] })),
    "SCHEMA",
    /requires a label/,
  );
  code(
    () =>
      parseScene(
        scene({
          nodes: [{ kind: "equation", id: "eq", tex: "x", label: "  " }],
        }),
      ),
    "SCHEMA",
    /requires a label/,
  );
});

test("equations refuse markup-injecting and command-defining macros, unknown macros and unsafe characters", () => {
  for (const tex of [
    "\\href{https://example.com}{x}",
    "\\url{https://example.com}",
    "\\htmlClass{x}{y}",
    "\\htmlId{x}{y}",
    "\\htmlStyle{color:red}{y}",
    "\\htmlData{a=b}{y}",
    "\\def\\x{y}",
    "\\newcommand{\\x}{y}",
    "\\renewcommand{\\x}{y}",
    "\\let\\x\\y",
    "\\input{file}",
    "\\includegraphics{x.png}",
  ])
    code(() => parseTex(tex), "EQUATION_UNSAFE", /is not allowed/);
  code(() => parseTex("\\operatorname*{x}"), "EQUATION_SYNTAX");
  code(
    () => parseTex("\\color{red}{x}"),
    "EQUATION_MACRO",
    /unsupported macro \\color/,
  );
  code(() => parseTex("\\mathbb{R}"), "EQUATION_MACRO");
  code(() => parseTex("a & b"), "EQUATION_CHAR");
  code(() => parseTex("$x$"), "EQUATION_CHAR");
  code(() => parseTex("x # y"), "EQUATION_CHAR");
  code(() => parseTex("é"), "EQUATION_CHAR");
  code(() => parseTex("\\frac{a}"), "EQUATION_SYNTAX");
  code(() => parseTex("{a"), "EQUATION_SYNTAX");
  code(() => parseTex("a}"), "EQUATION_SYNTAX");
  code(() => parseTex("x^2^3"), "EQUATION_SYNTAX");
  code(() => parseTex("x".repeat(600)), "EQUATION_LIMIT");
  code(() => parseTex("{".repeat(20) + "x" + "}".repeat(20)), "EQUATION_LIMIT");
  // The same refusals reach scene validation with their codes.
  code(
    () =>
      parseScene(
        scene({
          nodes: [
            {
              kind: "equation",
              id: "eq",
              label: "link",
              tex: "\\href{https://example.com}{x}",
            },
          ],
        }),
      ),
    "EQUATION_UNSAFE",
  );
});

test("script text in an equation stays text: escaped in SVG and MathML, no elements created", () => {
  const tex = "\\text{<script>alert(1)</script>} < x > y";
  const input = scene({
    nodes: [
      {
        kind: "equation",
        id: "eq",
        label: "<img src=x onerror=alert(1)>",
        tex,
      },
    ],
  });
  const frame = frameAt(input);
  for (const markup of [
    renderSvg(frame, { idPrefix: "x", title: "T" }),
    renderToStaticMarkup(<SceneView frame={frame} title="T" />),
    serializeMarkup(equationMathML(tex, "<b>label</b>")),
  ]) {
    assert.doesNotMatch(markup, /<script|<img|<b>|<foreignObject/);
    assert.match(markup, /&lt;script&gt;/);
  }
});

test("headless export and the React view render the same markup for every primitive", () => {
  for (const [timeMs, width] of [
    [0, 960],
    [2500, 960],
    [5000, 320],
  ] as const) {
    const frame = frameAt(primitivesDemo, timeMs, width);
    const react = renderToStaticMarkup(
      <SceneView frame={frame} title={primitivesDemo.title} />,
    );
    const prefix = /aria-labelledby="([^"]+)-title"/.exec(react)![1]!;
    assert.equal(
      renderSvg(frame, { idPrefix: prefix, title: primitivesDemo.title }),
      react,
    );
    snapshot(
      `demo-${width}-${timeMs}.svg`,
      renderSvg(frame, { idPrefix: "demo", title: primitivesDemo.title }),
    );
  }
  // Standalone export adds only the namespace.
  const frame = frameAt(primitivesDemo);
  assert.equal(
    renderSvg(frame, { idPrefix: "z", title: "t", xmlns: true }),
    renderSvg(frame, { idPrefix: "z", title: "t" }).replace(
      "<svg ",
      '<svg xmlns="http://www.w3.org/2000/svg" ',
    ),
  );
  code(
    () => renderSvg(frame, { idPrefix: 'bad prefix"', title: "t" }),
    "ID_PREFIX",
  );
});

test("two scenes with the same definition ids on one page do not collide", () => {
  const frame = frameAt(primitivesDemo, 2500);
  const page = renderToStaticMarkup(
    <>
      <VisualPlayer scene={primitivesDemo} />
      <SceneView frame={frame} title="Second" />
      <SceneView frame={evaluateScene(clipped())} title="Third" />
    </>,
  );
  const { ids } = idsAndRefs(page);
  assert.equal(new Set(ids).size, ids.length, "ids are unique on the page");
  // Each instance's references resolve inside its own <svg>.
  const svgs = [...page.matchAll(/<svg[\s\S]*?<\/svg>/g)].map((m) => m[0]);
  assert.equal(svgs.length, 3);
  for (const svg of svgs) {
    const own = idsAndRefs(svg);
    assert.ok(own.refs.length > 0);
    for (const ref of own.refs)
      assert.ok(own.ids.includes(ref), `${ref} resolves within its scene`);
  }
  // Headless exports are scoped by their prefixes in the same way.
  const two =
    renderSvg(frame, { idPrefix: "one", title: "1" }) +
    renderSvg(frame, { idPrefix: "two", title: "2" });
  const both = idsAndRefs(two).ids;
  assert.equal(new Set(both).size, both.length);
});

test("feature detection and SDK round trip", () => {
  assert.deepEqual(sceneFeatures(primitivesDemo), [
    "clip",
    "equation",
    "gradient",
    "mask",
    "symbol",
  ]);
  assert.deepEqual(sceneFeatures(sortingDemo), ["gradient"]);
  assert.deepEqual(sceneFeatures(parseScene(clipped())), ["clip"]);
  for (const feature of sceneFeatures(primitivesDemo))
    assert.ok(SUPPORTED_FEATURES.includes(feature));
  const experience = toVisualExperience(primitivesDemo);
  assert.deepEqual(fromVisualExperience(clone(experience)), primitivesDemo);
});

test("the text equivalent lists each equation with its label and MathML", () => {
  const html = renderToStaticMarkup(<VisualPlayer scene={primitivesDemo} />);
  assert.match(
    html,
    /<ul class="ccv-equations" aria-label="Equations"><li><span>y equals sine of omega t<\/span> <math display="inline" alttext="y equals sine of omega t">/,
  );
  assert.doesNotMatch(
    renderToStaticMarkup(<VisualPlayer scene={sortingDemo} />),
    /ccv-equations|<math/,
  );
});
