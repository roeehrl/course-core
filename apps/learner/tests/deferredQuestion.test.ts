import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deferredQuestion, deferredSendable, useDeferredQuestion } from "../src/connected/credit/deferredQuestion";

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  deferredQuestion.resetMemory();
});

// "Save for after the question" (final design §3.11): the draft set aside per enrollment and
// lesson, kept on the device when it can be, and sendable once its question no longer counts.
describe("a question saved for after the check", () => {
  it("is kept per enrollment and lesson, survives a reload, and is cleared once sent", () => {
    deferredQuestion.save("enrollment-1", "a", "Why is it 2?", ["check-a"], 10);
    expect(deferredQuestion.get("enrollment-1", "a")).toEqual({ text: "Why is it 2?", challengeIds: ["check-a"], savedAt: 10 });
    expect(deferredQuestion.get("enrollment-1", "b")).toBeNull();
    expect(deferredQuestion.get("enrollment-2", "a")).toBeNull();
    // A new page reads it back from the device.
    deferredQuestion.resetMemory();
    expect(deferredQuestion.get("enrollment-1", "a")?.text).toBe("Why is it 2?");
    deferredQuestion.clear("enrollment-1", "a");
    deferredQuestion.resetMemory();
    expect(deferredQuestion.get("enrollment-1", "a")).toBeNull();
  });

  it("keeps a question saved earlier in the lesson, with the new one after it", () => {
    deferredQuestion.save("enrollment-1", "a", "First?", ["check-a"], 10);
    deferredQuestion.save("enrollment-1", "a", "Second?", ["check-a", "check-b"], 20);
    expect(deferredQuestion.get("enrollment-1", "a")).toEqual({ text: "First?\n\nSecond?", challengeIds: ["check-a", "check-b"], savedAt: 20 });
  });

  it("never saves an empty message, and ignores a stored value it cannot read", () => {
    deferredQuestion.save("enrollment-1", "a", "   ", ["check-a"]);
    expect(deferredQuestion.get("enrollment-1", "a")).toBeNull();
    deferredQuestion.resetMemory();
    localStorage.setItem("course:learner-deferred-question:enrollment-1:a", "{not json");
    expect(deferredQuestion.get("enrollment-1", "a")).toBeNull();
  });

  it("stays in memory when the device storage is unavailable", () => {
    vi.stubGlobal("localStorage", {
      getItem() {
        throw new Error("blocked");
      },
      setItem() {
        throw new Error("blocked");
      },
      removeItem() {
        throw new Error("blocked");
      },
    });
    deferredQuestion.save("enrollment-1", "a", "Kept here", ["check-a"]);
    expect(deferredQuestion.get("enrollment-1", "a")?.text).toBe("Kept here");
    deferredQuestion.clear("enrollment-1", "a");
    expect(deferredQuestion.get("enrollment-1", "a")).toBeNull();
  });

  it("is sendable once none of its questions still counts", () => {
    const saved = { text: "Later", challengeIds: ["check-a"], savedAt: 0 };
    expect(deferredSendable(saved, [{ challengeId: "check-a", independentEligible: true }])).toBe(false);
    expect(deferredSendable(saved, [{ challengeId: "check-a", independentEligible: false }])).toBe(true);
    expect(deferredSendable(saved, [{ challengeId: "check-b", independentEligible: true }])).toBe(true);
    expect(deferredSendable(saved, [])).toBe(true);
  });

  it("updates the components that show it", () => {
    const { result } = renderHook(() => useDeferredQuestion("enrollment-1", "a"));
    expect(result.current).toBeNull();
    act(() => deferredQuestion.save("enrollment-1", "a", "Now shown", []));
    expect(result.current?.text).toBe("Now shown");
    act(() => deferredQuestion.clear("enrollment-1", "a"));
    expect(result.current).toBeNull();
  });
});
