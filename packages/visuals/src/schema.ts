import { z } from "zod";
import { MAX_VALUE, VisualError, operatorArity } from "./expression.js";
import type {
  Expression,
  NumericProperty,
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
  ]),
);
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
const schema = z
  .object({
    version: z.literal(1),
    id,
    title: text,
    description: text,
    state: z.record(id, field),
    controls: z.array(id).max(LIMITS.state).optional(),
    nodes: z.array(node).min(1).max(LIMITS.nodes),
    layouts: z
      .object({
        compact: layout,
        expanded: layout,
        breakpoint: z.number().min(240).max(1200).optional(),
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
                keyframes: z
                  .array(
                    z
                      .object({
                        atMs: positive,
                        value: number,
                        ease: z
                          .enum(["linear", "smooth", "in", "out", "step"])
                          .optional(),
                      })
                      .strict(),
                  )
                  .min(1)
                  .max(LIMITS.keyframes),
              })
              .strict(),
          )
          .max(LIMITS.tracks),
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
export function supportsProperty(
  node: SceneNode,
  prop: NumericProperty,
): boolean {
  if (["x", "y", "rotation", "scale", "opacity"].includes(prop))
    return node.kind !== "link" || prop === "opacity";
  return (
    (
      {
        width: ["rect", "ellipse", "plot"],
        height: ["rect", "ellipse", "plot"],
        radius: ["circle"],
        fontSize: ["text"],
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
    if (["opacity", "progress"].includes(prop) && (n < 0 || n > 1))
      fail(`Invalid ${prop}`);
    if (prop === "scale" && (n < 0.001 || n > 100)) fail("Invalid scale");
  };
  const all = new Map<string, SceneNode>();
  let points = 0;
  function collect(nodes: SceneNode[], depth: number): void {
    if (depth > LIMITS.depth) fail("Scene nesting exceeds limit");
    for (const n of nodes) {
      if (all.has(n.id)) fail(`Duplicate node ${n.id}`);
      for (const prop of numericProperties) {
        const value = (n as unknown as Record<string, unknown>)[prop];
        if (value !== undefined) checkNumber(prop, value);
      }
      all.set(n.id, n);
      if (all.size > LIMITS.nodes) fail("Too many scene nodes");
      if (n.kind === "group") collect(n.children, depth + 1);
      if (n.kind === "plot") {
        if (n.domainX[0] >= n.domainX[1] || n.domainY[0] >= n.domainY[1])
          fail("Plot domains must increase");
        points += n.points.length;
      }
      if (n.kind === "path") {
        points += n.commands.length;
        if (n.commands[0]?.command !== "M") fail("Paths must begin with M");
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
  if (points > LIMITS.points) fail("Too many path/plot points");
  for (const n of all.values())
    if (n.kind === "link")
      for (const end of [n.from, n.to]) {
        const target = all.get(end.node);
        if (!target || target.kind === "link")
          fail("Links must reference a non-link node");
      }
  for (const l of [scene.layouts.compact, scene.layouts.expanded])
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
  for (const track of scene.timeline.tracks) {
    const target = all.get(track.node),
      key = `${track.node}.${track.property}`;
    if (!target || !supportsProperty(target, track.property) || tracks.has(key))
      fail(`Invalid/duplicate track ${key}`);
    tracks.add(key);
    let previous = -1;
    for (const k of track.keyframes) {
      checkNumber(track.property, k.value);
      if (k.atMs <= previous || k.atMs > scene.timeline.durationMs)
        fail("Keyframes must increase within duration");
      previous = k.atMs;
    }
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
