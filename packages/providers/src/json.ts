import { ensure, type ErrorCode } from './errors.js';

/** Bounded data-only JSON. No getters, executable values, prototypes or cycles. */
export function boundedJson(input: unknown, code: ErrorCode, maxDepth = 32, maxNodes = 100_000) {
  const queue: { value: unknown; depth: number }[] = [{ value: input, depth: 0 }];
  const seen = new WeakSet<object>(); let nodes = 0;
  while (queue.length) {
    const { value, depth } = queue.pop()!;
    ensure(++nodes <= maxNodes && depth <= maxDepth, code);
    if (value === null || typeof value === 'boolean' || typeof value === 'string') continue;
    if (typeof value === 'number') { ensure(Number.isFinite(value), code); continue; }
    ensure(typeof value === 'object' && !seen.has(value), code); seen.add(value);
    ensure(Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null, code);
    ensure(Object.getOwnPropertySymbols(value).length === 0, code);
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (Array.isArray(value) && key === 'length') continue;
      ensure(descriptor.enumerable && 'value' in descriptor && !['__proto__', 'prototype', 'constructor'].includes(key), code);
      if (Array.isArray(value)) ensure(/^(0|[1-9][0-9]*)$/.test(key), code);
      queue.push({ value: descriptor.value, depth: depth + 1 });
    }
    if (Array.isArray(value)) ensure(Object.keys(value).length === value.length, code);
  }
}
