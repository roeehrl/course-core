import { layoutEquation } from "./equation.js";
import { DEFAULT_SPRING, layoutMode, springProgress } from "./motion.js";
import { checkCamera } from "./schema.js";
import { visualError } from "./errors.js";
import { evaluate, finite } from "./expression.js";
import type { EvaluationContext } from "./expression.js";
import type {
  Anchor,
  Bounds,
  ColorKeyframe,
  Expression,
  Frame,
  FrameDefs,
  PaneFrame,
  GeometryNode,
  Matrix,
  NumericProperty,
  Point,
  Scene,
  SceneNode,
  State,
  Track,
} from "./types.js";

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
export function multiply(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ].map((n) => finite(n, "transform")) as unknown as Matrix;
}
export function transformPoint(m: Matrix, p: Point): Point {
  return {
    x: finite(m[0] * p.x + m[2] * p.y + m[4]),
    y: finite(m[1] * p.x + m[3] * p.y + m[5]),
  };
}
export function inversePoint(m: Matrix, p: Point): Point {
  const det = finite(m[0] * m[3] - m[1] * m[2]);
  if (Math.abs(det) < 1e-12)
    throw visualError("TRANSFORM", "noninvertibleTransform");
  return {
    x: finite((m[3] * (p.x - m[4]) - m[2] * (p.y - m[5])) / det),
    y: finite((-m[1] * (p.x - m[4]) + m[0] * (p.y - m[5])) / det),
  };
}
export function boundsOf(points: Point[]): Bounds {
  if (!points.length) return { x: 0, y: 0, width: 0, height: 0 };
  const xs = points.map((p) => p.x),
    ys = points.map((p) => p.y),
    x = Math.min(...xs),
    y = Math.min(...ys);
  return {
    x,
    y,
    width: finite(Math.max(...xs) - x),
    height: finite(Math.max(...ys) - y),
  };
}
export function anchorPoint(b: Bounds, anchor: Anchor): Point {
  return {
    x: b.x + b.width * (anchor === "left" ? 0 : anchor === "right" ? 1 : 0.5),
    y: b.y + b.height * (anchor === "top" ? 0 : anchor === "bottom" ? 1 : 0.5),
  };
}
export function interpolate(track: Track, timeMs: number): number {
  finite(timeMs);
  const keys = track.keyframes;
  if (timeMs <= keys[0]!.atMs) return keys[0]!.value;
  for (let i = 1; i < keys.length; i++) {
    const right = keys[i]!,
      left = keys[i - 1]!;
    if (timeMs <= right.atMs) {
      let t = (timeMs - left.atMs) / (right.atMs - left.atMs);
      switch (right.ease ?? "linear") {
        case "smooth":
          t = t * t * (3 - 2 * t);
          break;
        case "in":
          t *= t;
          break;
        case "out":
          t = 1 - (1 - t) * (1 - t);
          break;
        case "step":
          t = t === 1 ? 1 : 0;
          break;
        case "spring":
          t =
            timeMs >= right.atMs
              ? 1
              : springProgress(
                  right.spring ?? DEFAULT_SPRING,
                  timeMs - left.atMs,
                );
          break;
      }
      const value = finite(left.value + finite((right.value - left.value) * t));
      // A spring may overshoot; keep the value inside the property's valid range.
      if (right.ease !== "spring") return value;
      const [min, max] = SPRING_RANGE[track.property] ?? [-Infinity, Infinity];
      return Math.min(max, Math.max(min, value));
    }
  }
  return keys[keys.length - 1]!.value;
}
/** A colour track's colour at a time: sRGB channels and alpha interpolated (0.5). */
export function interpolateColor(
  keys: readonly ColorKeyframe[],
  timeMs: number,
): string {
  finite(timeMs);
  const rgba = (hex: string) => {
    const h = hex.slice(1),
      full = h.length <= 4 ? [...h].map((c) => c + c).join("") : h;
    return [0, 2, 4, 6].map((i) =>
      i < full.length ? parseInt(full.slice(i, i + 2), 16) : 255,
    );
  };
  const format = (c: number[]) =>
    "#" +
    c
      .slice(0, c[3] === 255 ? 3 : 4)
      .map((v) => Math.round(v).toString(16).padStart(2, "0"))
      .join("");
  if (timeMs <= keys[0]!.atMs) return format(rgba(keys[0]!.color));
  for (let i = 1; i < keys.length; i++) {
    const right = keys[i]!,
      left = keys[i - 1]!;
    if (timeMs <= right.atMs) {
      let t = (timeMs - left.atMs) / (right.atMs - left.atMs);
      switch (right.ease ?? "linear") {
        case "smooth":
          t = t * t * (3 - 2 * t);
          break;
        case "in":
          t *= t;
          break;
        case "out":
          t = 1 - (1 - t) * (1 - t);
          break;
        case "step":
          t = t === 1 ? 1 : 0;
          break;
      }
      const a = rgba(left.color),
        b = rgba(right.color);
      return format(a.map((v, k) => v + (b[k]! - v) * t));
    }
  }
  return format(rgba(keys[keys.length - 1]!.color));
}
const SPRING_RANGE: Partial<Record<Track["property"], [number, number]>> = {
  opacity: [0, 1],
  progress: [0, 1],
  morph: [0, 1],
  scale: [0.001, 100],
  width: [0, 100_000],
  height: [0, 100_000],
  radius: [0, 100_000],
  fontSize: [0, 100_000],
};
const fmt = (n: number) => String(Math.round(finite(n) * 1e6) / 1e6);
function curveAt(points: Point[], t: number): Point {
  let next = points;
  while (next.length > 1)
    next = next.slice(1).map((p, i) => ({
      x: next[i]!.x * (1 - t) + p.x * t,
      y: next[i]!.y * (1 - t) + p.y * t,
    }));
  return next[0]!;
}
/** Exact quadratic/cubic extrema; used after transforming control points. */
export function curveBounds(points: Point[]): Bounds {
  const times = new Set([0, 1]);
  for (const axis of ["x", "y"] as const) {
    const p = points.map((v) => v[axis]);
    if (p.length === 3) {
      const d = p[0]! - 2 * p[1]! + p[2]!;
      if (d) times.add((p[0]! - p[1]!) / d);
    } else if (p.length === 4) {
      const a = -p[0]! + 3 * p[1]! - 3 * p[2]! + p[3]!,
        b = 2 * (p[0]! - 2 * p[1]! + p[2]!),
        c = p[1]! - p[0]!;
      if (Math.abs(a) < 1e-12) {
        if (b) times.add(-c / b);
      } else {
        const d = b * b - 4 * a * c;
        if (d >= 0) {
          times.add((-b + Math.sqrt(d)) / (2 * a));
          times.add((-b - Math.sqrt(d)) / (2 * a));
        }
      }
    }
  }
  return boundsOf(
    [...times].filter((t) => t >= 0 && t <= 1).map((t) => curveAt(points, t)),
  );
}
function corners(b: Bounds): Point[] {
  return [
    { x: b.x, y: b.y },
    { x: b.x + b.width, y: b.y },
    { x: b.x, y: b.y + b.height },
    { x: b.x + b.width, y: b.y + b.height },
  ];
}
export function createGeometry(
  scene: Scene,
  state: State,
  timeMs: number,
  viewportWidth: number,
  reducedMotion: boolean,
  context: EvaluationContext,
): Frame {
  const mode = layoutMode(scene, viewportWidth),
    layout = scene.layouts[mode]!;
  const byId = new Map<string, GeometryNode>(),
    links: { node: SceneNode & { kind: "link" }; geometry: GeometryNode }[] =
      [];
  const symbols = new Map(
    (scene.defs?.symbols ?? []).map((symbol) => [symbol.id, symbol]),
  );
  const tracks = new Map<string, number>(),
    colors = new Map<string, string>();
  for (const track of scene.timeline.colorTracks ?? [])
    colors.set(
      `${track.node}.${track.property}`,
      interpolateColor(track.keyframes, timeMs),
    );
  for (const track of scene.timeline.tracks)
    tracks.set(`${track.node}.${track.property}`, interpolate(track, timeMs));
  for (const stagger of scene.timeline.staggers ?? [])
    stagger.nodes.forEach((node, i) =>
      tracks.set(
        `${node}.${stagger.property}`,
        interpolate(
          { node, property: stagger.property, keyframes: stagger.keyframes },
          timeMs - i * stagger.delayMs,
        ),
      ),
    );
  function visit(
    node: SceneNode,
    parent: Matrix,
    parentOpacity: number,
    parentVisible: boolean,
  ): GeometryNode {
    const override = layout.overrides?.[node.id] ?? {};
    function num(prop: NumericProperty, fallback: number): number {
      const input =
        override[prop] ?? (node as unknown as Record<string, Expression>)[prop];
      const v =
        tracks.get(`${node.id}.${prop}`) ??
        (input === undefined ? fallback : evaluate(input, context));
      if (typeof v !== "number")
        throw visualError("TYPE", "propertyNumeric", {
          node: node.id,
          property: prop,
        });
      finite(v);
      if (
        ["width", "height", "radius", "fontSize"].includes(prop) &&
        (v < 0 || v > 100_000)
      )
        throw visualError("GEOMETRY", "invalidSize");
      if (["opacity", "progress", "morph"].includes(prop) && (v < 0 || v > 1))
        throw visualError("GEOMETRY", "opacityProgressRange");
      if (prop === "scale" && (v < 0.001 || v > 100))
        throw visualError("GEOMETRY", "scaleRange");
      return v;
    }
    const x = num("x", 0),
      y = num("y", 0),
      rotation = num("rotation", 0),
      scale = num("scale", 1),
      r = (rotation * Math.PI) / 180;
    const matrix = multiply(parent, [
      Math.cos(r) * scale,
      Math.sin(r) * scale,
      -Math.sin(r) * scale,
      Math.cos(r) * scale,
      x,
      y,
    ]);
    const rawVisible =
      node.visible === undefined ? true : evaluate(node.visible, context);
    if (typeof rawVisible !== "boolean")
      throw visualError("TYPE", "visibilityMustBeBoolean");
    const g: GeometryNode = {
      id: node.id,
      kind: node.kind,
      label: node.label,
      matrix,
      parentMatrix: parent,
      x,
      y,
      rotation,
      scale,
      width: num(
        "width",
        node.kind === "use" ? symbols.get(node.symbol)!.width : 0,
      ),
      height: num(
        "height",
        node.kind === "use" ? symbols.get(node.symbol)!.height : 0,
      ),
      radius: num("radius", 0),
      fontSize: num("fontSize", 16),
      x2: num("x2", 0),
      y2: num("y2", 0),
      progress: num("progress", 1),
      opacity: num("opacity", 1) * parentOpacity,
      visible: rawVisible && parentVisible,
      fill: colors.get(`${node.id}.fill`) ?? node.fill ?? "#7dd3fc",
      stroke: colors.get(`${node.id}.stroke`) ?? node.stroke ?? "none",
      strokeWidth: node.strokeWidth ?? 1.5,
      bounds: { x: 0, y: 0, width: 0, height: 0 },
      cornerRadius: node.kind === "rect" ? (node.cornerRadius ?? 0) : 0,
      manipulate: node.manipulate,
    };
    if (node.kind === "path" && node.morphTo) g.morph = num("morph", 0);
    if (node.kind === "image") {
      g.image = node.image;
      g.fit = node.fit ?? "contain";
    }
    if (node.clip !== undefined) g.clip = node.clip;
    if (node.mask !== undefined) g.mask = node.mask;
    byId.set(node.id, g);
    const world = (p: Point) => transformPoint(matrix, p);
    const coordinate = (e: Expression) => {
      const v = evaluate(e, context);
      if (typeof v !== "number") throw visualError("TYPE", "coordinateNumeric");
      return finite(v);
    };
    const n = coordinate;
    if (node.kind === "group") {
      g.children = node.children.map((child) =>
        visit(child, matrix, g.opacity, g.visible),
      );
      g.bounds = boundsOf(
        g.children
          .filter((child) => child.kind !== "link")
          .flatMap((child) => corners(child.bounds)),
      );
    } else if (node.kind === "circle" || node.kind === "ellipse") {
      const rx = node.kind === "circle" ? g.radius : g.width / 2,
        ry = node.kind === "circle" ? g.radius : g.height / 2;
      const dx = finite(Math.hypot(matrix[0] * rx, matrix[2] * ry)),
        dy = finite(Math.hypot(matrix[1] * rx, matrix[3] * ry));
      g.bounds = {
        x: finite(matrix[4] - dx),
        y: finite(matrix[5] - dy),
        width: finite(dx * 2),
        height: finite(dy * 2),
      };
    } else if (node.kind === "line")
      g.bounds = boundsOf([world({ x: 0, y: 0 }), world({ x: g.x2, y: g.y2 })]);
    else if (node.kind === "text") {
      g.text = String(evaluate(node.text, context));
      g.weight = node.weight ?? "normal";
      g.align = node.align ?? "start";
      const width = finite(g.text.length * g.fontSize * 0.62),
        offset =
          g.align === "middle" ? -width / 2 : g.align === "end" ? -width : 0;
      g.bounds = boundsOf(
        corners({
          x: offset,
          y: -g.fontSize * 0.8,
          width,
          height: g.fontSize,
        }).map(world),
      );
    } else if (node.kind === "path") {
      let current: Point = { x: 0, y: 0 },
        start = current;
      const extrema: Point[] = [],
        parts: string[] = [];
      // A morphing path interpolates every coordinate towards morphTo (same commands).
      const morph = g.morph ?? 0;
      node.commands.forEach((c, index) => {
        const to = node.morphTo?.[index] as
          | Record<string, Expression>
          | undefined;
        const at = (key: "x" | "y" | "x1" | "y1" | "x2" | "y2") => {
          const from = coordinate((c as Record<string, Expression>)[key]!);
          return to && morph > 0
            ? finite(from + (coordinate(to[key]!) - from) * morph)
            : from;
        };
        if (c.command === "Z") {
          parts.push("Z");
          extrema.push(world(current), world(start));
          current = start;
          return;
        }
        const end = { x: at("x"), y: at("y") };
        if (c.command === "M") {
          start = end;
          parts.push(`M${fmt(end.x)} ${fmt(end.y)}`);
          extrema.push(world(end));
        } else if (c.command === "L") {
          parts.push(`L${fmt(end.x)} ${fmt(end.y)}`);
          extrema.push(world(current), world(end));
        } else {
          const p1 = { x: at("x1"), y: at("y1") },
            p2 = c.command === "C" ? { x: at("x2"), y: at("y2") } : undefined;
          parts.push(
            `${c.command}${fmt(p1.x)} ${fmt(p1.y)} ${p2 ? `${fmt(p2.x)} ${fmt(p2.y)} ` : ""}${fmt(end.x)} ${fmt(end.y)}`,
          );
          extrema.push(
            ...corners(
              curveBounds([current, p1, ...(p2 ? [p2] : []), end].map(world)),
            ),
          );
        }
        current = end;
      });
      g.path = parts.join(" ");
      g.bounds = boundsOf(extrema);
    } else if (node.kind === "plot") {
      g.points = node.points.map((p) => ({
        x: finite(
          ((n(p.x) - node.domainX[0]) / (node.domainX[1] - node.domainX[0])) *
            g.width,
        ),
        y: finite(
          g.height -
            ((n(p.y) - node.domainY[0]) / (node.domainY[1] - node.domainY[0])) *
              g.height,
        ),
      }));
      if (
        g.points.some(
          (p) => p.x < 0 || p.x > g.width || p.y < 0 || p.y > g.height,
        )
      )
        throw visualError("PLOT_RANGE", "plotPointsOutsideDomains");
      g.path = g.points
        .map((p, i) => `${i ? "L" : "M"}${fmt(p.x)} ${fmt(p.y)}`)
        .join(" ");
      if (node.area)
        g.path += ` L${fmt(g.points.at(-1)!.x)} ${fmt(g.height)} L${fmt(g.points[0]!.x)} ${fmt(g.height)} Z`;
      g.bounds = boundsOf(
        corners({ x: 0, y: 0, width: g.width, height: g.height }).map(world),
      );
    } else if (node.kind === "equation") {
      g.align = node.align ?? "start";
      const e = layoutEquation(node.tex, g.fontSize, g.align);
      g.equation = e;
      g.bounds = boundsOf(
        corners({
          x: e.offset,
          y: -e.ascent,
          width: e.width,
          height: e.ascent + e.descent,
        }).map(world),
      );
    } else if (node.kind === "use") {
      g.symbol = node.symbol;
      g.bounds = boundsOf(
        corners({ x: 0, y: 0, width: g.width, height: g.height }).map(world),
      );
    } else if (node.kind === "link") {
      links.push({ node, geometry: g });
      g.matrix = IDENTITY;
      g.arrow = node.arrow;
    } else
      g.bounds = boundsOf(
        corners({ x: 0, y: 0, width: g.width, height: g.height }).map(world),
      );
    return g;
  }
  const nodes = scene.nodes.map((n) => visit(n, IDENTITY, 1, true));
  // Definitions are drawn in scene coordinates (clip/mask) or symbol coordinates.
  const draw = (rows: readonly SceneNode[]) =>
    rows.map((n) => visit(n, IDENTITY, 1, true));
  const defs: FrameDefs | undefined = scene.defs && {
    clips: (scene.defs.clips ?? []).map((row) => ({
      id: row.id,
      nodes: draw(row.nodes),
    })),
    masks: (scene.defs.masks ?? []).map((row) => ({
      id: row.id,
      nodes: draw(row.nodes),
    })),
    symbols: (scene.defs.symbols ?? []).map((row) => ({
      id: row.id,
      width: row.width,
      height: row.height,
      nodes: draw(row.nodes),
    })),
    ...(scene.defs.images ? { images: scene.defs.images } : {}),
  };
  for (const { node, geometry: g } of links) {
    const from = byId.get(node.from.node)!,
      to = byId.get(node.to.node)!;
    const fromCenter = anchorPoint(from.bounds, "center"),
      toCenter = anchorPoint(to.bounds, "center");
    const horizontal =
      Math.abs(toCenter.x - fromCenter.x) >=
      Math.abs(toCenter.y - fromCenter.y);
    const fromAuto = horizontal
      ? toCenter.x >= fromCenter.x
        ? "right"
        : "left"
      : toCenter.y >= fromCenter.y
        ? "bottom"
        : "top";
    const toAuto = horizontal
      ? toCenter.x >= fromCenter.x
        ? "left"
        : "right"
      : toCenter.y >= fromCenter.y
        ? "top"
        : "bottom";
    const a = anchorPoint(
        from.bounds,
        node.from.anchor === "auto" ? fromAuto : node.from.anchor,
      ),
      b = anchorPoint(
        to.bounds,
        node.to.anchor === "auto" ? toAuto : node.to.anchor,
      ),
      bend = node.bend ?? 0.35;
    const dx = finite((b.x - a.x) * bend),
      c = { x: finite(a.x + dx), y: a.y },
      d = { x: finite(b.x - dx), y: b.y };
    g.path = `M${fmt(a.x)} ${fmt(a.y)} C${fmt(c.x)} ${fmt(c.y)} ${fmt(d.x)} ${fmt(d.y)} ${fmt(b.x)} ${fmt(b.y)}`;
    g.bounds = curveBounds([a, c, d, b]);
    g.visible &&= from.visible && to.visible;
  }
  const cue =
    [...scene.timeline.cues].reverse().find((c) => c.atMs <= timeMs)?.text ??
    "";
  const text = [
    scene.accessibility.text,
    reducedMotion ? scene.accessibility.reducedMotion.description : "",
    cue,
    ...Object.entries(state).map(
      ([key, value]) => `${scene.state[key]!.label}: ${value}.`,
    ),
  ]
    .filter(Boolean)
    .join(" ");
  return {
    sceneId: scene.id,
    layout: mode,
    width: layout.width,
    height: layout.height,
    timeMs,
    durationMs: scene.timeline.durationMs,
    state: { ...state },
    nodes,
    text,
    cue,
    reducedMotion,
    ...(defs ? { defs } : {}),
    ...(scene.panes ? { panes: scene.panes.map(pane) } : {}),
    ...(scene.camera ? { camera: camera(scene.camera) } : {}),
  };
  /** The camera: a track, else its expression, else the layout's centre and zoom 1. */
  function camera(c: NonNullable<Scene["camera"]>) {
    const at = (prop: "x" | "y" | "zoom", fallback: number) => {
      const track = scene.timeline.cameraTracks?.find(
        (t) => t.property === prop,
      );
      const input = c[prop];
      const v = track
        ? interpolate(
            { node: "camera", property: "x", keyframes: track.keyframes },
            timeMs,
          )
        : input === undefined
          ? fallback
          : evaluate(input, context);
      if (typeof v !== "number")
        throw visualError("TYPE", "cameraNumeric", { property: prop });
      // A spring keyframe may overshoot: keep a tracked zoom in range instead of failing.
      if (track && prop === "zoom") return Math.min(20, Math.max(0.1, v));
      checkCamera(prop, v);
      return v;
    };
    return {
      x: at("x", layout.width / 2),
      y: at("y", layout.height / 2),
      zoom: at("zoom", 1),
    };
  }
  /** Pane values come from the same evaluation context as the geometry. */
  function pane(p: NonNullable<Scene["panes"]>[number]): PaneFrame {
    const show = (e: Expression) => {
      const v = evaluate(e, context);
      return typeof v === "number"
        ? String(Math.round(finite(v) * 1e4) / 1e4)
        : String(v);
    };
    const index = (e: Expression | undefined, from: number, count: number) => {
      if (e === undefined) return null;
      const v = evaluate(e, context);
      if (typeof v !== "number")
        throw visualError("TYPE", "paneHighlightMustBeNumeric");
      return Number.isInteger(v) && v >= from && v < from + count ? v : null;
    };
    if (p.kind === "table")
      return {
        id: p.id,
        kind: p.kind,
        title: p.title,
        columns: [...p.columns],
        rows: p.rows.map((row) => row.map(show)),
        highlightRow: index(p.highlightRow, 0, p.rows.length),
      };
    if (p.kind === "code")
      return {
        id: p.id,
        kind: p.kind,
        title: p.title,
        language: p.language,
        lines: [...p.lines],
        highlightLine: index(p.highlightLine, 1, p.lines.length),
      };
    return {
      id: p.id,
      kind: p.kind,
      title: p.title,
      tex: p.tex,
      label: p.label,
      values: (p.values ?? []).map((row) => ({
        symbol: row.symbol,
        value: show(row.value),
      })),
    };
  }
}
export function flattenNodes(nodes: GeometryNode[]): GeometryNode[] {
  return nodes.flatMap((n) => [n, ...flattenNodes(n.children ?? [])]);
}
