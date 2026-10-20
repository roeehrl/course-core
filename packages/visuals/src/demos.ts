import type {
  Expression,
  ReferenceCheck,
  Scene,
  SceneNode,
  Track,
} from "./types.js";
import { flattenNodes } from "./geometry.js";
import { parseScene } from "./schema.js";

const op = (
  name:
    | "add"
    | "sub"
    | "mul"
    | "div"
    | "mod"
    | "sin"
    | "eq"
    | "if"
    | "concat"
    | "round"
    | "gte"
    | "lt",
  ...args: Expression[]
): Expression => ({ op: name, args });
const s = (state: string): Expression => ({ state });
const time: Expression = { time: true };
const ink = "#263655",
  muted = "#6b7893",
  purple = "#7760df",
  teal = "#2b968c",
  orange = "#df9756";
const txt = (
  id: string,
  text: Expression,
  x: Expression,
  y: Expression,
  size = 18,
  fill = muted,
): Extract<SceneNode, { kind: "text" }> => ({
  kind: "text",
  id,
  text,
  x,
  y,
  fontSize: size,
  fill,
});
const circle = (
  id: string,
  x: Expression,
  y: Expression,
  radius: Expression,
  fill: string,
  opacity: Expression = 1,
): Extract<SceneNode, { kind: "circle" }> => ({
  kind: "circle",
  id,
  x,
  y,
  radius,
  fill,
  opacity,
});
const rect = (
  id: string,
  x: Expression,
  y: Expression,
  width: Expression,
  height: Expression,
  fill: string,
  r = 12,
): Extract<SceneNode, { kind: "rect" }> => ({
  kind: "rect",
  id,
  x,
  y,
  width,
  height,
  fill,
  cornerRadius: r,
});

function sorting(): Scene {
  const values = [6, 2, 5, 1, 4, 3],
    order = [...values],
    steps = [[...order]],
    cues = [
      {
        atMs: 0,
        text: "Six values begin out of order. Compare neighbors, then exchange them when the left value is larger.",
      },
    ];
  for (let end = order.length - 1; end > 0; end--)
    for (let i = 0; i < end; i++)
      if (order[i]! > order[i + 1]!) {
        const a = order[i]!,
          b = order[i + 1]!;
        [order[i], order[i + 1]] = [b, a];
        steps.push([...order]);
        cues.push({
          atMs: (steps.length - 1) * 850,
          text: `Exchange ${a} and ${b}. Current order: ${order.join(", ")}.`,
        });
      }
  const durationMs = (steps.length - 1) * 850 + 900;
  cues.push({
    atMs: durationMs,
    text: "Ordered: 1, 2, 3, 4, 5, 6. Each exchange preserves every value.",
  });
  const tracks: Track[] = values.flatMap((value) => [
    {
      node: `bar${value}`,
      property: "x" as const,
      keyframes: steps.map((step, i) => ({
        atMs: i * 850,
        value: step.indexOf(value) * 88,
        ease: "smooth" as const,
      })),
    },
  ]);
  const nodes: SceneNode[] = [
    txt("sortingKicker", "SMALL EXCHANGES. VISIBLE PROGRESS.", 42, 44, 13),
    {
      kind: "group",
      id: "bars",
      x: 52,
      y: 322,
      children: [
        {
          kind: "line",
          id: "baseline",
          x: -12,
          y: 1,
          x2: 540,
          y2: 0,
          stroke: "#d6ddec",
          strokeWidth: 2,
        },
        ...values.map(
          (value): SceneNode => ({
            kind: "group",
            id: `bar${value}`,
            x: values.indexOf(value) * 88,
            label: `Select value ${value}`,
            manipulate: { activate: { state: "selected", value } },
            children: [
              {
                ...rect(`shadow${value}`, 4, 8, 64, 12, "#263655", 6),
                opacity: 0.06,
              },
              {
                ...rect(
                  `column${value}`,
                  0,
                  -value * 35,
                  64,
                  value * 35,
                  "#7760df",
                  14,
                ),
                fill: {
                  kind: "linear",
                  from: value % 2 ? "#ac98f4" : "#65b8b0",
                  to: value % 2 ? "#7760df" : "#288c87",
                },
              },
              {
                ...circle(
                  `selected${value}`,
                  32,
                  -value * 35 - 22,
                  7,
                  "#dd9861",
                ),
                opacity: op("if", op("eq", s("selected"), value), 1, 0),
              },
              {
                ...txt(
                  `value${value}`,
                  value,
                  32,
                  -value * 35 + 31,
                  25,
                  "#ffffff",
                ),
                align: "middle",
                weight: "bold",
              },
            ],
          }),
        ),
        ...values.map(
          (_, i): SceneNode => ({
            ...txt(
              `slot${i}`,
              String(i + 1).padStart(2, "0"),
              i * 88 + 32,
              40,
              16,
            ),
            align: "middle",
            visible: s("guides"),
          }),
        ),
      ],
    },
    {
      kind: "group",
      id: "sortNote",
      x: 656,
      y: 160,
      children: [
        rect("sortNoteBg", 0, 0, 208, 158, "#efedf9", 18),
        txt("sortNoteLabel", "THE INVARIANT", 20, 34, 11, purple),
        txt("sortNoteNumber", "6", 20, 90, 48, ink),
        txt("sortNoteWords", "values, always", 66, 90, 17, ink),
        txt("sortNoteDetail", "Only their order changes.", 20, 129, 13, muted),
      ],
    },
    txt(
      "sortFooter",
      "Tap a bar to follow one value through the sequence.",
      42,
      420,
      14,
    ),
  ];
  return parseScene({
    version: 1,
    id: "neighbor-sort",
    title: "Order from motion",
    description:
      "Watch a simple exchange become a sorted sequence. Scrub time, select a value, and follow the invariant.",
    state: {
      selected: {
        kind: "number",
        label: "Follow value",
        initial: 6,
        min: 1,
        max: 6,
        step: 1,
      },
      guides: { kind: "boolean", label: "Position guides", initial: true },
    },
    controls: ["selected", "guides"],
    nodes,
    layouts: {
      expanded: { width: 920, height: 450 },
      compact: {
        width: 420,
        height: 515,
        overrides: {
          sortingKicker: { x: 24, y: 40, fontSize: 11 },
          bars: { x: 33, y: 266, scale: 0.68 },
          sortNote: { x: 24, y: 330, scale: 1 },
          sortNoteBg: { width: 372, height: 112 },
          sortNoteNumber: { y: 84, fontSize: 38 },
          sortNoteWords: { y: 82, x: 58 },
          sortNoteDetail: { x: 173, y: 78, fontSize: 12 },
          sortFooter: { x: 24, y: 485, fontSize: 10.5 },
        },
      },
    },
    timeline: { durationMs, tracks, cues },
    accessibility: {
      text: "A neighbor-exchange sorting illustration. Bar height and printed number encode the same value. The sequence starts 6, 2, 5, 1, 4, 3 and ends 1, 2, 3, 4, 5, 6.",
      reducedMotion: {
        atMs: durationMs,
        description:
          "The completed order is shown without playback. Use the timeline to inspect individual exchanges or read the exchange list.",
      },
    },
    referenceChecks: ["sort-invariant"],
  });
}
function motion(): Scene {
  const phase = op("div", time, 6000),
    x = op("add", 20, op("mul", phase, 520)),
    y = op(
      "sub",
      210,
      op("mul", s("amplitude"), op("sin", op("mul", phase, Math.PI))),
    );
  const points = Array.from({ length: 41 }, (_, i) => ({
    x: i / 40,
    // Keep transcendental computation in the expression, rather than serializing
    // platform-specific libm rounding into the authored scene artifact.
    y: op("mul", s("amplitude"), op("sin", (i / 40) * Math.PI)),
  }));
  return parseScene({
    version: 1,
    id: "arc-motion",
    title: "A path with possibilities",
    description:
      "One curve, many journeys. Change its height, drag the target, and explore a seeded, repeatable trail.",
    state: {
      amplitude: {
        kind: "number",
        label: "Arc height",
        initial: 145,
        min: 40,
        max: 180,
        step: 5,
      },
      target: {
        kind: "number",
        label: "Target position",
        initial: 80,
        min: 0,
        max: 100,
        step: 1,
      },
      spark: {
        kind: "number",
        label: "Seeded sparkle",
        initial: 0,
        min: 0,
        max: 1,
        step: 0.01,
      },
      trail: { kind: "boolean", label: "Show reference path", initial: true },
    },
    controls: ["amplitude", "target", "trail"],
    nodes: [
      txt("motionKicker", "CONTINUOUS MOTION / DISCRETE STATE", 42, 44, 13),
      {
        kind: "group",
        id: "motionChart",
        x: 50,
        y: 106,
        children: [
          ...[0, 1, 2, 3].map(
            (i): SceneNode => ({
              kind: "line",
              id: `grid${i}`,
              x: 20,
              y: 30 + i * 60,
              x2: 520,
              y2: 0,
              stroke: "#dce3ef",
              strokeWidth: 1,
            }),
          ),
          {
            ...rect("arcArea", 20, 30, 520, 180, "#e8e6f7", 12),
            opacity: 0.35,
          },
          {
            kind: "plot",
            id: "arcPlot",
            x: 20,
            y: 30,
            width: 520,
            height: 180,
            domainX: [0, 1],
            domainY: [0, 180],
            points,
            stroke: "#b0a1e0",
            strokeWidth: 3,
            fill: "none",
            visible: s("trail"),
          },
          {
            ...circle(
              "targetHalo",
              op("add", 20, op("mul", s("target"), 5.2)),
              210,
              24,
              "#eacba3",
            ),
            opacity: 0.45,
          },
          {
            kind: "circle",
            id: "target",
            x: op("add", 20, op("mul", s("target"), 5.2)),
            y: 210,
            radius: 12,
            fill: orange,
            stroke: "#ffffff",
            strokeWidth: 4,
            label: "Move target",
            manipulate: { x: { state: "target", from: 20, to: 540 } },
          },
          circle(
            "cometHalo",
            x,
            y,
            op("add", 25, op("mul", s("spark"), 9)),
            "#c5b4f1",
            0.25,
          ),
          circle("cometRing", x, y, 22, "#e3dcfa", 0.75),
          {
            kind: "circle",
            id: "comet",
            x,
            y,
            radius: 14,
            fill: { kind: "linear", from: "#a494f1", to: "#5b49af" },
            stroke: "#ffffff",
            strokeWidth: 4,
          },
          txt("originLabel", "START", 20, 256, 13),
          txt("finishLabel", "ARRIVE", 476, 256, 13),
          txt(
            "targetLabel",
            "Drag the amber target along the baseline.",
            20,
            294,
            17,
          ),
        ],
      },
      {
        kind: "group",
        id: "motionNote",
        x: 664,
        y: 148,
        children: [
          rect("motionNoteBg", 0, 0, 210, 185, "#ffffff", 18),
          txt("motionNoteLabel", "POSITION", 20, 35, 11, purple),
          txt(
            "motionPercent",
            op("concat", op("round", op("mul", phase, 100)), "%"),
            20,
            101,
            48,
            ink,
          ),
          txt("motionNoteDetail", "of the journey", 20, 132, 15),
          txt("seedLabel", "REPLAY SEED  ·  42", 20, 162, 10, teal),
        ],
      },
      txt(
        "motionFooter",
        "The same seed and inputs reproduce the same simulation.",
        42,
        447,
        14,
      ),
    ],
    layouts: {
      expanded: { width: 920, height: 480 },
      compact: {
        width: 420,
        height: 595,
        overrides: {
          motionKicker: { x: 24, y: 40, fontSize: 10 },
          motionChart: { x: 20, y: 95, scale: 0.69 },
          motionNote: { x: 24, y: 355 },
          motionNoteBg: { width: 372, height: 150 },
          motionNoteLabel: { y: 32 },
          motionPercent: { y: 97, fontSize: 44 },
          motionNoteDetail: { x: 145, y: 91 },
          seedLabel: { y: 129 },
          motionFooter: { x: 24, y: 550, fontSize: 10.5 },
        },
      },
    },
    timeline: {
      durationMs: 6000,
      tracks: [],
      cues: [
        {
          atMs: 0,
          text: "Depart from the origin. Arc height changes the trajectory; the amber target is independently movable.",
        },
        {
          atMs: 3000,
          text: "At halfway, the moving point reaches the peak of the chosen arc.",
        },
        {
          atMs: 6000,
          text: "Arrival returns to the baseline. Replay restores the same seeded sparkle at every fixed tick.",
        },
      ],
    },
    simulation: {
      seed: 42,
      stepMs: 50,
      updates: { spark: { sample: "sparkle" } },
    },
    accessibility: {
      text: "A point travels left to right along a sine arc. Its horizontal position progresses uniformly; its vertical position rises to the chosen arc height at halfway and returns to zero at arrival. A target can be moved from 0 to 100 with a slider or arrow keys.",
      reducedMotion: {
        atMs: 3000,
        description:
          "The point is shown at the peak. No automatic animation runs. Choose individual times with the timeline slider.",
      },
    },
    referenceChecks: ["motion-finite"],
  });
}
function transitions(): Scene {
  const names = ["Prepare", "Explore", "Reflect"],
    colors = [purple, teal, orange];
  const nodes: SceneNode[] = [
    txt("flowKicker", "A SYSTEM YOU CAN STEER", 42, 44, 13),
    {
      kind: "link",
      id: "linkA",
      from: { node: "stage0", anchor: "auto" },
      to: { node: "stage1", anchor: "auto" },
      stroke: "#cec7e8",
      strokeWidth: 3,
      fill: "none",
      arrow: true,
    },
    {
      kind: "link",
      id: "linkB",
      from: { node: "stage1", anchor: "auto" },
      to: { node: "stage2", anchor: "auto" },
      stroke: "#b8d9d2",
      strokeWidth: 3,
      fill: "none",
      arrow: true,
    },
    ...names.map(
      (name, i): SceneNode => ({
        kind: "group",
        id: `stage${i}`,
        x: 42 + i * 292,
        y: 108,
        label: `Select ${name}`,
        manipulate: { activate: { state: "stage", value: name } },
        children: [
          {
            ...rect(`card${i}`, 0, 0, 250, 220, "#ffffff", 22),
            stroke: "#dde3ed",
            strokeWidth: 1,
          },
          {
            ...rect(`active${i}`, 0, 0, 250, 6, colors[i]!, 3),
            opacity: op("if", op("eq", s("stage"), name), 1, 0.15),
          },
          circle(`disc${i}`, 44, 52, 22, ["#eee9ff", "#e1f3ee", "#f8eddf"][i]!),
          {
            ...txt(
              `index${i}`,
              String(i + 1).padStart(2, "0"),
              44,
              58,
              16,
              colors[i]!,
            ),
            align: "middle",
            weight: "bold",
          },
          { ...txt(`name${i}`, name, 22, 115, 28, ink), weight: "bold" },
          txt(
            `desc${i}`,
            [
              "Choose a direction.",
              "Try, change, observe.",
              "Notice what changed.",
            ][i]!,
            22,
            149,
            15,
          ),
          txt(
            `status${i}`,
            op(
              "if",
              op("eq", s("stage"), name),
              "●  CURRENT STATE",
              "○  SELECT TO ENTER",
            ),
            22,
            191,
            11,
            colors[i]!,
          ),
        ],
      }),
    ),
    {
      kind: "group",
      id: "flowFooter",
      x: 42,
      y: 390,
      children: [
        rect("flowPill", 0, -24, 832, 54, "#eeedf8", 12),
        txt(
          "flowState",
          op(
            "concat",
            "Current state: ",
            s("stage"),
            ".  Every transition is explicit and replayable.",
          ),
          20,
          9,
          16,
          ink,
        ),
      ],
    },
  ];
  return parseScene({
    version: 1,
    id: "state-transitions",
    title: "Small states, clear transitions",
    description:
      "A three-state system, made tangible. Select any card or use the keyboard; every choice becomes replayable state.",
    state: {
      stage: {
        kind: "enum",
        label: "Current stage",
        initial: "Prepare",
        options: names,
      },
    },
    controls: ["stage"],
    nodes,
    layouts: {
      expanded: { width: 920, height: 470 },
      compact: {
        width: 420,
        height: 814,
        overrides: {
          flowKicker: { x: 26, y: 40, fontSize: 11 },
          stage0: { x: 30, y: 74 },
          stage1: { x: 30, y: 293 },
          stage2: { x: 30, y: 512 },
          card0: { width: 360, height: 194 },
          card1: { width: 360, height: 194 },
          card2: { width: 360, height: 194 },
          active0: { width: 360 },
          active1: { width: 360 },
          active2: { width: 360 },
          name0: { x: 80, y: 62 },
          name1: { x: 80, y: 62 },
          name2: { x: 80, y: 62 },
          desc0: { y: 111 },
          desc1: { y: 111 },
          desc2: { y: 111 },
          status0: { y: 157 },
          status1: { y: 157 },
          status2: { y: 157 },
          flowFooter: { x: 30, y: 765 },
          flowPill: { width: 360 },
          flowState: { fontSize: 8.8, x: 12 },
        },
      },
    },
    timeline: {
      durationMs: 6000,
      tracks: [
        {
          node: "disc0",
          property: "scale",
          keyframes: [
            { atMs: 0, value: 1 },
            { atMs: 1000, value: 1.2, ease: "smooth" },
            { atMs: 2000, value: 1, ease: "smooth" },
          ],
        },
        {
          node: "disc1",
          property: "scale",
          keyframes: [
            { atMs: 0, value: 1 },
            { atMs: 2000, value: 1 },
            { atMs: 3000, value: 1.2, ease: "smooth" },
            { atMs: 4000, value: 1, ease: "smooth" },
          ],
        },
        {
          node: "disc2",
          property: "scale",
          keyframes: [
            { atMs: 0, value: 1 },
            { atMs: 4000, value: 1 },
            { atMs: 5000, value: 1.2, ease: "smooth" },
            { atMs: 6000, value: 1, ease: "smooth" },
          ],
        },
      ],
      cues: [
        {
          atMs: 0,
          text: "Prepare: decide where to begin. Select a card to set the state.",
        },
        {
          atMs: 2000,
          text: "Explore: vary an input and observe its effect. The timeline illustrates attention; your selection controls state.",
        },
        {
          atMs: 4000,
          text: "Reflect: compare what you expected with what you observed.",
        },
      ],
    },
    accessibility: {
      text: "Three connected cards are labeled Prepare, Explore, and Reflect. The current state is shown with both text and a colored accent. Select a card with Enter or Space, or choose a stage in the dropdown. The decorative timeline does not change your selection.",
      reducedMotion: {
        atMs: 0,
        description:
          "Cards remain still. All three states remain available through buttons and the dropdown.",
      },
    },
  });
}
function primitives(): Scene {
  const wave = Array.from({ length: 65 }, (_, i) => ({
    x: Math.round(((i * Math.PI * 2) / 64) * 1e4) / 1e4,
    y: Math.round(Math.sin((i * Math.PI * 2) / 64) * 1e4) / 1e4 || 0,
  }));
  const heights = [118, 84, 52, 30, 16];
  return parseScene({
    version: 1,
    id: "primitives",
    title: "Reveal, repeat, relate",
    description:
      "A clip reveals a curve, a mask fades a set of bars, one symbol is reused for every token, and equations carry text alternatives.",
    state: {
      count: {
        label: "Tokens shown",
        kind: "number",
        initial: 3,
        min: 1,
        max: 5,
        step: 1,
      },
    },
    controls: ["count"],
    defs: {
      clips: [
        {
          id: "reveal",
          nodes: [
            {
              kind: "rect",
              id: "revealWindow",
              x: 36,
              y: 84,
              width: 0,
              height: 180,
            },
          ],
        },
      ],
      masks: [
        {
          id: "fade",
          nodes: [
            {
              kind: "rect",
              id: "fadeRect",
              x: 470,
              y: 300,
              width: 420,
              height: 140,
              fill: { kind: "linear", from: "#ffffff", to: "#000000" },
            },
          ],
        },
      ],
      symbols: [
        {
          id: "token",
          width: 60,
          height: 60,
          nodes: [
            rect("tokenBody", 2, 2, 56, 56, "#efeafd", 14),
            circle("tokenDot", 30, 30, 11, purple),
          ],
        },
      ],
    },
    nodes: [
      txt("primitivesKicker", "CLIP · MASK · SYMBOL · EQUATION", 42, 44, 13),
      {
        kind: "plot",
        id: "wave",
        label: "Sine wave",
        x: 42,
        y: 96,
        width: 380,
        height: 150,
        domainX: [0, 6.2832],
        domainY: [-1.2, 1.2],
        points: wave,
        fill: "none",
        stroke: purple,
        strokeWidth: 4,
        clip: "reveal",
      },
      {
        kind: "equation",
        id: "waveEquation",
        label: "y equals sine of omega t",
        tex: "y = \\sin(\\omega t)",
        x: 42,
        y: 300,
        fontSize: 26,
        fill: ink,
      },
      {
        kind: "equation",
        id: "softmaxEquation",
        label:
          "sigma of z, sub i, equals e to the z sub i, divided by the sum over j of e to the z sub j",
        tex: "\\sigma(z)_i = \\frac{e^{z_i}}{\\sum_{j} e^{z_j}}",
        x: 480,
        y: 120,
        fontSize: 26,
        fill: ink,
      },
      ...[0, 1, 2, 3, 4].map(
        (i): SceneNode => ({
          kind: "use",
          id: `token${i + 1}`,
          symbol: "token",
          x: 480 + i * 78,
          y: 186,
          visible: { op: "gte", args: [s("count"), i + 1] },
        }),
      ),
      {
        kind: "group",
        id: "bars",
        x: 480,
        y: 300,
        mask: "fade",
        children: heights.map((h, i) =>
          rect(`fadeBar${i + 1}`, i * 78, 130 - h, 56, h, teal, 10),
        ),
      },
      txt(
        "primitivesFooter",
        "Definitions are scoped to this scene; nothing loads from a URL.",
        42,
        458,
        14,
      ),
    ],
    layouts: {
      expanded: { width: 920, height: 480 },
      compact: {
        width: 400,
        height: 720,
        overrides: {
          primitivesKicker: { x: 24, y: 40, fontSize: 11 },
          wave: { x: 24, width: 340 },
          revealWindow: { x: 18 },
          waveEquation: { x: 24, y: 300, fontSize: 22 },
          softmaxEquation: { x: 24, y: 380, fontSize: 22 },
          token1: { x: 24, y: 430, width: 56, height: 56 },
          token2: { x: 94, y: 430, width: 56, height: 56 },
          token3: { x: 164, y: 430, width: 56, height: 56 },
          token4: { x: 234, y: 430, width: 56, height: 56 },
          token5: { x: 304, y: 430, width: 56, height: 56 },
          bars: { x: 24, y: 520, scale: 0.85 },
          fadeRect: { x: 14, y: 510, width: 360 },
          primitivesFooter: { x: 24, y: 696, fontSize: 10.5 },
        },
      },
    },
    timeline: {
      durationMs: 5000,
      tracks: [
        {
          node: "revealWindow",
          property: "width",
          keyframes: [
            { atMs: 0, value: 0 },
            { atMs: 4000, value: 400, ease: "smooth" },
          ],
        },
      ],
      cues: [
        { atMs: 0, text: "The clip window starts closed." },
        {
          atMs: 2000,
          text: "The clip window widens and reveals the curve from the left.",
        },
        {
          atMs: 4000,
          text: "The whole period is visible. The masked bars fade toward the lower right.",
        },
      ],
    },
    accessibility: {
      text: "Left: one period of a sine wave, revealed from left to right by a widening clip window, labelled y equals sine of omega t. Right: the softmax equation, a row of identical tokens drawn from one reusable symbol, and five decreasing bars that fade out under a gradient mask.",
      reducedMotion: {
        atMs: 5000,
        description: "The curve is shown fully revealed. No animation runs.",
      },
    },
  });
}
/** Frame digests of the running-max scene (regenerate with goldenFrames after a reviewed change). */
const GOLDENS: { atMs: number; layout: "compact" | "wide"; digest: string }[] =
  [
    {
      atMs: 0,
      layout: "compact",
      digest:
        "sha256-658f025faf6dd920b5888d95d7a2feb3298fb12499f90c330156e31ef4aaf26e",
    },
    {
      atMs: 2950,
      layout: "compact",
      digest:
        "sha256-9ef16931916055007bd327252f146431c23e5f9b9a7824feb320d93db9e76c5c",
    },
    {
      atMs: 6600,
      layout: "compact",
      digest:
        "sha256-c29cd8b62c27bbf1ded1e003ac8bf3cc4dd3e1795f8e7b8782c6c843a8bd372a",
    },
    {
      atMs: 0,
      layout: "wide",
      digest:
        "sha256-b01e31b54ec46f260e6189121026b8921fa2279e1544189ba07d6ef3e40678d1",
    },
    {
      atMs: 2950,
      layout: "wide",
      digest:
        "sha256-faa229c2780c1c1a2e57e7b9884b9bfb5ef7c439818bc3013ebb9544d4ffca16",
    },
    {
      atMs: 6600,
      layout: "wide",
      digest:
        "sha256-b637eb1689b80bf2dae30398aaf2cccbc0c3b41299bf4d6561f369b8806e82df",
    },
  ];
function runningMax(): Scene {
  const xs = [3, 7, 4, 9, 2, 6],
    ms = xs.map((_, i) => Math.max(...xs.slice(0, i + 1))),
    unit = 20,
    base = 220,
    start = 1500,
    stepMs = 900,
    center = (i: number) => i * 80 + 28;
  const step: Expression = {
    op: "clamp",
    args: [
      { op: "floor", args: [op("div", op("sub", time, start), stepMs)] },
      0,
      xs.length - 1,
    ],
  };
  const pick = (values: number[]): Expression =>
    values
      .slice(0, -1)
      .reduceRight<Expression>(
        (rest, v, i) => op("if", op("eq", step, i), v, rest),
        values.at(-1)!,
      );
  const at = (k: number) => start + k * stepMs;
  // Hold each value until its step begins, then spring to the next one.
  const springTo = (values: number[]) => [
    { atMs: 0, value: values[0]! },
    ...values.slice(1).flatMap((value, k) => [
      { atMs: at(k + 1), value: values[k]! },
      {
        atMs: at(k + 1) + 800,
        value,
        ease: "spring" as const,
        spring: { stiffness: 210, damping: 18, mass: 1 },
      },
    ]),
  ];
  const layout = (
    width: number,
    height: number,
    chart: { x: number; y: number; scale: number },
    footer: { y: number; fontSize: number },
  ) => ({
    width,
    height,
    overrides: {
      chart: chart,
      maxFooter: { x: chart.x, ...footer },
      maxKicker: { x: chart.x },
    },
  });
  const wide = layout(
    1000,
    400,
    { x: 260, y: 70, scale: 1 },
    { y: 380, fontSize: 14 },
  );
  return parseScene({
    version: 1,
    id: "running-max",
    title: "Keep the largest so far",
    description:
      "Bars pop in one after another, a pointer springs from value to value, and the code, table and formula panes follow the same step.",
    state: {},
    nodes: [
      txt("maxKicker", "SPRING · STAGGER · SYNCHRONIZED PANES", 40, 40, 13),
      {
        kind: "group",
        id: "chart",
        x: 40,
        y: 70,
        children: [
          ...xs.map(
            (x, i): SceneNode => ({
              ...rect(
                `maxBar${i + 1}`,
                i * 80 + 56,
                base,
                56,
                x * unit,
                teal,
                8,
              ),
              label: `Value ${x}`,
              rotation: 180,
            }),
          ),
          ...xs.map((x, i) =>
            txt(
              `maxValue${i + 1}`,
              String(x),
              center(i) - 5,
              base + 26,
              16,
              ink,
            ),
          ),
          {
            kind: "line",
            id: "bestLine",
            x: -8,
            y: base - xs[0]! * unit,
            x2: 488,
            y2: 0,
            stroke: orange,
            strokeWidth: 3,
            fill: "none",
          },
          circle("pointer", center(0), base + 48, 9, purple),
        ],
      },
      txt(
        "maxFooter",
        "The orange line is the largest value seen so far.",
        40,
        380,
        14,
      ),
    ],
    layouts: {
      compact: layout(
        400,
        340,
        { x: 22, y: 80, scale: 0.72 },
        { y: 318, fontSize: 11 },
      ),
      expanded: wide,
      tabletPortrait: layout(
        680,
        400,
        { x: 90, y: 70, scale: 1 },
        { y: 380, fontSize: 13 },
      ),
      tabletLandscape: layout(
        860,
        400,
        { x: 190, y: 70, scale: 1 },
        { y: 380, fontSize: 14 },
      ),
      wide,
    },
    timeline: {
      durationMs: at(xs.length - 1) + 1200,
      tracks: [
        {
          node: "pointer",
          property: "x",
          keyframes: springTo(xs.map((_, i) => center(i))),
        },
        {
          node: "bestLine",
          property: "y",
          keyframes: springTo(ms.map((m) => base - m * unit)),
        },
      ],
      staggers: [
        {
          nodes: xs.map((_, i) => `maxBar${i + 1}`),
          property: "scale",
          delayMs: 120,
          keyframes: [
            { atMs: 0, value: 0.001 },
            {
              atMs: 700,
              value: 1,
              ease: "spring",
              spring: { stiffness: 260, damping: 16, mass: 1 },
            },
          ],
        },
      ],
      cues: [
        { atMs: 0, text: "The bars appear one after another." },
        {
          atMs: at(0),
          text: "Start: the largest so far is the first value, 3.",
        },
        ...xs.slice(1).map((x, k) => ({
          atMs: at(k + 1),
          text:
            x > ms[k]!
              ? `${x} is larger than ${ms[k]}, so it becomes the largest so far.`
              : `${x} is not larger than ${ms[k]}; the largest stays ${ms[k]}.`,
        })),
      ],
    },
    panes: [
      {
        id: "code",
        kind: "code",
        title: "Code",
        language: "python",
        lines: [
          "best = values[0]",
          "for x in values[1:]:",
          "    if x > best:",
          "        best = x",
        ],
        highlightLine: op(
          "if",
          op("eq", step, 0),
          1,
          op(
            "if",
            { op: "or", args: [op("eq", step, 1), op("eq", step, 3)] },
            4,
            3,
          ),
        ),
      },
      {
        id: "trace",
        kind: "table",
        title: "Trace",
        columns: ["i", "x", "best"],
        rows: xs.map((x, i) => [i, x, ms[i]!]),
        highlightRow: step,
      },
      {
        id: "rule",
        kind: "formula",
        title: "Rule",
        tex: "m_i = \\max(m_{i-1}, x_i)",
        label: "m sub i equals the maximum of m sub i minus one and x sub i",
        values: [
          { symbol: "i", value: step },
          { symbol: "x_i", value: pick(xs) },
          { symbol: "m_i", value: pick(ms) },
        ],
      },
    ],
    // The SVG, the trace table and the formula must tell the same story (S05).
    invariants: [
      {
        id: "pointer-on-traced-bar",
        description: "The settled pointer is on the bar the trace highlights",
        times: xs.map((_, k) => at(k) + 850),
        assert: op(
          "lt",
          {
            op: "abs",
            args: [
              op(
                "sub",
                { node: "pointer", property: "x" } as never,
                op("add", 28, op("mul", 80, { highlight: "trace" } as never)),
              ),
            ],
          },
          1.5,
        ),
      },
      {
        id: "line-at-traced-best",
        description:
          "The settled orange line sits at the best value the trace shows",
        times: xs.map((_, k) => at(k) + 850),
        assert: op(
          "lt",
          {
            op: "abs",
            args: [
              op(
                "sub",
                { node: "bestLine", property: "y" } as never,
                op(
                  "sub",
                  base,
                  op("mul", unit, {
                    cell: {
                      pane: "trace",
                      row: { highlight: "trace" },
                      column: 2,
                    },
                  } as never),
                ),
              ),
            ],
          },
          1.5,
        ),
      },
      {
        id: "formula-matches-trace",
        description:
          "The formula's x and m values equal the highlighted trace row",
        assert: {
          op: "and",
          args: [
            op(
              "eq",
              { value: { pane: "rule", symbol: "x_i" } } as never,
              {
                cell: { pane: "trace", row: { highlight: "trace" }, column: 1 },
              } as never,
            ),
            op(
              "eq",
              { value: { pane: "rule", symbol: "m_i" } } as never,
              {
                cell: { pane: "trace", row: { highlight: "trace" }, column: 2 },
              } as never,
            ),
          ],
        },
      },
    ],
    goldens: GOLDENS,
    accessibility: {
      text: "Six bars with values 3, 7, 4, 9, 2 and 6. A pointer moves along them in order; an orange line marks the largest value seen so far, which becomes 7 at the second bar and 9 at the fourth. The code, trace table and formula panes highlight the same step.",
      reducedMotion: {
        atMs: at(xs.length - 1),
        description: "The last step is shown: the largest value is 9.",
      },
    },
  });
}
export const sortingDemo = sorting();
export const motionDemo = motion();
export const transitionsDemo = transitions();
/** Uses the 0.2 primitives (clip, mask, symbol/use, equation); not part of demoScenes. */
export const primitivesDemo = primitives();
/** Uses the 0.3 motion features (spring, stagger, layout set, panes); not in demoScenes. */
export const motionStudyDemo = runningMax();
export const demoScenes: readonly Scene[] = [
  sortingDemo,
  motionDemo,
  transitionsDemo,
];
export const demoReferenceChecks: Readonly<Record<string, ReferenceCheck>> = {
  "sort-invariant"(frame) {
    const bars = flattenNodes(frame.nodes).filter((n) =>
      /^bar[1-6]$/.test(n.id),
    );
    const preserved =
      bars.length === 6 && new Set(bars.map((n) => n.id)).size === 6;
    const sorted =
      frame.timeMs < frame.durationMs ||
      bars.sort((a, b) => a.x - b.x).every((n, i) => n.id === `bar${i + 1}`);
    return {
      passed: preserved && sorted,
      message: "Six values preserved; final order is increasing.",
    };
  },
  "motion-finite"(frame) {
    return {
      passed: flattenNodes(frame.nodes).every((n) =>
        n.matrix.every(Number.isFinite),
      ),
      message: "All motion transforms are finite.",
    };
  },
};
