import { randomUUID } from "node:crypto";
import { z } from "zod";

/**
 * A minimal value that satisfies a route's JSON schema, so a request passes Fastify's schema
 * validation and reaches the handler, where authorization runs. Only the keywords the API's
 * route schemas use are understood; anything else falls back to a plain value.
 */
export function sampleSchema(schema: unknown, depth = 0): unknown {
  if (!schema || typeof schema !== "object" || depth > 8) return undefined;
  const s = schema as Record<string, unknown>;
  if ("const" in s) return s.const;
  if (Array.isArray(s.enum)) return s.enum[0];
  for (const key of ["oneOf", "anyOf", "allOf"] as const) if (Array.isArray(s[key]) && (s[key] as unknown[]).length) {
    if (key !== "allOf") return sampleSchema((s[key] as unknown[])[0], depth + 1);
    return Object.assign({}, ...(s[key] as unknown[]).map((part) => sampleSchema(part, depth + 1) as object));
  }
  const type = Array.isArray(s.type) ? s.type.find((t) => t !== "null") : s.type;
  switch (type ?? (s.properties ? "object" : undefined)) {
    case "object": {
      const properties = (s.properties ?? {}) as Record<string, unknown>, required = (s.required ?? []) as string[];
      return Object.fromEntries(required.map((name) => [name, sampleSchema(properties[name] ?? {}, depth + 1) ?? "x"]));
    }
    case "array":
      if (Array.isArray(s.prefixItems)) return s.prefixItems.map((item) => sampleSchema(item, depth + 1) ?? "x");
      return Array.from({ length: Number(s.minItems ?? 0) }, () => sampleSchema(s.items, depth + 1) ?? "x");
    case "integer":
    case "number":
      return typeof s.minimum === "number" ? s.minimum : typeof s.exclusiveMinimum === "number" ? s.exclusiveMinimum + 1 : typeof s.maximum === "number" ? Math.min(s.maximum, 1) : 1;
    case "boolean":
      // Acknowledgement and consent flags must be true for a request to proceed.
      return true;
    case "null":
      return null;
    case "string":
      return sampleString(s);
    default:
      return undefined;
  }
}

function sampleString(s: Record<string, unknown>) {
  if (s.format === "uuid") return randomUUID();
  if (s.format === "date-time") return new Date(Date.now() + 86_400_000).toISOString();
  if (s.format === "date") return new Date().toISOString().slice(0, 10);
  if (s.format === "uri" || s.format === "url") return "https://example.org/";
  if (s.format === "email") return "matrix@example.org";
  const min = Number(s.minLength ?? 1), max = Number(s.maxLength ?? Infinity);
  const pattern = typeof s.pattern === "string" ? s.pattern : "";
  const candidates = [
    // Random first, so idempotency keys and names never collide between probes.
    ("r" + randomUUID().replaceAll("-", "")).slice(0, Math.max(min, Math.min(max, 24))),
    "a".repeat(Math.max(min, Math.min(max, 8))),
    randomUUID(),
    "0".repeat(64),
    "A".repeat(43),
    "x-" + "a".repeat(Math.max(1, min - 2)),
    "1.0.0",
    "a1",
    "a",
  ];
  return candidates.find((c) => c.length >= min && c.length <= max && (!pattern || new RegExp(pattern, "u").test(c))) ?? "a".repeat(min);
}

/** Path values by parameter name: the known fixture values, else a sample of the route's
 * parameter schema, else a fresh UUID. Anything not known names a resource that does not exist. */
export function fillPath(url: string, known: Record<string, string>, paramsSchema?: unknown) {
  const sampled = (sampleSchema(paramsSchema) ?? {}) as Record<string, unknown>;
  return url.replace(/:([A-Za-z0-9_]+)/g, (_m, name: string) => encodeURIComponent(known[name] ?? String(sampled[name] ?? randomUUID())));
}

/** Zod schemas that rejected a value while capture is on. Route handlers validate bodies with zod
 * inside the handler, often before they authorize; the matrix uses a schema that refused a probe
 * body to build a valid one, so the retried request reaches authorization. Test-only. */
const rejected: { schema: z.ZodType; data: unknown }[] = [];
let capturing = false;
export function installZodCapture() {
  const samples = [z.strictObject({}), z.strictObject({}).transform((x) => x), z.union([z.string(), z.number()]),
    z.discriminatedUnion("k", [z.object({ k: z.literal("a") })]), z.intersection(z.object({}), z.object({}))];
  const patched = new Set<object>();
  for (const sample of samples) {
    const proto = Object.getPrototypeOf(sample) as object;
    if (patched.has(proto)) continue;
    patched.add(proto);
    for (const method of ["parse", "safeParse"] as const) {
      const descriptor = Object.getOwnPropertyDescriptor(proto, method);
      if (!descriptor?.get) continue;
      const get = descriptor.get;
      Object.defineProperty(proto, method, { ...descriptor, get(this: z.ZodType) {
        // zod caches the bound method on the instance on first access; cache the wrapper instead.
        const fn = get.call(this) as (data: unknown, params?: unknown) => { success?: boolean };
        const wrapped = (data: unknown, params?: unknown) => {
          try {
            const result = fn(data, params);
            if (capturing && result?.success === false) rejected.push({ schema: this, data });
            return result;
          } catch (error) {
            if (capturing) rejected.push({ schema: this, data });
            throw error;
          }
        };
        Object.defineProperty(this, method, { value: wrapped, configurable: true, writable: true });
        return wrapped;
      } });
    }
  }
}
/** Runs `request` with capture on and returns the first schema that rejected exactly `value`. */
export async function rejectingSchema<T>(value: unknown, request: () => Promise<T>): Promise<{ result: T; schema: z.ZodType | undefined; partial: boolean }> {
  rejected.length = 0;
  capturing = true;
  try {
    const result = await request();
    const wanted = JSON.stringify(value ?? {}), sent = (value ?? {}) as Record<string, unknown>;
    // The value itself, or (for a handler that adds path values before validating) an object holding every sent field.
    const exact = rejected.find((r) => JSON.stringify(r.data ?? {}) === wanted);
    const holding = rejected.find((r) => r.data && typeof r.data === "object" && Object.keys(sent).length > 0
      && Object.entries(sent).every(([k, v]) => JSON.stringify((r.data as Record<string, unknown>)[k]) === JSON.stringify(v)));
    return { result, schema: (exact ?? holding)?.schema, partial: !exact && !!holding };
  } finally { capturing = false; rejected.length = 0; }
}
/** A value the zod schema accepts, from its JSON Schema form (refinements are not represented). */
export function sampleZod(schema: z.ZodType) {
  try { return sampleSchema(z.toJSONSchema(schema, { unrepresentable: "any", io: "input" })); } catch { return undefined; }
}
