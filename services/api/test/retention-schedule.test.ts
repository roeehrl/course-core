import { describe, expect, it } from "vitest";
import { nextSchedule, onAvailableDay, validTimeZone } from "../src/retention.js";

const I = [1, 3, 7, 21];
describe("graded review schedule (F06)", () => {
  it("moves one step per independent success, with the gap to the next interval", () => {
    expect(nextSchedule({ step: 0, lapses: 0, needsReview: false }, "retained", I)).toEqual({ step: 1, lapses: 0, needsReview: false, offsetDays: 2 });
    expect(nextSchedule({ step: 2, lapses: 0, needsReview: false }, "retained", I)).toEqual({ step: 3, lapses: 0, needsReview: false, offsetDays: 14 });
    // Past the last interval nothing more is scheduled.
    expect(nextSchedule({ step: 3, lapses: 0, needsReview: false }, "retained", I)).toMatchObject({ step: 4, offsetDays: null });
    // A success clears a review and the miss count.
    expect(nextSchedule({ step: 1, lapses: 1, needsReview: true }, "retained", I)).toMatchObject({ step: 2, lapses: 0, needsReview: false });
  });
  it("steps back one interval on a miss, and restarts only on a second miss in a row", () => {
    expect(nextSchedule({ step: 3, lapses: 0, needsReview: false }, "missed", I)).toEqual({ step: 2, lapses: 1, needsReview: true, offsetDays: 7 });
    expect(nextSchedule({ step: 2, lapses: 1, needsReview: true }, "missed", I)).toEqual({ step: 0, lapses: 2, needsReview: true, offsetDays: 1 });
    expect(nextSchedule({ step: 0, lapses: 0, needsReview: false }, "missed", I)).toEqual({ step: 0, lapses: 1, needsReview: true, offsetDays: 1 });
  });
  it("never punishes \"I don't know yet\" or help: no step lost, a check soon", () => {
    expect(nextSchedule({ step: 2, lapses: 0, needsReview: false }, "unsure", I)).toEqual({ step: 2, lapses: 0, needsReview: true, offsetDays: 1 });
    expect(nextSchedule({ step: 2, lapses: 1, needsReview: true }, "assisted", I)).toEqual({ step: 2, lapses: 1, needsReview: true, offsetDays: 1 });
    expect(nextSchedule({ step: 2, lapses: 0, needsReview: false }, "assisted", I)).toMatchObject({ needsReview: false });
  });
  it("uses the author's intervals, including flat ones", () => {
    expect(nextSchedule({ step: 0, lapses: 0, needsReview: false }, "retained", [2, 2, 5])).toMatchObject({ step: 1, offsetDays: 2 });
  });
});

describe("study days (F06)", () => {
  // 2026-10-21 is a Wednesday.
  const wednesday = new Date("2026-10-21T15:30:00Z");
  const day = (...days: number[]) => days.reduce((mask, d) => mask | (1 << d), 0);
  it("keeps a due time that falls on a study day, and any time without a setting", () => {
    expect(onAvailableDay(wednesday, null)).toEqual(wednesday);
    expect(onAvailableDay(wednesday, { weekdayMask: day(3), timeZone: "UTC" })).toEqual(wednesday);
  });
  it("moves to the start of the next study day in the learner's time zone, never earlier", () => {
    expect(onAvailableDay(wednesday, { weekdayMask: day(0), timeZone: "UTC" }).toISOString()).toBe("2026-10-25T00:00:00.000Z");
    // Jerusalem is UTC+3 on this date: Thursday 00:00 local is Wednesday 21:00 UTC.
    expect(onAvailableDay(wednesday, { weekdayMask: day(4), timeZone: "Asia/Jerusalem" }).toISOString()).toBe("2026-10-21T21:00:00.000Z");
    // Late Wednesday in New York is already Thursday in Tokyo, a study day there.
    const late = new Date("2026-10-22T02:00:00Z");
    expect(onAvailableDay(late, { weekdayMask: day(4), timeZone: "Asia/Tokyo" })).toEqual(late);
    for (const zone of ["UTC", "Asia/Jerusalem", "America/New_York", "Pacific/Auckland"])
      for (let d = 0; d < 7; d++) expect(onAvailableDay(wednesday, { weekdayMask: day(d), timeZone: zone }).getTime()).toBeGreaterThanOrEqual(wednesday.getTime());
  });
  it("crosses a daylight-saving change to local midnight", () => {
    // Europe/London leaves summer time on 2026-10-25; Monday 26 October starts at 00:00 UTC.
    expect(onAvailableDay(new Date("2026-10-24T12:00:00Z"), { weekdayMask: day(1), timeZone: "Europe/London" }).toISOString()).toBe("2026-10-26T00:00:00.000Z");
  });
  it("accepts only real time zones", () => {
    expect(validTimeZone("Asia/Jerusalem")).toBe(true);
    expect(validTimeZone("Mars/Base")).toBe(false);
  });
});
