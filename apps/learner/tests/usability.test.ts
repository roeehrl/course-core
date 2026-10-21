// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { classifyClick, createUsabilityRecorder, type UsabilityTrial } from "../src/connected/usability";

function harness(reply: () => Promise<"ok" | "off"> = async () => "ok") {
  let clock = 0,
    ids = 0;
  const sent: { batchId: string; trials: UsabilityTrial[] }[] = [];
  const recorder = createUsabilityRecorder({
    now: () => clock,
    newId: () => `batch-${++ids}`,
    deviceClass: () => "phone",
    send: async (batchId, trials) => {
      sent.push({ batchId, trials });
      return reply();
    },
  });
  return { recorder, sent, advance: (ms: number) => (clock += ms) };
}

describe("usability timings (P15)", () => {
  it("times the course page to its required step and counts other controls used first as wrong turns", async () => {
    const { recorder, sent, advance } = harness();
    recorder.shown("course_page", "course");
    advance(1500);
    recorder.action("other");
    advance(2500);
    recorder.action("next");
    // The required step led into a lesson: the next trial starts there, not on the course page.
    advance(50);
    recorder.shown("lesson", "lesson-a");
    advance(3000);
    recorder.action("next");
    await recorder.flush();
    expect(sent[0]!.trials).toEqual([
      { kind: "next_action", place: "course_page", deviceClass: "phone", outcome: "reached", elapsedMs: 4000, wrongTurns: 1, contextKept: null },
      { kind: "next_action", place: "lesson", deviceClass: "phone", outcome: "reached", elapsedMs: 3000, wrongTurns: 0, contextKept: null },
    ]);
  });

  it("keeps counting across navigation until the required step, and does not count help as a wrong turn", async () => {
    const { recorder, sent, advance } = harness();
    recorder.shown("lesson", "lesson-a");
    recorder.action("other");
    recorder.shown("course_page", "course");
    recorder.action("other");
    recorder.shown("lesson", "lesson-a");
    advance(9000);
    recorder.action("next");
    await recorder.flush();
    expect(sent[0]!.trials[0]).toMatchObject({ place: "lesson", wrongTurns: 2, elapsedMs: 9000 });
  });

  it("times a detour and notes whether the learner came back to the same lesson", async () => {
    const { recorder, sent, advance } = harness();
    recorder.shown("lesson", "lesson-a");
    recorder.action("detour");
    advance(20_000);
    recorder.shown("lesson", "lesson-a");
    advance(1000);
    recorder.action("next");
    recorder.action("detour");
    advance(5000);
    recorder.shown("lesson", "lesson-b");
    // A companion beside the lesson: the detour ends at the next control used outside it.
    recorder.action("detour");
    advance(3000);
    recorder.action("other");
    await recorder.flush();
    expect(sent[0]!.trials.map((t) => [t.kind, t.place, t.elapsedMs, t.contextKept])).toEqual([
      ["detour_return", "lesson", 20_000, true],
      ["next_action", "after_detour", 1000, null],
      ["detour_return", "lesson", 5000, false],
      ["detour_return", "lesson", 3000, true],
    ]);
  });

  it("ends open trials as abandoned when the learner leaves the app, and restarts timing on return", async () => {
    const { recorder, sent, advance } = harness();
    recorder.shown("check", "lesson-a");
    advance(7000);
    recorder.action("detour");
    advance(1000);
    await recorder.hidden();
    expect(sent[0]!.trials.map((t) => [t.kind, t.outcome, t.contextKept])).toEqual([["next_action", "abandoned", null], ["detour_return", "abandoned", false]]);
    recorder.visible();
    advance(2000);
    recorder.action("next");
    await recorder.flush();
    expect(sent[1]!.trials[0]).toMatchObject({ place: "check", outcome: "reached", elapsedMs: 2000 });
  });

  it("sends in batches, retries a failed batch once under the same id, and stops when the server says it is off", async () => {
    let calls = 0;
    const { recorder, sent } = harness(async () => {
      calls++;
      if (calls === 1) throw new Error("network");
      return calls >= 3 ? "off" : "ok";
    });
    recorder.shown("lesson", "a");
    for (let i = 0; i < 10; i++) recorder.action("next");
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(sent.map((s) => s.batchId)).toEqual(["batch-1", "batch-1"]);
    expect(sent[0]!.trials).toHaveLength(10);
    recorder.action("next");
    await recorder.flush();
    expect(sent).toHaveLength(3);
    // Off: nothing more is recorded or sent.
    recorder.action("next");
    await recorder.flush();
    expect(sent).toHaveLength(3);
    expect(recorder.pending()).toEqual([]);
  });

  it("classifies clicks: marked required steps and detours, other controls, and ignored regions", () => {
    document.body.innerHTML = `
      <div data-usability="next" role="button"><span id="next">Continue</span></div>
      <button data-usability="detour" id="help">Companion</button>
      <aside data-usability="ignore"><button id="send">Send</button></aside>
      <nav data-usability="detour"><button id="menu">Your course</button></nav>
      <button id="other">All courses</button>
      <label><input type="radio" id="radio"></label>
      <p id="text">Text</p>`;
    const at = (id: string) => classifyClick(document.getElementById(id));
    expect([at("next"), at("help"), at("send"), at("menu"), at("other"), at("radio"), at("text")]).toEqual(["next", "detour", null, "detour", "other", null, null]);
    expect(classifyClick(null)).toBeNull();
  });
});
