import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useLearner } from "../src/hooks/useLearner";
import { createResilientStorage } from "../src/client/storage";
import { demoCourse } from "../src/data/demoCourse";
import type {
  LearnerClient,
  MutationResult,
  RequestContext,
} from "../src/domain/types";
import { demo, memoryStorage } from "./helpers";

describe("client orchestration", () => {
  it("retains answers and the same idempotency key after a failed request", async () => {
    const storage = memoryStorage();
    const client = demo();
    const { result } = renderHook(() =>
      useLearner(demoCourse, client, storage, "learner-a"),
    );
    await waitFor(() => expect(result.current.snapshot).toBeDefined());
    act(() =>
      result.current.setSession((previous) => ({
        ...previous,
        drafts: { answer: "keep me" },
      })),
    );
    const failed = vi
      .fn<(context: RequestContext) => Promise<MutationResult>>()
      .mockRejectedValue(new Error("network failed"));
    await act(async () => {
      await result.current.run("same-answer", failed);
    });
    expect(result.current.session.drafts.answer).toBe("keep me");
    expect(result.current.snapshot?.revision).toBe("0");
    expect(result.current.error).toContain("could not be saved");
    await act(async () => {
      await result.current.run("same-answer", failed);
    });
    expect(failed.mock.calls[1]![0].idempotencyKey).toBe(
      failed.mock.calls[0]![0].idempotencyKey,
    );
  });
  it("blocks duplicate submissions and navigation during an in-flight request", async () => {
    const client = demo();
    const storage = memoryStorage();
    const { result } = renderHook(() =>
      useLearner(demoCourse, client, storage, "learner-a"),
    );
    await waitFor(() => expect(result.current.snapshot).toBeDefined());
    let resolve!: (result: MutationResult) => void;
    const command = vi.fn(
      () =>
        new Promise<MutationResult>((done) => {
          resolve = done;
        }),
    );
    let task!: Promise<MutationResult | undefined>;
    act(() => {
      task = result.current.run("one", command);
    });
    act(() => {
      void result.current.run("two", command);
      result.current.navigate({
        screen: "lesson",
        lessonId: "order",
        stepId: "notice",
      });
    });
    expect(command).toHaveBeenCalledOnce();
    expect(result.current.session.route.screen).toBe("roadmap");
    await act(async () => {
      resolve({
        snapshot: await client.load(),
        feedback: { outcome: "accepted", message: "Acknowledged only." },
        receipt: { id: "example", authority: "server" },
      });
      await task;
    });
    expect(result.current.snapshot?.lessons.swap?.status).toBe("locked");
  });
  it("loads again after a failed load and isolates a different learner and course version", async () => {
    const storage = memoryStorage();
    const initial = await demo().load();
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(initial);
    const client: LearnerClient = { ...demo(), load };
    const { result, rerender } = renderHook(
      ({ learnerKey, course }) =>
        useLearner(course, client, storage, learnerKey),
      { initialProps: { learnerKey: "learner-a", course: demoCourse } },
    );
    await waitFor(() =>
      expect(result.current.error).toContain("could not load"),
    );
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.snapshot).toBeDefined());
    act(() =>
      result.current.setSession((previous) => ({
        ...previous,
        drafts: { personal: "Private to learner A" },
      })),
    );
    rerender({
      learnerKey: "learner-b",
      course: { ...demoCourse, version: "2" },
    });
    await waitFor(() => expect(result.current.session.drafts).toEqual({}));
  });
  it("serializes draft writes so delayed storage cannot overwrite the latest text", async () => {
    const storage = memoryStorage();
    const client = demo();
    const save = vi.spyOn(storage, "setItem");
    const { result } = renderHook(() =>
      useLearner(demoCourse, client, storage, "learner-a"),
    );
    await waitFor(() => expect(result.current.snapshot).toBeDefined());
    await waitFor(() => expect(save).toHaveBeenCalled());
    let release!: () => void;
    save.mockImplementationOnce(
      () =>
        new Promise<void>((done) => {
          release = done;
        }),
    );
    act(() =>
      result.current.setSession((previous) => ({
        ...previous,
        notes: { note: "older" },
      })),
    );
    await waitFor(() => expect(release).toBeDefined());
    const count = save.mock.calls.length;
    act(() =>
      result.current.setSession((previous) => ({
        ...previous,
        notes: { note: "newer" },
      })),
    );
    expect(save).toHaveBeenCalledTimes(count);
    await act(async () => release());
    await waitFor(() => expect(save).toHaveBeenCalledTimes(count + 1));
    expect(JSON.parse(save.mock.calls.at(-1)![1]).notes.note).toBe("newer");
  });
  it("keeps a memory fallback and warns once when device storage is denied", async () => {
    const warning = vi.fn();
    const primary = {
      getItem: vi.fn().mockRejectedValue(new Error("denied")),
      setItem: vi.fn().mockRejectedValue(new Error("denied")),
    };
    const storage = createResilientStorage(primary, warning);
    expect(await storage.getItem("key")).toBeNull();
    await storage.setItem("key", "draft");
    expect(await storage.getItem("key")).toBe("draft");
    expect(warning).toHaveBeenCalledOnce();
  });
});
