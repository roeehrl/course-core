import type { Expression, State, Value } from "./types.js";

export const MAX_VALUE = 1_000_000_000;
export class VisualError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "VisualError";
  }
}
export function finite(value: number, label = "number"): number {
  if (!Number.isFinite(value) || Math.abs(value) > MAX_VALUE)
    throw new VisualError(
      "NON_FINITE",
      `${label} must be finite and within ±${MAX_VALUE}`,
    );
  return Object.is(value, -0) ? 0 : value;
}
export interface EvaluationContext {
  state: State;
  timeMs: number;
  seed: number;
  tick: number;
  budget?: { remaining: number };
}
export const operatorArity = {
  add: [2, 16],
  sub: [2, 2],
  mul: [2, 16],
  div: [2, 2],
  mod: [2, 2],
  pow: [2, 2],
  min: [2, 16],
  max: [2, 16],
  clamp: [3, 3],
  lerp: [3, 3],
  abs: [1, 1],
  sqrt: [1, 1],
  sin: [1, 1],
  cos: [1, 1],
  floor: [1, 1],
  round: [1, 1],
  eq: [2, 2],
  lt: [2, 2],
  lte: [2, 2],
  gt: [2, 2],
  gte: [2, 2],
  and: [2, 16],
  or: [2, 16],
  not: [1, 1],
  concat: [2, 16],
  if: [3, 3],
} as const;
/** Stable uint32 hash/PRNG sample keyed by seed, fixed tick and author label. */
export function seededSample(
  seed: number,
  tick: number,
  label: string,
): number {
  if (
    !Number.isInteger(seed) ||
    seed < 0 ||
    seed > 4294967295 ||
    !Number.isInteger(tick) ||
    tick < 0 ||
    tick > MAX_VALUE ||
    typeof label !== "string" ||
    !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(label)
  )
    throw new VisualError("SAMPLE", "Invalid sample seed, tick or label");
  let h = (seed ^ Math.imul(tick, 0x9e3779b1)) >>> 0;
  for (let i = 0; i < label.length; i++)
    h = Math.imul(h ^ label.charCodeAt(i), 16777619) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
export function evaluate(
  expression: Expression,
  context: EvaluationContext,
): Value {
  const budget = context.budget ?? { remaining: 4096 };
  function visit(e: Expression, depth: number): Value {
    if (--budget.remaining < 0 || depth > 16)
      throw new VisualError(
        "EXPRESSION_LIMIT",
        "Expression evaluation budget exceeded",
      );
    if (typeof e === "number") return finite(e);
    if (typeof e === "boolean") return e;
    if (typeof e === "string") {
      if (e.length > 2048)
        throw new VisualError("TEXT_LIMIT", "Text is too long");
      return e;
    }
    if (!e || typeof e !== "object" || Array.isArray(e))
      throw new VisualError("EXPRESSION", "Invalid expression");
    const prototype = Object.getPrototypeOf(e),
      descriptors = Object.getOwnPropertyDescriptors(e),
      keys = Object.keys(descriptors);
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      keys.some((k) => !("value" in descriptors[k]!))
    )
      throw new VisualError("EXPRESSION", "Expressions must be plain data");
    const exact = (allowed: string[]) => {
      if (
        keys.length !== allowed.length ||
        keys.some((k) => !allowed.includes(k))
      )
        throw new VisualError("EXPRESSION", "Unexpected expression fields");
    };
    if ("state" in e) {
      exact(["state"]);
      if (
        typeof e.state !== "string" ||
        !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(e.state) ||
        ["constructor", "prototype", "__proto__"].includes(e.state)
      )
        throw new VisualError("STATE", "Invalid state identifier");
      if (!Object.hasOwn(context.state, e.state))
        throw new VisualError("STATE", `Unknown state: ${e.state}`);
      const value = context.state[e.state]!;
      return typeof value === "number" ? finite(value) : value;
    }
    if ("time" in e) {
      exact(["time"]);
      if (e.time !== true)
        throw new VisualError("EXPRESSION", "Invalid time expression");
      return finite(context.timeMs);
    }
    if ("sample" in e) {
      exact(["sample"]);
      return seededSample(context.seed, context.tick, e.sample);
    }
    if (
      !("op" in e) ||
      !Object.hasOwn(operatorArity, e.op) ||
      !Array.isArray(e.args)
    )
      throw new VisualError("EXPRESSION", "Unknown operator");
    exact(["op", "args"]);
    const arity = operatorArity[e.op];
    if (e.args.length < arity[0] || e.args.length > arity[1])
      throw new VisualError("EXPRESSION", `Invalid arity for ${e.op}`);
    if (
      Reflect.ownKeys(e.args).length !== e.args.length + 1 ||
      Array.from({ length: e.args.length }, (_, i) => i).some(
        (i) => !Object.hasOwn(e.args, i),
      )
    )
      throw new VisualError("EXPRESSION", "Arguments must be dense arrays");
    if (
      Object.values(Object.getOwnPropertyDescriptors(e.args)).some(
        (d) => !("value" in d),
      )
    )
      throw new VisualError(
        "EXPRESSION",
        "Expression arguments must be plain data",
      );
    const get = (i: number) => visit(e.args[i]!, depth + 1);
    const boolean = (v: Value) => {
      if (typeof v !== "boolean")
        throw new VisualError("TYPE", "Expected boolean");
      return v;
    };
    if (e.op === "if") return get(boolean(get(0)) ? 1 : 2);
    if (e.op === "and") return e.args.every((_, i) => boolean(get(i)));
    if (e.op === "or") return e.args.some((_, i) => boolean(get(i)));
    if (e.op === "not") return !boolean(get(0));
    const values = e.args.map((_, i) => get(i));
    if (e.op === "concat") {
      const text = values.join("");
      if (text.length > 2048)
        throw new VisualError("TEXT_LIMIT", "Expression text exceeds limit");
      return text;
    }
    if (e.op === "eq") return values[0] === values[1];
    const n = values.map((v) => {
      if (typeof v !== "number")
        throw new VisualError("TYPE", `Expected numbers for ${e.op}`);
      return finite(v);
    });
    const a = n[0]!,
      b = n[1]!,
      c = n[2]!;
    let result: number;
    switch (e.op) {
      case "lt":
        return a < b;
      case "lte":
        return a <= b;
      case "gt":
        return a > b;
      case "gte":
        return a >= b;
      case "add":
        result = n.reduce((x, y) => finite(x + y), 0);
        break;
      case "sub":
        result = a - b;
        break;
      case "mul":
        result = n.reduce((x, y) => finite(x * y), 1);
        break;
      case "div":
        if (!b) throw new VisualError("DIV_ZERO", "Division by zero");
        result = a / b;
        break;
      case "mod":
        if (!b) throw new VisualError("DIV_ZERO", "Modulo by zero");
        result = a % b;
        break;
      case "pow":
        if (Math.abs(b) > 32)
          throw new VisualError("OVERFLOW", "Exponent out of bounds");
        result = a ** b;
        break;
      case "min":
        result = Math.min(...n);
        break;
      case "max":
        result = Math.max(...n);
        break;
      case "clamp":
        if (b > c) throw new VisualError("RANGE", "Reversed clamp range");
        result = Math.min(c, Math.max(b, a));
        break;
      case "lerp":
        result = finite(a + finite(finite(b - a) * c));
        break;
      case "abs":
        result = Math.abs(a);
        break;
      case "sqrt":
        result = Math.sqrt(a);
        break;
      case "sin":
        result = Math.sin(a);
        break;
      case "cos":
        result = Math.cos(a);
        break;
      case "floor":
        result = Math.floor(a);
        break;
      case "round":
        result = Math.round(a);
        break;
      default:
        throw new VisualError("EXPRESSION", "Unsupported expression");
    }
    return finite(result);
  }
  return visit(expression, 0);
}
