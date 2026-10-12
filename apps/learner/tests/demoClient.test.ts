import { describe, expect, it, vi } from "vitest";
import { context, demo, memoryStorage } from "./helpers";

describe("explicit demo authority", () => {
  it("blocks direct access and wrong answers without unlocking gates", async () => {
    const client = demo();
    await expect(
      client.submitStep({ ...context(), lessonId: "swap", stepId: "read" }),
    ).rejects.toThrow("earlier required");
    await expect(
      client.submitStep({
        ...context(),
        lessonId: "order",
        stepId: "predict",
        answer: "seven-four",
      }),
    ).rejects.toThrow("earlier required");
    await client.submitStep({
      ...context(),
      lessonId: "order",
      stepId: "notice",
    });
    const wrong = await client.submitStep({
      ...context("1"),
      lessonId: "order",
      stepId: "predict",
      answer: "two-seven",
    });
    expect(wrong.feedback.outcome).toBe("retry");
    expect(wrong.snapshot.lessons.order?.completedStepIds).toEqual(["notice"]);
    expect(wrong.snapshot.lessons.swap?.status).toBe("locked");
    expect(wrong.receipt.authority).toBe("demo");
  });
  it("requires every required step, but never requires the optional detour", async () => {
    const client = demo();
    await client.submitStep({
      ...context(),
      lessonId: "order",
      stepId: "notice",
    });
    await client.submitStep({
      ...context("1"),
      lessonId: "order",
      stepId: "predict",
      answer: "seven-four",
    });
    const short = await client.submitStep({
      ...context("2"),
      lessonId: "order",
      stepId: "explain",
      answer: "yes",
    });
    expect(short.feedback.outcome).toBe("retry");
    expect(short.snapshot.lessons.swap?.status).toBe("locked");
    const done = await client.submitStep({
      ...context("3"),
      lessonId: "order",
      stepId: "explain",
      answer: "Compare every pair of neighbors.",
    });
    expect(done.snapshot.lessons.order?.status).toBe("completed");
    expect(done.snapshot.lessons.order?.completedStepIds).not.toContain(
      "equal",
    );
    expect(done.snapshot.lessons.swap?.status).toBe("available");
    expect(done.snapshot.lessons.pass?.status).toBe("locked");
  });
  it("represents placement as an exemption, not fabricated completion", async () => {
    const client = demo();
    const wrong = await client.requestPlacement({
      ...context(),
      answer: "mixed",
    });
    expect(wrong.snapshot.lessons.order?.status).toBe("available");
    const accepted = await client.requestPlacement({
      ...context("1"),
      answer: "ascending",
    });
    expect(accepted.snapshot.lessons.order).toMatchObject({
      status: "placed",
      completedStepIds: [],
    });
    expect(accepted.snapshot.lessons.swap?.status).toBe("available");
  });
  it("deduplicates retries across reload and rejects stale or wrong-version mutations", async () => {
    const storage = memoryStorage();
    const client = demo(storage);
    const request = { ...context(), lessonId: "order", stepId: "notice" };
    const first = await client.submitStep(request);
    const replay = await demo(storage).submitStep(request);
    expect(replay).toEqual(first);
    await expect(
      client.submitStep({
        ...request,
        stepId: "predict",
        answer: "seven-four",
      }),
    ).rejects.toThrow("does not match");
    await expect(
      client.submitStep({
        ...context(),
        lessonId: "order",
        stepId: "predict",
        answer: "seven-four",
      }),
    ).rejects.toThrow("progress has changed");
    await expect(
      client.submitStep({
        ...context("1"),
        courseVersion: "2",
        lessonId: "order",
        stepId: "notice",
      }),
    ).rejects.toThrow("course has changed");
  });
  it("does not mutate progress when persistence fails", async () => {
    const storage = memoryStorage();
    const client = demo(storage);
    const save = vi
      .spyOn(storage, "setItem")
      .mockRejectedValueOnce(new Error("offline"));
    const request = { ...context(), lessonId: "order", stepId: "notice" };
    await expect(client.submitStep(request)).rejects.toThrow("offline");
    expect((await client.load()).revision).toBe("0");
    expect((await client.submitStep(request)).snapshot.revision).toBe("1");
    expect(save).toHaveBeenCalledTimes(2);
  });
  it("validates and persists a profile without granting progression", async () => {
    const storage = memoryStorage();
    const client = demo(storage);
    await expect(
      client.saveProfile({
        ...context(),
        profile: { displayName: " ", goal: "", pace: "steady" },
      }),
    ).rejects.toThrow("name");
    await client.saveProfile({
      ...context(),
      profile: {
        displayName: " Sam ",
        goal: " Learn sorting ",
        pace: "gentle",
      },
    });
    const saved = await demo(storage).load();
    expect(saved.profile).toEqual({
      displayName: "Sam",
      goal: "Learn sorting",
      pace: "gentle",
    });
    expect(saved.lessons.swap?.status).toBe("locked");
  });
});
