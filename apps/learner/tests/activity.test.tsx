import React from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createFrameBroker, type BrokerReply } from "../src/connected/activityBroker";
import { parseLaunch, type ActivityClient, type ActivityRun } from "../src/client/activityClient";
import { ActivityBlock, ACTIVITY_FRAME_SANDBOX, activityTarget } from "../src/connected/ActivityBlock.web";

const instanceId = "11111111-1111-4111-8111-111111111111";
const run = (overrides: Partial<ActivityRun> = {}): ActivityRun => ({
  mode: "run", instanceId, activityId: "min-explore", title: "Explore the minimum", execution: "declarative", target: "web_desktop",
  grantedCapabilities: ["state.read", "state.patch", "observation.emit"], state: { values: { value: null, sure: null } }, stateRevision: 1,
  configuration: { prompt: "Set the field to the smaller of 4 and 9.", controls: [{ id: "value", label: "Smaller value", kind: "number", min: 0, max: 10, step: 1 }, { id: "sure", label: "I checked both", kind: "toggle" }], submitLabel: "Submit my value" },
  budget: { timeoutMs: 5000, maxMemoryMb: 64, maxStateBytes: 2048, maxEventBytes: 1024, maxEventsPerMinute: 5 },
  accessibility: { keyboard: true, screenReader: true, reducedMotion: true, nonPointerPath: true, textAlternative: "Pick the smaller value with the number field." },
  evaluated: true, satisfied: false, ...overrides,
});

type Forward = (capability: string, payload: unknown, expected?: number) => Promise<unknown>;
function broker(granted: string[], forward = vi.fn<Forward>(async () => ({ ok: true }))) {
  const replies: BrokerReply[] = [];
  const onReady = vi.fn();
  const instance = createFrameBroker({ granted, maxPayloadBytes: 200, stateRevision: 1, forward, post: (reply) => replies.push(reply), onReady });
  return { instance, replies, forward, onReady };
}

describe("frame capability broker", () => {
  it("denies undeclared capabilities without contacting the server", async () => {
    const { instance, replies, forward } = broker(["observation.emit"]);
    instance.handle({ type: "ready" });
    instance.handle({ type: "call", id: 1, capability: "network.fetch", payload: { url: "https://example.org" } });
    instance.handle({ type: "call", id: 2, capability: "evidence.write", payload: {} });
    instance.handle({ type: "call", id: 3, capability: "observation.emit", payload: { observation: { kind: "x" } } });
    await waitFor(() => expect(replies).toHaveLength(3));
    expect(replies.filter((r) => !r.ok).map((r) => [r.id, (r as { error: string }).error])).toEqual([[1, "CAPABILITY_DENIED"], [2, "CAPABILITY_DENIED"]]);
    expect(forward).toHaveBeenCalledTimes(1);
    expect(forward).toHaveBeenCalledWith("observation.emit", { observation: { kind: "x" } }, undefined);
  });
  it("ignores calls before the handshake and malformed messages, and bounds payloads", async () => {
    const { instance, replies, forward, onReady } = broker(["state.patch"]);
    instance.handle({ type: "call", id: 1, capability: "state.patch", payload: {} });
    expect(onReady).not.toHaveBeenCalled();
    instance.handle({ type: "ready" });
    instance.handle({ type: "ready" });
    expect(onReady).toHaveBeenCalledTimes(1);
    for (const bad of [null, "call", [], { type: "call", id: "1", capability: "state.patch" }, { type: "call", id: 0, capability: "state.patch" }]) instance.handle(bad);
    instance.handle({ type: "call", id: 5, capability: "state.patch", payload: { state: { pad: "x".repeat(500) } } });
    await waitFor(() => expect(replies).toHaveLength(1));
    expect(replies[0]).toEqual({ type: "result", id: 5, ok: false, error: "PAYLOAD_TOO_LARGE" });
    expect(forward).not.toHaveBeenCalled();
  });
  it("tracks the state revision for patches and reports server refusals by code only", async () => {
    let revision = 1;
    const forward = vi.fn<Forward>(async (capability, _payload, expected) => {
      if (capability === "state.read") throw Object.assign(new Error("secret body"), { code: "ACTIVITY_CAPABILITY_DENIED" });
      expect(expected).toBe(revision);
      return { stateRevision: ++revision };
    });
    const { instance, replies } = broker(["state.patch", "state.read"], forward);
    instance.handle({ type: "ready" });
    instance.handle({ type: "call", id: 1, capability: "state.patch", payload: { state: { a: 1 } } });
    await waitFor(() => expect(replies).toHaveLength(1));
    instance.handle({ type: "call", id: 2, capability: "state.patch", payload: { state: { a: 2 } } });
    instance.handle({ type: "call", id: 3, capability: "state.read", payload: null });
    await waitFor(() => expect(replies).toHaveLength(3));
    expect(replies.find((r) => r.id === 2)).toEqual({ type: "result", id: 2, ok: true, value: { stateRevision: 3 } });
    expect(replies.find((r) => r.id === 3)).toEqual({ type: "result", id: 3, ok: false, error: "ACTIVITY_CAPABILITY_DENIED" });
  });
});

describe("launch responses", () => {
  it("accepts only Core's own same-origin frame route", () => {
    expect(parseLaunch(run({ execution: "sandboxed_web", frameUrl: "/api/activity-frames/synthetic-sandboxed-activity/1.0.0" })).mode).toBe("run");
    for (const frameUrl of ["https://evil.example/frame", "//evil.example/api/activity-frames/a/1", "/api/activity-frames/a/1?x=1", "javascript:alert(1)", undefined])
      expect(() => parseLaunch(run({ execution: "sandboxed_web", ...(frameUrl ? { frameUrl } : {}) }))).toThrow("INVALID_ACTIVITY");
    expect(() => parseLaunch({ ...run(), grantedCapabilities: "all" })).toThrow();
    expect(parseLaunch({ mode: "fallback", activityId: "a", target: "ios_phone", fallback: { kind: "text_block", ref: "t", objectiveIds: ["o"] } })).toEqual({ mode: "fallback", activityId: "a", fallback: { kind: "text_block", ref: "t" } });
  });
  it("chooses the target from the layout width", () => {
    expect(activityTarget(390)).toBe("web_mobile");
    expect(activityTarget(834)).toBe("web_desktop");
  });
});

function client(launch: ActivityRun, call: ActivityClient["call"]): ActivityClient {
  return { launch: vi.fn(async () => launch), call };
}
describe("activity block", () => {
  it("renders the declarative interpreter, saves state and shows the evaluator's result", async () => {
    const calls: [string, unknown, unknown][] = [];
    const onChanged = vi.fn();
    const call = vi.fn(async (_e: string, _i: string, capability: string, payload: unknown, extra?: unknown) => {
      calls.push([capability, payload, extra]);
      if (capability === "state.patch") return { stateRevision: calls.filter((c) => c[0] === "state.patch").length + 1 };
      return { observationId: "o", evaluation: { status: "passed", explanation: "4 is the smaller value." }, satisfied: true };
    }) as unknown as ActivityClient["call"];
    render(<ActivityBlock client={client(run(), call)} enrollmentId="e" episodeId="min" blockId="min-activity" done={false} onChanged={onChanged} />);
    expect(await screen.findByRole("heading", { name: "Explore the minimum" })).toBeTruthy();
    expect(screen.getByText("Pick the smaller value with the number field.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Submit my value" }));
    expect(await screen.findByText("Answer every part first (2 left).")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Smaller value (0 to 10)"), { target: { value: "4" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "I checked both" }));
    fireEvent.click(screen.getByRole("button", { name: "Submit my value" }));
    expect(await screen.findByText("Checked: done. 4 is the smaller value.")).toBeTruthy();
    expect(onChanged).toHaveBeenCalledTimes(1);
    // Saved once, when submitting, not per keystroke or click.
    const patches = calls.filter((c) => c[0] === "state.patch");
    expect(patches).toEqual([["state.patch", { state: { values: { value: 4, sure: true } } }, { expectedStateRevision: 1 }]]);
    expect(calls.at(-1)).toEqual(["observation.emit", { observation: { kind: "submitted", values: { value: 4, sure: true } } }, undefined]);
  });
  it("frames a sandboxed activity with scripts only, never same-origin access", async () => {
    const call = vi.fn() as unknown as ActivityClient["call"];
    render(<ActivityBlock client={client(run({ execution: "sandboxed_web", frameUrl: "/api/activity-frames/synthetic-sandboxed-activity/1.0.0" }), call)}
      enrollmentId="e" episodeId="min" blockId="min-activity" done={false} onChanged={() => {}} />);
    const frame = await screen.findByTitle("Explore the minimum (interactive activity)");
    expect(ACTIVITY_FRAME_SANDBOX).toBe("allow-scripts");
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("sandbox")).not.toContain("same-origin");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    // Core's frame route, with a fresh per-load nonce in the fragment.
    await waitFor(() => expect(frame.getAttribute("src")).toMatch(/^\/api\/activity-frames\/synthetic-sandboxed-activity\/1\.0\.0#[A-Za-z0-9_-]{24}$/));
  });
});

describe("activity state saves", () => {
  it("waits for a pause in typing and saves only the latest values", async () => {
    const patches: unknown[] = [];
    const call = vi.fn(async (_e: string, _i: string, capability: string, payload: unknown) => {
      if (capability === "state.patch") patches.push(payload);
      return { stateRevision: patches.length + 1 };
    }) as unknown as ActivityClient["call"];
    render(<ActivityBlock client={client(run(), call)} enrollmentId="e" episodeId="min" blockId="min-activity" done={false} onChanged={() => {}} />);
    const field = await screen.findByLabelText("Smaller value (0 to 10)");
    for (const text of ["1", "12", "1", "7"]) fireEvent.change(field, { target: { value: text } });
    expect(patches).toEqual([]);
    await waitFor(() => expect(patches).toHaveLength(1), { timeout: 3000 });
    expect(patches[0]).toEqual({ state: { values: { value: 7, sure: null } } });
  });
});

describe("sandboxed frame handshake", () => {
  it("sends the port once, only to the frame's own window and only after a hello carrying its nonce", async () => {
    const call = vi.fn() as unknown as ActivityClient["call"];
    render(<ActivityBlock client={client(run({ execution: "sandboxed_web", frameUrl: "/api/activity-frames/synthetic-sandboxed-activity/1.0.0" }), call)}
      enrollmentId="e" episodeId="min" blockId="min-activity" done={false} onChanged={() => {}} />);
    const frame = (await screen.findByTitle("Explore the minimum (interactive activity)")) as HTMLIFrameElement;
    await waitFor(() => expect(frame.getAttribute("src")).toContain("#"));
    const nonce = frame.getAttribute("src")!.split("#")[1]!;
    const target = frame.contentWindow!, sent: unknown[] = [];
    vi.spyOn(target, "postMessage").mockImplementation(((message: unknown) => { sent.push(message); }) as never);
    const hello = (data: unknown, source: MessageEventSource | null) => window.dispatchEvent(new MessageEvent("message", { data, source }));
    hello({ type: "course-activity-hello", nonce: "wrong-nonce-wrong-nonce-" }, target);
    hello({ type: "course-activity-hello", nonce }, window);
    hello({ type: "course-activity-hello", nonce }, null);
    expect(sent).toEqual([]);
    hello({ type: "course-activity-hello", nonce }, target);
    hello({ type: "course-activity-hello", nonce }, target);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: "course-activity-init", nonce, context: { grantedCapabilities: ["state.read", "state.patch", "observation.emit"] } });
  });
});

describe("lesson steps", () => {
  it("lists activity steps and keeps the lesson unfinished until the server marks them done", async () => {
    const { lessonSteps } = await import("../src/connected/lessonSteps");
    const episode = { id: "min", title: "Minimum", objectiveIds: ["minimum"], blocks: [
      { id: "t", type: "text", markdown: "x" }, { id: "a", type: "activity", activityId: "min-explore" }] } as never;
    const server = (completed: string[]) => ({ lessons: [{ id: "min", status: "available", completedBlockIds: completed, gate: null }], inaccessibleEpisodeIds: [] }) as never;
    expect(lessonSteps(server(["t"]), episode).map((s) => [s.title, s.status])).toEqual([["Part 1 · Reading", "completed"], ["Activity 1", "current"], ["Finish this lesson", "locked"]]);
    expect(lessonSteps(server([]), episode).map((s) => s.status)).toEqual(["current", "required", "locked"]);
    expect(lessonSteps(server(["t", "a"]), episode).map((s) => s.status)).toEqual(["completed", "completed", "current"]);
  });
});
