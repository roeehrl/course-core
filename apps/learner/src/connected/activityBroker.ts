import type { JsonValue } from "../client/activityClient";

/** What the parent sends back to the sandboxed frame over its private MessagePort. */
export type BrokerReply = { type: "result"; id: number; ok: true; value: JsonValue } | { type: "result"; id: number; ok: false; error: string };
export interface FrameBrokerOptions {
  /** Capabilities the server granted at launch. Anything else is denied without a request. */
  granted: readonly string[];
  /** Upper bound of one message's payload, from the activity's declared budget. */
  maxPayloadBytes: number;
  stateRevision: number;
  /** Sends a granted call to the server's broker (which checks the grant again). */
  forward(capability: string, payload: JsonValue, expectedStateRevision: number | undefined): Promise<unknown>;
  post(reply: BrokerReply): void;
  onReady(): void;
  onObserved?(result: unknown): void;
}
const MAX_IN_FLIGHT = 4;
const errorCode = (error: unknown) => {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" && /^[A-Z0-9_]{1,64}$/.test(code) ? code : "FAILED";
};
const byteLength = (value: unknown) => {
  try { return new TextEncoder().encode(JSON.stringify(value)).length; } catch { return Number.POSITIVE_INFINITY; }
};

/**
 * The parent half of the capability broker for a sandboxed activity frame. Messages arrive only
 * on the MessagePort Core handed to the frame; they are untrusted data. Undeclared or
 * unimplemented capabilities are denied here and again by the server.
 */
export function createFrameBroker(options: FrameBrokerOptions) {
  let ready = false, inFlight = 0, stateRevision = options.stateRevision;
  const granted = new Set(options.granted);
  async function call(id: number, capability: string, payload: JsonValue) {
    if (!granted.has(capability)) return options.post({ type: "result", id, ok: false, error: "CAPABILITY_DENIED" });
    if (byteLength(payload) > options.maxPayloadBytes) return options.post({ type: "result", id, ok: false, error: "PAYLOAD_TOO_LARGE" });
    if (inFlight >= MAX_IN_FLIGHT) return options.post({ type: "result", id, ok: false, error: "BUSY" });
    inFlight++;
    try {
      const value = await options.forward(capability, payload, capability === "state.patch" ? stateRevision : undefined);
      const revision = (value as { stateRevision?: unknown })?.stateRevision;
      if (Number.isSafeInteger(revision)) stateRevision = revision as number;
      if (capability === "observation.emit") options.onObserved?.(value);
      options.post({ type: "result", id, ok: true, value: value as JsonValue });
    } catch (error) {
      options.post({ type: "result", id, ok: false, error: errorCode(error) });
    } finally {
      inFlight--;
    }
  }
  return {
    get ready() { return ready; },
    handle(data: unknown) {
      if (!data || typeof data !== "object" || Array.isArray(data)) return;
      const message = data as Record<string, unknown>;
      if (message.type === "ready") {
        if (!ready) { ready = true; options.onReady(); }
        return;
      }
      if (message.type !== "call" || !ready || !Number.isSafeInteger(message.id) || (message.id as number) < 1) return;
      const capability = typeof message.capability === "string" && message.capability.length <= 100 ? message.capability : "";
      void call(message.id as number, capability, (message.payload ?? null) as JsonValue);
    },
  };
}
