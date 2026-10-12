import { z } from 'zod';
import { type Json, type OutputSchema } from './contracts.js';
import { ensure, ProviderError, type ErrorCode } from './errors.js';
import { boundedJson } from './json.js';

export function parse<S extends z.ZodType>(schema: S, input: unknown, code: ErrorCode = 'INVALID_INPUT'): z.output<S> {
  try { const result = schema.safeParse(input); if (result.success) return result.data; } catch { /* Never echo untrusted values. */ }
  throw new ProviderError(code);
}

const shape: z.ZodType<OutputSchema> = z.lazy(() => z.union([
  z.strictObject({ type: z.literal('string'), enum: z.array(z.string().max(1024)).min(1).max(256).optional() }),
  z.strictObject({ type: z.enum(['number', 'integer']), minimum: z.number().optional(), maximum: z.number().optional() }),
  z.strictObject({ type: z.enum(['boolean', 'null']) }),
  z.strictObject({ type: z.literal('array'), items: shape, minItems: z.number().int().nonnegative(), maxItems: z.number().int().nonnegative().max(1024) }),
  z.strictObject({ type: z.literal('object'), properties: z.record(z.string().max(128), shape), required: z.array(z.string().max(128)).max(256) }),
]));

export function compileOutputSchema(input: OutputSchema) {
  boundedJson(input, 'INVALID_INPUT', 24, 4000);
  ensure(JSON.stringify(input).length <= 65_536);
  const spec = parse(shape, input);
  function compile(s: OutputSchema): z.ZodType {
    if (s.type === 'string') return s.enum ? z.enum(s.enum as [string, ...string[]]) : z.string();
    if (s.type === 'boolean') return z.boolean();
    if (s.type === 'null') return z.null();
    if (s.type === 'number' || s.type === 'integer') {
      ensure(s.minimum === undefined || s.maximum === undefined || s.minimum <= s.maximum);
      let number = s.type === 'integer' ? z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER) : z.number();
      if (s.minimum !== undefined) number = number.min(s.minimum);
      if (s.maximum !== undefined) number = number.max(s.maximum);
      return number;
    }
    if (s.type === 'array') { ensure(s.minItems <= s.maxItems); return z.array(compile(s.items)).min(s.minItems).max(s.maxItems); }
    if (s.type === 'object') {
      ensure(Object.keys(s.properties).length <= 256 && new Set(s.required).size === s.required.length && s.required.every(key => Object.hasOwn(s.properties, key)));
      return z.strictObject(Object.fromEntries(Object.entries(s.properties).map(([key, child]) => {
        const validator = compile(child); return [key, s.required.includes(key) ? validator : validator.optional()];
      })));
    }
    throw new ProviderError('INVALID_INPUT');
  }
  const validator = compile(spec);
  const jsonSchema = z.toJSONSchema(validator, { target: 'draft-2020-12' });
  delete jsonSchema.$schema;
  return { jsonSchema, validate(input: unknown): Json {
    boundedJson(input, 'INVALID_RESPONSE');
    return parse(validator, input, 'INVALID_RESPONSE') as Json;
  } };
}
