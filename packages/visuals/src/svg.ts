import { visualError } from "./errors.js";
import { VisualError } from "./expression.js";
import { flattenNodes } from "./geometry.js";
import { imageHref } from "./image.js";
import { sanitizeMarkup, serializeMarkup } from "./markup.js";
import type { MarkupElement } from "./markup.js";
import type { Frame, FrameCamera, GeometryNode } from "./types.js";

export interface SceneMarkupOptions {
  /** Prefix for every element id. Must be unique per scene instance on a page. */
  idPrefix: string;
  title: string;
  className?: string;
  /** Adds the focus, role and label attributes the React view's handlers need. */
  interactive?: boolean;
  /** Adds the SVG namespace, for a standalone .svg file. */
  xmlns?: boolean;
  /** Spoken after a draggable part's name (interactive only); defaults to English. */
  dragHint?: string;
}
const DRAG_HINT =
  "Use arrow keys; Home and End set limits. Shift changes by ten steps.";

const EQUATION_FONT =
  "STIX Two Text, Cambria, Times New Roman, Latin Modern Roman, serif";
const PREFIX = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const el = (
  tag: string,
  attrs: MarkupElement["attrs"] = {},
  children: MarkupElement["children"] = [],
): MarkupElement => ({ tag, attrs, children });
const paint = (uid: string, n: GeometryNode) =>
  typeof n.fill === "string" ? n.fill : `url(#${uid}-fill-${n.id})`;
const ASPECT = {
  contain: "xMidYMid meet",
  cover: "xMidYMid slice",
  fill: "none",
} as const;
const short = (n: number) => String(Math.round(n * 1e4) / 1e4);
/** The viewBox a camera shows: `zoom` times closer, centred on (x, y). */
export function cameraViewBox(
  frame: Pick<Frame, "width" | "height"> & { camera?: FrameCamera },
): string {
  const c = frame.camera;
  if (!c) return `0 0 ${frame.width} ${frame.height}`;
  const w = frame.width / c.zoom,
    h = frame.height / c.zoom;
  return [c.x - w / 2, c.y - h / 2, w, h].map(short).join(" ");
}

/**
 * The SVG for one frame, as a sanitized element tree. React (react.tsx) and the headless
 * serializer (renderSvg) both render this tree, so the two outputs are the same markup.
 * Ids are `${idPrefix}-…`: definitions are scoped to the instance, and every reference is
 * a local `#id` checked by sanitizeMarkup.
 */
export function buildSceneMarkup(
  frame: Frame,
  options: SceneMarkupOptions,
): MarkupElement {
  const uid = options.idPrefix;
  if (!PREFIX.test(uid))
    throw new VisualError("ID_PREFIX", "idPrefix must be a short identifier");
  const interactive = Boolean(options.interactive);
  const images = new Map((frame.defs?.images ?? []).map((i) => [i.id, i]));
  const shape = (n: GeometryNode): MarkupElement[] => {
    switch (n.kind) {
      case "rect":
        return [
          el("rect", { width: n.width, height: n.height, rx: n.cornerRadius }),
        ];
      case "circle":
        return [el("circle", { r: n.radius })];
      case "ellipse":
        return [el("ellipse", { rx: n.width / 2, ry: n.height / 2 })];
      case "line":
        return [
          el("line", {
            x2: n.x2,
            y2: n.y2,
            pathLength: 1,
            "stroke-dasharray": n.progress < 1 ? `${n.progress} 1` : undefined,
          }),
        ];
      case "text":
        return [
          el(
            "text",
            {
              "font-size": n.fontSize,
              "font-weight": n.weight,
              "text-anchor": n.align,
            },
            [n.text ?? ""],
          ),
        ];
      case "plot":
      case "path":
      case "link":
        return [
          el("path", {
            d: n.path,
            pathLength: 1,
            "stroke-dasharray": n.progress < 1 ? `${n.progress} 1` : undefined,
            "marker-end":
              n.arrow && n.progress === 1
                ? `url(#${uid}-arrow-${n.id})`
                : undefined,
          }),
        ];
      case "image": {
        const image = images.get(n.image!);
        if (!image)
          throw visualError("IMAGE", "imageUnknown", { image: n.image! });
        return [
          el("image", {
            href: imageHref(image),
            width: n.width,
            height: n.height,
            preserveAspectRatio: ASPECT[n.fit ?? "contain"],
            role: "img",
            "aria-label": n.label,
          }),
        ];
      }
      case "use":
        return [
          el("use", {
            href: `#${uid}-symbol-${n.symbol}`,
            width: n.width,
            height: n.height,
          }),
        ];
      case "equation": {
        const e = n.equation!;
        return [
          el(
            "g",
            {
              role: "img",
              "aria-label": n.label,
              "font-family": EQUATION_FONT,
            },
            [
              ...e.glyphs.map((g) =>
                el(
                  "text",
                  {
                    x: g.x,
                    y: g.y,
                    "font-size": g.size,
                    "font-style": g.style === "italic" ? "italic" : undefined,
                    "font-weight": g.style === "bold" ? "bold" : undefined,
                    textLength: g.width,
                    lengthAdjust: "spacingAndGlyphs",
                  },
                  [g.text],
                ),
              ),
              ...e.rules.map((r) =>
                el("rect", {
                  x: r.x,
                  y: r.y,
                  width: r.width,
                  height: r.height,
                }),
              ),
              ...e.strokes.map((s) =>
                el("path", {
                  d: s.d,
                  fill: "none",
                  stroke: paint(uid, n),
                  "stroke-width": s.width,
                }),
              ),
            ],
          ),
        ];
      }
      default:
        return [];
    }
  };
  function node(n: GeometryNode, live: boolean): MarkupElement | undefined {
    if (!n.visible) return undefined;
    const handle = live && Boolean(n.manipulate);
    const g: MarkupElement = {
      tag: "g",
      node: n.id,
      attrs: {
        "data-node-id": n.id,
        transform:
          n.kind === "group" ? undefined : `matrix(${n.matrix.join(" ")})`,
        opacity: n.kind === "group" ? undefined : n.opacity,
        fill: paint(uid, n),
        stroke:
          n.progress === 0 && ["path", "line", "link"].includes(n.kind)
            ? "none"
            : n.stroke,
        "stroke-width": n.strokeWidth,
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
        tabindex: handle ? 0 : undefined,
        role: handle
          ? n.manipulate?.activate && !n.manipulate.x && !n.manipulate.y
            ? "button"
            : "group"
          : undefined,
        "aria-label": handle
          ? `${n.label}. ${n.manipulate?.x || n.manipulate?.y ? (options.dragHint ?? DRAG_HINT) : ""}`
          : undefined,
        class: handle ? "ccv-handle" : undefined,
      },
      children: [
        ...(handle && n.label ? [el("title", {}, [n.label])] : []),
        ...(n.kind === "group"
          ? [
              ...(n.manipulate
                ? [
                    el("rect", {
                      ...n.bounds,
                      fill: "transparent",
                      stroke: "none",
                      "pointer-events": "all",
                    }),
                  ]
                : []),
              ...(n.children ?? []).flatMap((child) => node(child, live) ?? []),
            ]
          : shape(n)),
      ],
    };
    // Clip and mask content is in scene coordinates: the wrapper has no transform.
    return n.clip !== undefined || n.mask !== undefined
      ? el(
          "g",
          {
            "clip-path":
              n.clip !== undefined ? `url(#${uid}-clip-${n.clip})` : undefined,
            mask:
              n.mask !== undefined ? `url(#${uid}-mask-${n.mask})` : undefined,
          },
          [g],
        )
      : g;
  }
  const paints = (nodes: GeometryNode[]) =>
    flattenNodes(nodes)
      .filter((n) => n.kind !== "group")
      .map((n) =>
        el("g", {}, [
          ...(typeof n.fill !== "string" && n.fill.kind === "radial"
            ? [
                el(
                  "radialGradient",
                  {
                    id: `${uid}-fill-${n.id}`,
                    cx: n.fill.cx ?? 0.5,
                    cy: n.fill.cy ?? 0.5,
                    r: n.fill.r ?? 0.5,
                  },
                  [
                    el("stop", { "stop-color": n.fill.from }),
                    el("stop", { offset: "1", "stop-color": n.fill.to }),
                  ],
                ),
              ]
            : []),
          ...(typeof n.fill !== "string" && n.fill.kind === "linear"
            ? [
                el(
                  "linearGradient",
                  {
                    id: `${uid}-fill-${n.id}`,
                    x1: "0",
                    y1: "0",
                    x2: "1",
                    y2: "1",
                  },
                  [
                    el("stop", { "stop-color": n.fill.from }),
                    el("stop", { offset: "1", "stop-color": n.fill.to }),
                  ],
                ),
              ]
            : []),
          ...(n.arrow
            ? [
                el(
                  "marker",
                  {
                    id: `${uid}-arrow-${n.id}`,
                    markerWidth: "8",
                    markerHeight: "8",
                    refX: "7",
                    refY: "4",
                    orient: "auto",
                    markerUnits: "strokeWidth",
                  },
                  [el("path", { d: "M0 0 L8 4 L0 8 Z", fill: n.stroke })],
                ),
              ]
            : []),
        ]),
      );
  const defs = frame.defs;
  const definitions: MarkupElement[] = defs
    ? [
        ...paints([
          ...defs.clips.flatMap((row) => row.nodes),
          ...defs.masks.flatMap((row) => row.nodes),
          ...defs.symbols.flatMap((row) => row.nodes),
        ]),
        // clipPath content must be shapes (no <g>), so each carries its own transform.
        ...defs.clips.map((row) =>
          el(
            "clipPath",
            { id: `${uid}-clip-${row.id}`, clipPathUnits: "userSpaceOnUse" },
            row.nodes
              .filter((n) => n.visible)
              .flatMap((n) =>
                shape(n).map((s) => ({
                  ...s,
                  attrs: {
                    ...s.attrs,
                    transform: `matrix(${n.matrix.join(" ")})`,
                  },
                })),
              ),
          ),
        ),
        ...defs.masks.map((row) =>
          el(
            "mask",
            {
              id: `${uid}-mask-${row.id}`,
              maskUnits: "userSpaceOnUse",
              x: 0,
              y: 0,
              width: frame.width,
              height: frame.height,
            },
            row.nodes.flatMap((n) => node(n, false) ?? []),
          ),
        ),
        ...defs.symbols.map((row) =>
          el(
            "symbol",
            {
              id: `${uid}-symbol-${row.id}`,
              viewBox: `0 0 ${row.width} ${row.height}`,
            },
            row.nodes.flatMap((n) => node(n, false) ?? []),
          ),
        ),
      ]
    : [];
  return sanitizeMarkup(
    el(
      "svg",
      {
        xmlns: options.xmlns ? "http://www.w3.org/2000/svg" : undefined,
        class: `ccv-scene ${options.className ?? ""}`,
        viewBox: cameraViewBox(frame),
        role: "group",
        "aria-labelledby": `${uid}-title`,
        "aria-describedby": `${uid}-description`,
        "data-layout": frame.layout,
        style: `aspect-ratio:${frame.width}/${frame.height}`,
      },
      [
        el("title", { id: `${uid}-title` }, [options.title]),
        el("desc", { id: `${uid}-description` }, [frame.text]),
        el("defs", {}, [...paints(frame.nodes), ...definitions]),
        ...frame.nodes.flatMap((n) => node(n, interactive) ?? []),
      ],
    ),
  );
}

/**
 * Deterministic SVG text for a frame: the same markup the React view renders without
 * handlers. `idPrefix` must be unique among scenes on one page.
 */
export function renderSvg(frame: Frame, options: SceneMarkupOptions): string {
  return serializeMarkup(
    buildSceneMarkup(frame, { ...options, interactive: false }),
  );
}
