/**
 * W3C trace context for requests from this app (U03). Each request carries a fresh `traceparent`
 * with random ids. The API never adopts it as a parent: it records it as a link on its own span,
 * so a request seen here (for example in the browser's network panel) can be found in the trace
 * backend. The sampled flag is off because the browser records no spans itself.
 */
const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
export function newTraceparent(
  random: (bytes: Uint8Array<ArrayBuffer>) => Uint8Array = (bytes) =>
    globalThis.crypto.getRandomValues(bytes),
) {
  let trace = hex(random(new Uint8Array(new ArrayBuffer(16)))),
    span = hex(random(new Uint8Array(new ArrayBuffer(8))));
  // All-zero ids are invalid; vanishingly unlikely, but never send one.
  if (/^0+$/.test(trace)) trace = "1".padStart(32, "0");
  if (/^0+$/.test(span)) span = "1".padStart(16, "0");
  return `00-${trace}-${span}-00`;
}
/** Adds a `traceparent` to every request that does not already carry one. */
export function withTraceContext(
  fetcher: typeof globalThis.fetch,
  traceparent: () => string = () => newTraceparent(),
): typeof globalThis.fetch {
  return (input, init) => {
    const headers = new Headers(init?.headers);
    if (!headers.has("traceparent")) headers.set("traceparent", traceparent());
    return fetcher(input, { ...init, headers });
  };
}
