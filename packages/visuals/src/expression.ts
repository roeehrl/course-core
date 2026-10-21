import type { Expression, State, Value } from "./types.js";
import { visualError } from "./errors.js";
import { VisualError } from "./visual-error.js";

export const MAX_VALUE = 1_000_000_000;
export { VisualError };
export function finite(value: number, label = "number"): number {
  if (!Number.isFinite(value) || Math.abs(value) > MAX_VALUE)
    throw visualError("NON_FINITE", "nonFinite", { label, max: MAX_VALUE });
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
    throw visualError("SAMPLE", "invalidSample");
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
      throw visualError(
        "EXPRESSION_LIMIT",
        "expressionEvaluationBudgetExceeded",
      );
    if (typeof e === "number") return finite(e);
    if (typeof e === "boolean") return e;
    if (typeof e === "string") {
      if (e.length > 2048) throw visualError("TEXT_LIMIT", "textIsTooLong");
      return e;
    }
    if (!e || typeof e !== "object" || Array.isArray(e))
      throw visualError("EXPRESSION", "invalidExpression");
    const prototype = Object.getPrototypeOf(e),
      descriptors = Object.getOwnPropertyDescriptors(e),
      keys = Object.keys(descriptors);
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      keys.some((k) => !("value" in descriptors[k]!))
    )
      throw visualError("EXPRESSION", "expressionsMustBePlainData");
    const exact = (allowed: string[]) => {
      if (
        keys.length !== allowed.length ||
        keys.some((k) => !allowed.includes(k))
      )
        throw visualError("EXPRESSION", "unexpectedExpressionFields");
    };
    if ("state" in e) {
      exact(["state"]);
      if (
        typeof e.state !== "string" ||
        !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(e.state) ||
        ["constructor", "prototype", "__proto__"].includes(e.state)
      )
        throw visualError("STATE", "invalidStateIdentifier");
      if (!Object.hasOwn(context.state, e.state))
        throw visualError("STATE", "unknownState", { state: e.state });
      const value = context.state[e.state]!;
      return typeof value === "number" ? finite(value) : value;
    }
    if ("time" in e) {
      exact(["time"]);
      if (e.time !== true)
        throw visualError("EXPRESSION", "invalidTimeExpression");
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
      throw visualError("EXPRESSION", "unknownOperator");
    exact(["op", "args"]);
    const arity = operatorArity[e.op];
    if (e.args.length < arity[0] || e.args.length > arity[1])
      throw visualError("EXPRESSION", "invalidArity", { op: e.op });
    if (
      Reflect.ownKeys(e.args).length !== e.args.length + 1 ||
      Array.from({ length: e.args.length }, (_, i) => i).some(
        (i) => !Object.hasOwn(e.args, i),
      )
    )
      throw visualError("EXPRESSION", "argumentsMustBeDenseArrays");
    if (
      Object.values(Object.getOwnPropertyDescriptors(e.args)).some(
        (d) => !("value" in d),
      )
    )
      throw visualError("EXPRESSION", "expressionArgumentsPlainData");
    const get = (i: number) => visit(e.args[i]!, depth + 1);
    const boolean = (v: Value) => {
      if (typeof v !== "boolean") throw visualError("TYPE", "expectedBoolean");
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
        throw visualError("TEXT_LIMIT", "expressionTextExceedsLimit");
      return text;
    }
    if (e.op === "eq") return values[0] === values[1];
    const n = values.map((v) => {
      if (typeof v !== "number")
        throw visualError("TYPE", "expectedNumbers", { op: e.op });
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
        if (!b) throw visualError("DIV_ZERO", "divisionByZero");
        result = a / b;
        break;
      case "mod":
        if (!b) throw visualError("DIV_ZERO", "moduloByZero");
        result = a % b;
        break;
      case "pow":
        if (Math.abs(b) > 32)
          throw visualError("OVERFLOW", "exponentOutOfBounds");
        result = a ** b;
        break;
      case "min":
        result = Math.min(...n);
        break;
      case "max":
        result = Math.max(...n);
        break;
      case "clamp":
        if (b > c) throw visualError("RANGE", "reversedClampRange");
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
        throw visualError("EXPRESSION", "unsupportedExpression");
    }
    return finite(result);
  }
  return visit(expression, 0);
}
