import { describe, expect, it } from "vitest";
import { chooseNotice, NOTICE_PRIORITY, type NoticeInput } from "../src/connected/companion/notices";

describe("one notice above the composer, by priority (final design §3.6, G10)", () => {
  it("follows exhausted > paused > not set up > lesson unavailable > outside a lesson > offline > draft conflict > recovered > storage > credit", () => {
    expect(NOTICE_PRIORITY).toEqual(["exhausted", "paused", "notSetUp", "lessonUnavailable", "outsideLesson", "offline", "draftConflict", "recovered", "storage", "closed", "credit"]);
    const all: NoticeInput = {
      exhausted: true, paused: "workspace", notSetUp: true, lessonUnavailable: true, outsideLesson: true, offline: true,
      draftConflict: true, recovered: true, storage: true, closed: { remaining: 2 }, credit: true,
    };
    const order: (keyof NoticeInput)[] = ["exhausted", "paused", "notSetUp", "lessonUnavailable", "outsideLesson", "offline", "draftConflict", "recovered", "storage", "closed"];
    const input: NoticeInput = { ...all };
    for (const key of order) {
      expect(chooseNotice(input).notice?.kind).toBe(key === "paused" ? "paused" : key);
      delete input[key];
    }
    expect(chooseNotice(input)).toEqual({ notice: { kind: "credit" }, creditInMeta: false });
    expect(chooseNotice({})).toEqual({ creditInMeta: false });
  });
  it("moves the credit line to the meta line when a banner takes the slot, and never drops it", () => {
    expect(chooseNotice({ offline: true, credit: true })).toEqual({ notice: { kind: "offline" }, creditInMeta: true });
    expect(chooseNotice({ paused: "daily", credit: true })).toEqual({ notice: { kind: "paused", ceiling: "daily" }, creditInMeta: true });
    expect(chooseNotice({ offline: true })).toEqual({ notice: { kind: "offline" }, creditInMeta: false });
    // When every question is used there is no composer for it to sit under.
    expect(chooseNotice({ exhausted: true, credit: true })).toEqual({ notice: { kind: "exhausted" }, creditInMeta: false });
  });
  it("names the way into a lesson outside one, and a closed course only while questions are left", () => {
    expect(chooseNotice({ outsideLesson: true, next: { episodeId: "e", title: "Minimum" } }).notice).toEqual({ kind: "outsideLesson", next: { episodeId: "e", title: "Minimum" } });
    expect(chooseNotice({ closed: { remaining: 3, used: 7, budget: 10 } }).notice).toEqual({ kind: "closed", remaining: 3, used: 7, budget: 10 });
    expect(chooseNotice({ closed: { remaining: 0 } }).notice).toBeUndefined();
  });
});
