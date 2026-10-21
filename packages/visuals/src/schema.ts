import { z } from "zod";
import { checkEquation, EQUATION_LIMITS } from "./equation.js";
import { MAX_VALUE, VisualError, operatorArity } from "./expression.js";
import { visualError } from "./errors.js";
import type { ErrorKey, englishErrorMessages } from "./errors.js";
import { verifyImageAsset } from "./image.js";
import { SPRING_LIMITS } from "./motion.js";
import type {
  Expression,
  NumericProperty,
  Probe,
  Scene,
  SceneNode,
  StateField,
  Value,
} from "./types.js";

export const LIMITS = Object.freeze({
  bytes: 1_000_000,
  nodes: 400,
  depth: 12,
  expressionDepth: 16,
  durationMs: 120_000,
  tracks: 800,
  keyframes: 256,
  state: 64,
  points: 10_000,
  replayEvents: 512,
  evaluation: 500_000,
  /** Clip, mask and symbol definitions, each. */
  defs: 32,
  /** `use` instances of symbols. */
  uses: 64,
  /** Nodes drawn once every `use` expands its symbol. */
  renderedNodes: 4_000,
  /** Frames the publish-time invariants may evaluate (layouts × states × times). */
  checkFrames: 512,
  /** Embedded images (`defs.images`). */
  images: 16,
  /** Base64 characters of one image (about 140 KB decoded). The scene byte budget bounds the total. */
  imageChars: 192_000,
  /** Colour tracks. */
  colorTracks: 64,
});
const reserved = new Set(["__proto__", "prototype", "constructor"]);
const id = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/)
  .refine((v) => !reserved.has(v), "Reserved identifier");
const text = z.string().max(2048);
const number = z.number().finite().min(-MAX_VALUE).max(MAX_VALUE);
const positive = z.number().finite().min(0).max(100_000);
const color = z
  .string()
  .regex(/^(?:#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6}|#[0-9a-fA-F]{8}|none)$/);
const primitive = z.union([number, text, z.boolean()]);
const ops = Object.keys(operatorArity) as [
  keyof typeof operatorArity,
  ...(keyof typeof operatorArity)[],
];
const expression: z.ZodType<Expression> = z.lazy(() =>
  z.union([
    primitive,
    z.object({ state: id }).strict(),
    z.object({ time: z.literal(true) }).strict(),
    z.object({ sample: id }).strict(),
    z
      .object({ op: z.enum(ops), args: z.array(expression).min(1).max(16) })
      .strict()
      .superRefine((v, ctx) => {
        const [min, max] = operatorArity[v.op];
        if (v.args.length < min || v.args.length > max)
          ctx.addIssue({
            code: "custom",
            message: `Invalid arity for ${v.op}`,
          });
      }),
  ]),
);
const binding = z
  .object({ state: id, from: number, to: number })
  .strict()
  .refine((v) => v.from !== v.to, "Binding range must be nonzero");
const base = {
  id,
  label: text.optional(),
  x: expression.optional(),
  y: expression.optional(),
  rotation: expression.optional(),
  scale: expression.optional(),
  opacity: expression.optional(),
  visible: expression.optional(),
  fill: z
    .union([
      color,
      z.object({ kind: z.literal("linear"), from: color, to: color }).strict(),
      z
        .object({
          kind: z.literal("radial"),
          from: color,
          to: color,
          cx: z.number().finite().min(0).max(1).optional(),
          cy: z.number().finite().min(0).max(1).optional(),
          r: z.number().finite().positive().max(2).optional(),
        })
        .strict(),
    ])
    .optional(),
  stroke: color.optional(),
  strokeWidth: z.number().min(0).max(100).optional(),
  manipulate: z
    .object({
      x: binding.optional(),
      y: binding.optional(),
      activate: z.object({ state: id, value: primitive }).strict().optional(),
    })
    .strict()
    .optional(),
  clip: id.optional(),
  mask: id.optional(),
};
const anchor = z
  .object({
    node: id,
    anchor: z.enum(["center", "top", "right", "bottom", "left", "auto"]),
  })
  .strict();
const command = z.discriminatedUnion("command", [
  z.object({ command: z.literal("M"), x: expression, y: expression }).strict(),
  z.object({ command: z.literal("L"), x: expression, y: expression }).strict(),
  z
    .object({
      command: z.literal("Q"),
      x1: expression,
      y1: expression,
      x: expression,
      y: expression,
    })
    .strict(),
  z
    .object({
      command: z.literal("C"),
      x1: expression,
      y1: expression,
      x2: expression,
      y2: expression,
      x: expression,
      y: expression,
    })
    .strict(),
  z.object({ command: z.literal("Z") }).strict(),
]);
const node: z.ZodType<SceneNode> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z
      .object({
        ...base,
        kind: z.literal("group"),
        children: z.array(node).max(LIMITS.nodes),
      })
      .strict(),
    z
      .object({
        ...base,
        kind: z.literal("rect"),
        width: expression,
        height: expression,
        cornerRadius: positive.optional(),
      })
      .strict(),
    z
      .object({ ...base, kind: z.literal("circle"), radius: expression })
      .strict(),
    z
      .object({
        ...base,
        kind: z.literal("ellipse"),
        width: expression,
        height: expression,
      })
      .strict(),
    z
      .object({
        ...base,
        kind: z.literal("line"),
        x2: expression,
        y2: expression,
        progress: expression.optional(),
      })
      .strict(),
    z
      .object({
        ...base,
        kind: z.literal("text"),
        text: expression,
        fontSize: expression.optional(),
        weight: z.enum(["normal", "bold"]).optional(),
        align: z.enum(["start", "middle", "end"]).optional(),
      })
      .strict(),
    z
      .object({
        ...base,
        kind: z.literal("path"),
        commands: z.array(command).min(1).max(1024),
        progress: expression.optional(),
        morphTo: z.array(command).min(1).max(1024).optional(),
        morph: expression.optional(),
      })
      .strict(),
    z
      .object({
        ...base,
        kind: z.literal("plot"),
        width: expression,
        height: expression,
        domainX: z.tuple([number, number]),
        domainY: z.tuple([number, number]),
        points: z
          .array(z.object({ x: expression, y: expression }).strict())
          .min(2)
          .max(2048),
        area: z.boolean().optional(),
      })
      .strict(),
    z
      .object({
        ...base,
        kind: z.literal("link"),
        from: anchor,
        to: anchor,
        bend: number.optional(),
        arrow: z.boolean().optional(),
        progress: expression.optional(),
      })
      .strict(),
    z
      .object({
        ...base,
        kind: z.literal("use"),
        symbol: id,
        width: expression.optional(),
        height: expression.optional(),
      })
      .strict(),
    z
      .object({
        ...base,
        kind: z.literal("image"),
        image: id,
        width: expression,
        height: expression,
        fit: z.enum(["contain", "cover", "fill"]).optional(),
      })
      .strict(),
    z
      .object({
        ...base,
        kind: z.literal("equation"),
        tex: z.string().min(1).max(EQUATION_LIMITS.chars),
        fontSize: expression.optional(),
        align: z.enum(["start", "middle", "end"]).optional(),
      })
      .strict(),
  ]),
);
const region = z.object({ id, nodes: z.array(node).min(1).max(64) }).strict();
const defs = z
  .object({
    clips: z.array(region).max(LIMITS.defs).optional(),
    masks: z.array(region).max(LIMITS.defs).optional(),
    symbols: z
      .array(
        z
          .object({
            id,
            width: z.number().finite().min(1).max(4096),
            height: z.number().finite().min(1).max(4096),
            nodes: z.array(node).min(1).max(LIMITS.nodes),
          })
          .strict(),
      )
      .max(LIMITS.defs)
      .optional(),
    images: z
      .array(
        z
          .object({
            id,
            mediaType: z.enum(["image/png", "image/jpeg", "image/webp"]),
            width: z.number().int().min(1).max(8192),
            height: z.number().int().min(1).max(8192),
            sha256: z.string().regex(/^sha256-[0-9a-f]{64}$/),
            data: z.string().min(8).max(LIMITS.imageChars),
          })
          .strict(),
      )
      .min(1)
      .max(LIMITS.images)
      .optional(),
  })
  .strict();
const numericProperties = [
  "x",
  "y",
  "rotation",
  "scale",
  "opacity",
  "width",
  "height",
  "radius",
  "fontSize",
  "x2",
  "y2",
  "progress",
  "morph",
] as const;
const property = z.enum(numericProperties);
const overrides = z
  .object(
    Object.fromEntries(
      numericProperties.map((p) => [p, expression.optional()]),
    ),
  )
  .strict();
const layout = z
  .object({
    width: z.number().min(100).max(4096),
    height: z.number().min(100).max(4096),
    overrides: z.record(id, overrides).optional(),
  })
  .strict();
const field: z.ZodType<StateField> = z.discriminatedUnion("kind", [
  z
    .object({
      label: text,
      kind: z.literal("number"),
      initial: number,
      min: number,
      max: number,
      step: z.number().finite().positive().max(MAX_VALUE),
    })
    .strict(),
  z
    .object({ label: text, kind: z.literal("boolean"), initial: z.boolean() })
    .strict(),
  z
    .object({
      label: text,
      kind: z.literal("enum"),
      initial: text,
      options: z.array(text).min(1).max(32),
    })
    .strict(),
]);
const probe: z.ZodType<Probe> = z.lazy(() =>
  z.union([
    primitive,
    z.object({ state: id }).strict(),
    z.object({ time: z.literal(true) }).strict(),
    z.object({ sample: id }).strict(),
    z
      .object({ op: z.enum(ops), args: z.array(probe).min(1).max(16) })
      .strict()
      .superRefine((v, ctx) => {
        const [min, max] = operatorArity[v.op];
        if (v.args.length < min || v.args.length > max)
          ctx.addIssue({
            code: "custom",
            message: `Invalid arity for ${v.op}`,
          });
      }),
    z
      .object({
        node: id,
        property: z.enum([...numericProperties, "worldX", "worldY"]),
      })
      .strict(),
    z
      .object({
        cell: z
          .object({
            pane: id,
            row: probe,
            column: z.number().int().min(0).max(7),
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        value: z
          .object({ pane: id, symbol: z.string().min(1).max(16) })
          .strict(),
      })
      .strict(),
    z.object({ highlight: id }).strict(),
  ]),
);
const layoutModeSchema = z.enum([
  "compact",
  "expanded",
  "tabletPortrait",
  "tabletLandscape",
  "wide",
]);
const springLimits = SPRING_LIMITS;
const keyframe = z
  .object({
    atMs: positive,
    value: number,
    ease: z
      .enum(["linear", "smooth", "in", "out", "step", "spring"])
      .optional(),
    spring: z
      .object({
        stiffness: z
          .number()
          .finite()
          .min(springLimits.stiffness[0])
          .max(springLimits.stiffness[1]),
        damping: z
          .number()
          .finite()
          .min(springLimits.damping[0])
          .max(springLimits.damping[1]),
        mass: z
          .number()
          .finite()
          .min(springLimits.mass[0])
          .max(springLimits.mass[1]),
      })
      .strict()
      .refine(
        (s) =>
          s.stiffness / s.mass <= springLimits.stiffnessPerMass &&
          s.damping / s.mass <= springLimits.dampingPerMass,
        "Spring is too stiff or too damped for its mass",
      )
      .optional(),
  })
  .strict()
  .refine(
    (k) => k.spring === undefined || k.ease === "spring",
    "spring parameters require ease: spring",
  );
const keyframes = z.array(keyframe).min(1).max(LIMITS.keyframes);
const solid = z
  .string()
  .regex(/^(?:#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6}|#[0-9a-fA-F]{8})$/);
const colorKeyframes = z
  .array(
    z
      .object({
        atMs: positive,
        color: solid,
        ease: z.enum(["linear", "smooth", "in", "out", "step"]).optional(),
      })
      .strict(),
  )
  .min(1)
  .max(LIMITS.keyframes);
const title = z.string().min(1).max(160);
const pane = z.discriminatedUnion("kind", [
  z
    .object({
      id,
      kind: z.literal("table"),
      title,
      columns: z.array(z.string().min(1).max(80)).min(1).max(8),
      rows: z.array(z.array(expression).min(1).max(8)).min(1).max(50),
      highlightRow: expression.optional(),
    })
    .strict(),
  z
    .object({
      id,
      kind: z.literal("code"),
      title,
      language: z.string().regex(/^[a-z][a-z0-9+#-]{0,23}$/),
      lines: z.array(z.string().max(200)).min(1).max(200),
      highlightLine: expression.optional(),
    })
    .strict(),
  z
    .object({
      id,
      kind: z.literal("formula"),
      title,
      tex: z.string().min(1).max(EQUATION_LIMITS.chars),
      label: z.string().min(1).max(400),
      values: z
        .array(
          z
            .object({ symbol: z.string().min(1).max(16), value: expression })
            .strict(),
        )
        .max(16)
        .optional(),
    })
    .strict(),
]);
const schema = z
  .object({
    version: z.literal(1),
    id,
    title: text,
    description: text,
    state: z.record(id, field),
    controls: z.array(id).max(LIMITS.state).optional(),
    nodes: z.array(node).min(1).max(LIMITS.nodes),
    defs: defs.optional(),
    camera: z
      .object({
        x: expression.optional(),
        y: expression.optional(),
        zoom: expression.optional(),
      })
      .strict()
      .optional(),
    layouts: z
      .object({
        compact: layout,
        expanded: layout,
        breakpoint: z.number().min(240).max(1200).optional(),
        tabletPortrait: layout.optional(),
        tabletLandscape: layout.optional(),
        wide: layout.optional(),
      })
      .strict(),
    timeline: z
      .object({
        durationMs: z.number().finite().min(0).max(LIMITS.durationMs),
        tracks: z
          .array(
            z
              .object({
                node: id,
                property,
                keyframes,
              })
              .strict(),
          )
          .max(LIMITS.tracks),
        staggers: z
          .array(
            z
              .object({
                nodes: z.array(id).min(2).max(100),
                property,
                delayMs: z.number().finite().positive().max(LIMITS.durationMs),
                keyframes,
              })
              .strict(),
          )
          .max(64)
          .optional(),
        colorTracks: z
          .array(
            z
              .object({
                node: id,
                property: z.enum(["fill", "stroke"]),
                keyframes: colorKeyframes,
              })
              .strict(),
          )
          .min(1)
          .max(LIMITS.colorTracks)
          .optional(),
        cameraTracks: z
          .array(
            z
              .object({ property: z.enum(["x", "y", "zoom"]), keyframes })
              .strict(),
          )
          .min(1)
          .max(3)
          .optional(),
        cues: z.array(z.object({ atMs: positive, text }).strict()).max(256),
      })
      .strict(),
    accessibility: z
      .object({
        text: text.min(1),
        reducedMotion: z
          .object({ atMs: positive, description: text.min(1) })
          .strict(),
      })
      .strict(),
    simulation: z
      .object({
        seed: z.number().int().min(0).max(4294967295),
        stepMs: z.number().int().min(16).max(1000),
        updates: z.record(id, expression),
      })
      .strict()
      .optional(),
    referenceChecks: z.array(id).max(32).optional(),
    panes: z.array(pane).min(1).max(8).optional(),
    invariants: z
      .array(
        z
          .object({
            id,
            description: z.string().min(1).max(400),
            assert: probe,
            times: z.array(positive).min(1).max(32).optional(),
            states: z.array(z.record(id, primitive)).min(1).max(8).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(32)
      .optional(),
    goldens: z
      .array(
        z
          .object({
            atMs: positive,
            layout: layoutModeSchema,
            digest: z.string().regex(/^sha256-[0-9a-f]{64}$/),
          })
          .strict(),
      )
      .min(1)
      .max(32)
      .optional(),
  })
  .strict();

/** Preflight before recursive parsing: cycles, accessors, non-JSON objects, depth and total payload work. */
export function preflight(input: unknown): void {
  const parents = new WeakSet<object>();
  let nodes = 0,
    size = 0;
  function walk(value: unknown, depth: number): void {
    if (++nodes > 70_000 || depth > 64)
      throw new VisualError("PAYLOAD_LIMIT", "JSON structure exceeds limits");
    if (typeof value === "string") {
      size += value.length * 3;
    } else if (typeof value === "number") {
      if (!Number.isFinite(value))
        throw new VisualError("NON_FINITE", "JSON contains nonfinite numbers");
      size += 16;
    } else if (value !== null && typeof value === "object") {
      if (parents.has(value))
        throw new VisualError("CYCLE", "Cyclic scene data");
      const prototype = Object.getPrototypeOf(value);
      if (
        prototype !== Object.prototype &&
        prototype !== Array.prototype &&
        prototype !== null
      )
        throw new VisualError("JSON", "Only plain JSON is supported");
      if (Array.isArray(value) && value.length > LIMITS.points)
        throw new VisualError("PAYLOAD_LIMIT", "Array exceeds limits");
      const keys = Reflect.ownKeys(value);
      if (
        Array.isArray(value) &&
        (keys.length !== value.length + 1 ||
          keys.some(
            (key) =>
              key !== "length" &&
              (typeof key !== "string" ||
                !/^(0|[1-9][0-9]*)$/.test(key) ||
                Number(key) >= value.length),
          ))
      )
        throw new VisualError("JSON", "Arrays must be dense JSON data");
      parents.add(value);
      for (const key of keys) {
        if (typeof key !== "string" || reserved.has(key))
          throw new VisualError("JSON", "Unsafe object key");
        if (Array.isArray(value) && key === "length") continue;
        const d = Object.getOwnPropertyDescriptor(value, key)!;
        if (!("value" in d))
          throw new VisualError("JSON", "Accessors are not allowed");
        size += key.length * 3;
        walk(d.value, depth + 1);
      }
      parents.delete(value);
    } else if (value !== null && typeof value !== "boolean")
      throw new VisualError("JSON", "Expected JSON data");
    if (size > LIMITS.bytes)
      throw new VisualError("PAYLOAD_LIMIT", "Scene exceeds byte budget");
  }
  walk(input, 0);
}
export function assertStateValue(
  field: StateField | undefined,
  value: Value,
): void {
  if (!field) throw new VisualError("STATE", "Unknown state field");
  if (
    field.kind === "number" &&
    (typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < field.min ||
      value > field.max)
  )
    throw new VisualError("STATE_RANGE", "Number outside state bounds");
  if (field.kind === "boolean" && typeof value !== "boolean")
    throw new VisualError("STATE_TYPE", "Expected boolean state");
  if (
    field.kind === "enum" &&
    (typeof value !== "string" || !field.options.includes(value))
  )
    throw new VisualError("STATE_TYPE", "Unknown enum value");
}
/** Camera bounds: zoom 0.1–20, centre within ±100,000. */
export function checkCamera(prop: "x" | "y" | "zoom", value: number): void {
  if (
    !Number.isFinite(value) ||
    (prop === "zoom" ? value < 0.1 || value > 20 : Math.abs(value) > 100_000)
  )
    throw visualError("SCHEMA", "cameraRange", { property: prop });
}
export function supportsProperty(
  node: SceneNode,
  prop: NumericProperty,
): boolean {
  if (prop === "morph")
    return node.kind === "path" && node.morphTo !== undefined;
  if (["x", "y", "rotation", "scale", "opacity"].includes(prop))
    return node.kind !== "link" || prop === "opacity";
  return (
    (
      {
        width: ["rect", "ellipse", "plot", "use", "image"],
        height: ["rect", "ellipse", "plot", "use", "image"],
        radius: ["circle"],
        fontSize: ["text", "equation"],
        x2: ["line"],
        y2: ["line"],
        progress: ["path", "line", "link"],
      } as Record<string, string[]>
    )[prop]?.includes(node.kind) ?? false
  );
}
export function parseScene(input: unknown): Scene {
  if (typeof input === "string") {
    if (input.length > LIMITS.bytes)
      throw new VisualError("PAYLOAD_LIMIT", "Scene JSON is too large");
    try {
      input = JSON.parse(input);
    } catch {
      throw new VisualError("JSON", "Invalid scene JSON");
    }
  }
  preflight(input);
  const result = schema.safeParse(input);
  if (!result.success)
    throw new VisualError(
      "SCHEMA",
      result.error.issues
        .slice(0, 4)
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; "),
    );
  const scene = result.data as Scene;
  const fail = (message: string): never => {
    throw new VisualError("SCHEMA", message);
  };
  const failWith = <K extends ErrorKey>(
    key: K,
    ...params: Parameters<(typeof englishErrorMessages)[K]>
  ): never => {
    throw visualError("SCHEMA", key, ...params);
  };
  const stateKeys = Object.keys(scene.state);
  if (stateKeys.length > LIMITS.state) fail("Too many state fields");
  for (const f of Object.values(scene.state)) {
    if (
      f.kind === "number" &&
      (f.min > f.max ||
        f.step > f.max - f.min ||
        !Number.isFinite(f.max - f.min))
    )
      fail("Invalid state range/step");
    if (f.kind === "enum" && new Set(f.options).size !== f.options.length)
      fail("Duplicate enum options");
    assertStateValue(f, f.initial);
  }
  for (const key of scene.controls ?? [])
    if (!Object.hasOwn(scene.state, key)) fail(`Unknown control ${key}`);
  if (new Set(scene.controls).size !== (scene.controls?.length ?? 0))
    fail("Duplicate controls");
  const checkNumber = (prop: string, value: unknown) => {
    if (typeof value === "object") return; // AST values are checked when evaluated.
    if (typeof value !== "number") fail(`${prop} must be numeric`);
    const n = value as number;
    if (
      ["width", "height", "radius", "fontSize"].includes(prop) &&
      (n < 0 || n > 100_000)
    )
      fail(`Invalid ${prop}`);
    if (["opacity", "progress", "morph"].includes(prop) && (n < 0 || n > 1))
      fail(`Invalid ${prop}`);
    if (prop === "scale" && (n < 0.001 || n > 100)) fail("Invalid scale");
  };
  const all = new Map<string, SceneNode>();
  const definitions = new Set<string>();
  let points = 0;
  /** Node kinds each definition may contain. Definitions are static drawings: no links, uses,
   * manipulation, or nested clip/mask references. */
  const DEF_KINDS: Record<string, readonly SceneNode["kind"][]> = {
    clip: ["rect", "circle", "ellipse", "path"],
    mask: [
      "group",
      "rect",
      "circle",
      "ellipse",
      "line",
      "text",
      "path",
      "plot",
      "image",
    ],
    symbol: [
      "group",
      "rect",
      "circle",
      "ellipse",
      "line",
      "text",
      "path",
      "plot",
      "equation",
      "image",
    ],
  };
  function collect(
    nodes: SceneNode[],
    depth: number,
    within?: keyof typeof DEF_KINDS,
  ): void {
    if (depth > LIMITS.depth) fail("Scene nesting exceeds limit");
    for (const n of nodes) {
      if (all.has(n.id)) fail(`Duplicate node ${n.id}`);
      if (within) {
        if (!DEF_KINDS[within]!.includes(n.kind))
          fail(`A ${within} cannot contain ${n.kind} nodes`);
        if (n.manipulate || n.clip !== undefined || n.mask !== undefined)
          fail(
            `Nodes inside a ${within} cannot be manipulated, clipped or masked`,
          );
        definitions.add(n.id);
      }
      if (n.kind === "equation") {
        if (!n.label?.trim())
          fail(`Equation ${n.id} requires a label as its text alternative`);
        checkEquation(n.tex);
      }
      if (n.kind === "image" && !n.label?.trim())
        failWith("imageLabel", { node: n.id });
      for (const prop of numericProperties) {
        const value = (n as unknown as Record<string, unknown>)[prop];
        if (value !== undefined) checkNumber(prop, value);
      }
      all.set(n.id, n);
      if (all.size > LIMITS.nodes) fail("Too many scene nodes");
      if (n.kind === "group") collect(n.children, depth + 1, within);
      if (n.kind === "plot") {
        if (n.domainX[0] >= n.domainX[1] || n.domainY[0] >= n.domainY[1])
          fail("Plot domains must increase");
        points += n.points.length;
      }
      if (n.kind === "path") {
        points += n.commands.length + (n.morphTo?.length ?? 0);
        if (n.commands[0]?.command !== "M") fail("Paths must begin with M");
        if (n.morph !== undefined && !n.morphTo)
          failWith("morphNeedsTarget", { node: n.id });
        if (
          n.morphTo &&
          (n.morphTo.length !== n.commands.length ||
            n.morphTo.some((c, i) => c.command !== n.commands[i]!.command))
        )
          failWith("morphShape", { node: n.id });
      }
      if (n.manipulate) {
        if (!n.label) fail("Manipulable nodes require a label");
        if (!n.manipulate.x && !n.manipulate.y && !n.manipulate.activate)
          fail("Empty manipulation");
        for (const binding of [n.manipulate.x, n.manipulate.y])
          if (binding && scene.state[binding.state]?.kind !== "number")
            fail("Drag bindings require numeric state");
        if (n.manipulate.activate)
          assertStateValue(
            scene.state[n.manipulate.activate.state],
            n.manipulate.activate.value,
          );
      }
      if (
        n.kind === "link" &&
        (n.x !== undefined ||
          n.y !== undefined ||
          n.rotation !== undefined ||
          n.scale !== undefined ||
          n.manipulate)
      )
        fail("Links cannot transform or manipulate");
    }
  }
  collect(scene.nodes, 1);
  const reference = (code: string, message: string): never => {
    throw new VisualError(code, message);
  };
  const regions = {
    clip: new Set<string>(),
    mask: new Set<string>(),
    symbol: new Map<string, number>(),
    image: new Set<string>(),
  };
  for (const image of scene.defs?.images ?? []) {
    if (regions.image.has(image.id))
      failWith("imageDuplicate", { image: image.id });
    regions.image.add(image.id);
    verifyImageAsset(image);
  }
  for (const [kind, rows] of [
    ["clip", scene.defs?.clips ?? []],
    ["mask", scene.defs?.masks ?? []],
  ] as const)
    for (const row of rows) {
      if (regions[kind].has(row.id)) fail(`Duplicate ${kind} ${row.id}`);
      regions[kind].add(row.id);
      collect(row.nodes, 2, kind);
    }
  for (const symbol of scene.defs?.symbols ?? []) {
    if (regions.symbol.has(symbol.id)) fail(`Duplicate symbol ${symbol.id}`);
    const before = all.size;
    collect(symbol.nodes, 2, "symbol");
    regions.symbol.set(symbol.id, all.size - before);
  }
  if (points > LIMITS.points) fail("Too many path/plot points");
  let rendered = all.size,
    instances = 0;
  for (const n of all.values()) {
    if (n.clip !== undefined && !regions.clip.has(n.clip))
      reference(
        "UNDEFINED_REFERENCE",
        `Node ${n.id} references undefined clip ${n.clip}`,
      );
    if (n.mask !== undefined && !regions.mask.has(n.mask))
      reference(
        "UNDEFINED_REFERENCE",
        `Node ${n.id} references undefined mask ${n.mask}`,
      );
    if (n.kind === "image" && !regions.image.has(n.image))
      throw visualError("UNDEFINED_REFERENCE", "imageReference", {
        node: n.id,
        image: n.image,
      });
    if (n.kind === "use") {
      const size = regions.symbol.get(n.symbol);
      if (size === undefined)
        reference(
          "UNDEFINED_REFERENCE",
          `Node ${n.id} references undefined symbol ${n.symbol}`,
        );
      rendered += size!;
      instances++;
    }
    if (n.kind === "link")
      for (const end of [n.from, n.to]) {
        const target = all.get(end.node);
        if (!target || target.kind === "link" || definitions.has(end.node))
          fail("Links must reference a non-link node");
      }
  }
  if (instances > LIMITS.uses)
    reference("USE_LIMIT", `More than ${LIMITS.uses} symbol uses`);
  if (rendered > LIMITS.renderedNodes)
    reference("USE_LIMIT", "Symbol uses expand beyond the rendered node limit");
  const set = [
    scene.layouts.tabletPortrait,
    scene.layouts.tabletLandscape,
    scene.layouts.wide,
  ];
  if (set.some(Boolean) && !set.every(Boolean))
    fail("The layout set needs tabletPortrait, tabletLandscape and wide");
  if (set.every(Boolean) && scene.layouts.breakpoint !== undefined)
    fail("breakpoint applies only to the compact/expanded form");
  for (const l of [scene.layouts.compact, scene.layouts.expanded, ...set])
    if (l)
      for (const [key, patch] of Object.entries(l.overrides ?? {})) {
        const target = all.get(key);
        if (!target) fail(`Unknown layout node ${key}`);
        for (const [prop, value] of Object.entries(patch)) {
          if (!supportsProperty(target!, prop as NumericProperty))
            fail(`Invalid layout property ${key}.${prop}`);
          checkNumber(prop, value);
        }
      }
  const tracks = new Set<string>();
  const checkTrack = (
    node: string,
    property: NumericProperty,
    keys: Scene["timeline"]["tracks"][number]["keyframes"],
    offset: number,
  ) => {
    const target = all.get(node),
      key = `${node}.${property}`;
    if (!target || !supportsProperty(target, property) || tracks.has(key))
      fail(`Invalid/duplicate track ${key}`);
    tracks.add(key);
    let previous = -1;
    for (const k of keys) {
      checkNumber(property, k.value);
      if (k.atMs <= previous || k.atMs + offset > scene.timeline.durationMs)
        failWith("keyframesIncrease");
      previous = k.atMs;
    }
  };
  for (const track of scene.timeline.tracks)
    checkTrack(track.node, track.property, track.keyframes, 0);
  for (const stagger of scene.timeline.staggers ?? [])
    stagger.nodes.forEach((node, i) =>
      checkTrack(
        node,
        stagger.property,
        stagger.keyframes,
        i * stagger.delayMs,
      ),
    );
  for (const track of scene.timeline.colorTracks ?? []) {
    const target = all.get(track.node),
      key = `${track.node}.${track.property}`;
    if (!target || target.kind === "group" || tracks.has(key))
      failWith("colorTrackInvalid", { track: key });
    if (track.property === "fill" && typeof target!.fill === "object")
      failWith("colorTrackGradient", { track: key });
    tracks.add(key);
    let previous = -1;
    for (const k of track.keyframes) {
      if (k.atMs <= previous || k.atMs > scene.timeline.durationMs)
        failWith("keyframesIncrease");
      previous = k.atMs;
    }
  }
  if (scene.timeline.cameraTracks && !scene.camera)
    failWith("cameraTracksNeedCamera");
  for (const track of scene.timeline.cameraTracks ?? []) {
    const key = `camera.${track.property}`;
    if (tracks.has(key))
      failWith("cameraTrackDuplicate", { property: track.property });
    tracks.add(key);
    let previous = -1;
    for (const k of track.keyframes) {
      checkCamera(track.property, k.value);
      if (k.atMs <= previous || k.atMs > scene.timeline.durationMs)
        failWith("keyframesIncrease");
      previous = k.atMs;
    }
  }
  for (const prop of ["x", "y", "zoom"] as const) {
    const value = scene.camera?.[prop];
    if (typeof value === "number") checkCamera(prop, value);
    else if (value !== undefined && typeof value !== "object")
      failWith("cameraNumeric", { property: prop });
  }
  if (tracks.size > LIMITS.tracks) fail("Too many tracks");
  const paneIds = new Set<string>();
  for (const p of scene.panes ?? []) {
    if (paneIds.has(p.id)) fail(`Duplicate pane ${p.id}`);
    paneIds.add(p.id);
    if (
      p.kind === "table" &&
      p.rows.some((row) => row.length !== p.columns.length)
    )
      fail(`Pane ${p.id}: every row needs one cell per column`);
    if (p.kind === "formula") checkEquation(p.tex);
  }
  // Publish-time checks: every probe must name something the frame has.
  const panesById = new Map((scene.panes ?? []).map((p) => [p.id, p]));
  const checkProbe = (p: Probe): void => {
    if (p === null || typeof p !== "object") return;
    if ("op" in p) return p.args.forEach(checkProbe);
    if ("node" in p && !all.has(p.node))
      fail(`Invariant probes unknown node ${p.node}`);
    if ("cell" in p) {
      const pane = panesById.get(p.cell.pane);
      if (pane?.kind !== "table" || p.cell.column >= pane.columns.length)
        fail(`Invariant probes unknown table cell in ${p.cell.pane}`);
      checkProbe(p.cell.row);
    }
    if ("value" in p) {
      const pane = panesById.get(p.value.pane);
      if (
        pane?.kind !== "formula" ||
        !pane.values?.some((v) => v.symbol === p.value.symbol)
      )
        fail(`Invariant probes unknown formula value ${p.value.symbol}`);
    }
    if ("highlight" in p) {
      const pane = panesById.get(p.highlight);
      if (!pane || pane.kind === "formula")
        fail(`Invariant probes unknown highlight ${p.highlight}`);
    }
  };
  const modes = set.every(Boolean) ? 4 : 2;
  const modeNames = set.every(Boolean)
    ? ["compact", "tabletPortrait", "tabletLandscape", "wide"]
    : ["compact", "expanded"];
  const invariantIds = new Set<string>(),
    checkTimes = new Set<number>(),
    checkStates = new Set<string>();
  const defaultTimes = [
    0,
    ...scene.timeline.cues.map((c) => c.atMs),
    scene.timeline.durationMs,
  ];
  for (const inv of scene.invariants ?? []) {
    if (invariantIds.has(inv.id)) fail(`Duplicate invariant ${inv.id}`);
    invariantIds.add(inv.id);
    checkProbe(inv.assert);
    for (const t of inv.times ?? defaultTimes) {
      if (t > scene.timeline.durationMs)
        fail(`Invariant ${inv.id}: time outside duration`);
      checkTimes.add(t);
    }
    for (const overrides of inv.states ?? []) {
      for (const [key, value] of Object.entries(overrides))
        assertStateValue(scene.state[key], value);
      checkStates.add(JSON.stringify(overrides));
    }
  }
  if (modes * (1 + checkStates.size) * checkTimes.size > LIMITS.checkFrames)
    fail("Invariants request too many checked frames");
  const goldenKeys = new Set<string>();
  for (const g of scene.goldens ?? []) {
    if (!modeNames.includes(g.layout))
      fail(`Golden layout ${g.layout} is not a layout of this scene`);
    if (g.atMs > scene.timeline.durationMs)
      fail("Golden time outside duration");
    const key = `${g.layout}@${g.atMs}`;
    if (goldenKeys.has(key)) fail(`Duplicate golden ${key}`);
    goldenKeys.add(key);
  }
  let cueTime = -1;
  for (const cue of scene.timeline.cues) {
    if (cue.atMs < cueTime || cue.atMs > scene.timeline.durationMs)
      fail("Cues must be ordered within duration");
    cueTime = cue.atMs;
  }
  if (scene.accessibility.reducedMotion.atMs > scene.timeline.durationMs)
    fail("Reduced motion frame is outside duration");
  function inspect(value: unknown, depth = 0): void {
    if (!value || typeof value !== "object") return;
    if ("op" in value && typeof value.op === "string" && "args" in value) {
      if (depth > LIMITS.expressionDepth)
        fail("Expression nesting exceeds limit");
      const e = value as unknown as { args: unknown[] };
      for (const a of e.args) inspect(a, depth + 1);
      return;
    }
    if (
      "state" in value &&
      typeof value.state === "string" &&
      !Object.hasOwn(scene.state, value.state)
    )
      fail(`Unknown state ${value.state}`);
    for (const v of Object.values(value)) inspect(v, depth);
  }
  inspect(scene);
  for (const key of Object.keys(scene.simulation?.updates ?? {}))
    if (!Object.hasOwn(scene.state, key))
      fail(`Unknown simulation state ${key}`);
  return deepFreeze(scene);
}
export function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}
