/** Reported in the learning-event envelope; keep equal to package.json's version. */
export const ADMIN_APP_VERSION = "0.1.0";

/**
 * Client facts the API records on the learning events a request appends
 * (services/api/src/event-envelope.ts). Same contract as the learner app: sent
 * on every non-GET request, advisory only, and never a credential. The sequence
 * is this client's own counter, one per request that may record events.
 */
export function createEventEnvelope(now: () => Date = () => new Date()) {
  let sequence = 0;
  return (method: string): Record<string, string> =>
    method.toUpperCase() === "GET"
      ? {}
      : {
          "X-Course-Platform": "web",
          "X-Course-App-Version": ADMIN_APP_VERSION,
          "X-Course-Client-Sequence": String(++sequence),
          "X-Course-Occurred-At": now().toISOString(),
        };
}
