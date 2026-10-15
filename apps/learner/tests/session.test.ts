import { describe, expect, it } from "vitest";
import {
  canOpenStep,
  draftKey,
  effectiveLayout,
  restoreSession,
  safeRoute,
} from "../src/domain/session";
import { demoCourse } from "../src/data/demoCourse";
import { context, demo } from "./helpers";

describe("navigation and restoration", () => {
  it("does not restore into locked lessons or skip required steps", async () => {
    const snapshot = await demo().load();
    expect(
      safeRoute(demoCourse, snapshot, {
        screen: "lesson",
        lessonId: "swap",
        stepId: "read",
      }),
    ).toEqual({ screen: "roadmap" });
    expect(
      safeRoute(demoCourse, snapshot, {
        screen: "lesson",
        lessonId: "order",
        stepId: "explain",
      }),
    ).toEqual({ screen: "lesson", lessonId: "order", stepId: "notice" });
    expect(canOpenStep(demoCourse.lessons[0]!, "missing", snapshot)).toBe(
      false,
    );
  });
  it("allows skipping an optional detour and reviewing earlier steps", async () => {
    const client = demo();
    await client.submitStep({
      ...context(),
      lessonId: "order",
      stepId: "notice",
    });
    const { snapshot } = await client.submitStep({
      ...context("1"),
      lessonId: "order",
      stepId: "predict",
      answer: "seven-four",
    });
    expect(canOpenStep(demoCourse.lessons[0]!, "explain", snapshot)).toBe(true);
    expect(canOpenStep(demoCourse.lessons[0]!, "notice", snapshot)).toBe(true);
  });
  it("restores drafts and valid routes, rejects corrupt and obsolete schemas", async () => {
    const snapshot = await demo().load();
    const route = { screen: "lesson", lessonId: "order", stepId: "notice" };
    const restored = restoreSession(
      JSON.stringify({
        schema: 1,
        route,
        drafts: { [draftKey("order", "predict")]: "seven-four", invalid: 55 },
        notes: { roadmap: "Remember neighbors" },
      }),
      demoCourse,
      snapshot,
    );
    expect(restored.route).toEqual(route);
    expect(Object.keys(restored.drafts)).toHaveLength(1);
    expect(restored.notes.roadmap).toBe("Remember neighbors");
    for (const raw of ["not json", '{"schema":99}', "null"])
      expect(restoreSession(raw, demoCourse, snapshot).route.screen).toBe(
        "roadmap",
      );
  });
  it("uses effective width, font scale and height rather than device labels", () => {
    expect(effectiveLayout(1280, 800).companionPane).toBe(true);
    expect(effectiveLayout(1280, 800, 1.6).companionPane).toBe(false);
    expect(effectiveLayout(1280, 800, 1.6).windowClass).toBe("medium");
    expect(effectiveLayout(1280, 450).companionPane).toBe(false);
    expect(effectiveLayout(599, 900).compact).toBe(true);
    expect(effectiveLayout(600, 900).compact).toBe(false);
    expect(effectiveLayout(900, 600).compact).toBe(false);
  });
});
