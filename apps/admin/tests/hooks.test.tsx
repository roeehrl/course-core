import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useRemote, useWorkspace } from "../src/hooks/useAdmin";
import { useEditableSnapshot } from "../src/hooks/useEditableSnapshot";
import type {
  CourseWorkspace,
  MutationContext,
  MutationResult,
} from "../src/domain/contracts";
import { demo } from "./helpers";

describe("async administration state", () => {
  it("reuses an idempotency key after a failed save without optimistic progress", async () => {
    const client = demo();
    const { result } = renderHook(() => useWorkspace(client, "sorting"));
    await waitFor(() => expect(result.current.workspace).toBeDefined());
    const revision = result.current.workspace!.revision;
    const command = vi
      .fn<(ctx: MutationContext) => Promise<MutationResult>>()
      .mockRejectedValue(new Error("connection lost"));
    await act(async () => {
      await result.current.run("same-change", command);
    });
    expect(result.current.workspace!.revision).toBe(revision);
    expect(result.current.error).toBeDefined();
    await act(async () => {
      await result.current.run("same-change", command);
    });
    expect(command.mock.calls[0]![0].idempotencyKey).toBe(
      command.mock.calls[1]![0].idempotencyKey,
    );
  });
  it("suppresses a repeated mutation while the first is pending", async () => {
    const client = demo();
    const { result } = renderHook(() => useWorkspace(client, "sorting"));
    await waitFor(() => expect(result.current.workspace).toBeDefined());
    let finish!: (response: MutationResult) => void;
    const command = vi.fn(
      () =>
        new Promise<MutationResult>((resolve) => {
          finish = resolve;
        }),
    );
    let task!: Promise<MutationResult | undefined>;
    act(() => {
      task = result.current.run("one", command);
    });
    await act(async () => {
      await result.current.run("one", command);
    });
    expect(command).toHaveBeenCalledOnce();
    expect(result.current.pending).toBe(true);
    await act(async () => {
      finish({
        workspace: await client.getCourse("sorting"),
        receipt: { id: "demo-receipt", authority: "demo", outcome: "saved" },
        message: "Recorded.",
      });
      await task;
    });
    expect(result.current.pending).toBe(false);
  });
  it("ignores old read responses after changing the course", async () => {
    const client = demo();
    let finish!: (workspace: CourseWorkspace) => void;
    const { result, rerender } = renderHook(
      ({ course }) =>
        useRemote(
          (signal) =>
            course === "sorting"
              ? new Promise<CourseWorkspace>((resolve) => {
                  finish = resolve;
                })
              : client.getCourse(course, signal),
          [course],
        ),
      { initialProps: { course: "sorting" } },
    );
    rerender({ course: "graphs" });
    await waitFor(() => expect(result.current.data?.course.id).toBe("graphs"));
    await act(async () => finish(await client.getCourse("sorting")));
    expect(result.current.data?.course.id).toBe("graphs");
  });
});

describe("editable snapshot", () => {
  const mount = (saved: { limit: string }) =>
    renderHook(({ saved }) => useEditableSnapshot(saved), {
      initialProps: { saved },
    });
  it("shows the saved values until edited, then never lets a reload overwrite the edit", () => {
    const hook = mount({ limit: "2" });
    hook.rerender({ saved: { limit: "3" } });
    expect(hook.result.current.value).toEqual({ limit: "3" });
    expect(hook.result.current.edited).toBe(false);
    act(() => hook.result.current.set({ limit: "30" }));
    // A reload with the same saved values is not a change made elsewhere.
    hook.rerender({ saved: { limit: "3" } });
    expect(hook.result.current.value).toEqual({ limit: "30" });
    expect(hook.result.current.changedElsewhere).toBe(false);
    hook.rerender({ saved: { limit: "5" } });
    expect(hook.result.current.value).toEqual({ limit: "30" });
    expect(hook.result.current.changedElsewhere).toBe(true);
  });
  it("keeps the edit over the newer version, or drops it to show the saved one", () => {
    const hook = mount({ limit: "2" });
    act(() =>
      hook.result.current.set((current) => ({ ...current, limit: "9" })),
    );
    hook.rerender({ saved: { limit: "5" } });
    act(() => hook.result.current.keep());
    expect(hook.result.current.changedElsewhere).toBe(false);
    expect(hook.result.current.value).toEqual({ limit: "9" });
    hook.rerender({ saved: { limit: "6" } });
    expect(hook.result.current.changedElsewhere).toBe(true);
    act(() => hook.result.current.discard());
    expect(hook.result.current.value).toEqual({ limit: "6" });
    expect(hook.result.current.edited).toBe(false);
  });
  it("after a save, keeps the edit on screen until the reloaded values replace it", () => {
    const hook = mount({ limit: "2" });
    act(() => hook.result.current.set({ limit: "30" }));
    act(() => hook.result.current.settle());
    expect(hook.result.current.value).toEqual({ limit: "30" });
    expect(hook.result.current.changedElsewhere).toBe(false);
    hook.rerender({ saved: { limit: "30.00" } });
    expect(hook.result.current.value).toEqual({ limit: "30.00" });
    expect(hook.result.current.edited).toBe(false);
    // The next edit starts from the reloaded values.
    act(() => hook.result.current.set((current) => ({ ...current })));
    expect(hook.result.current.value).toEqual({ limit: "30.00" });
  });
  it("names the saved version by the key given, so suggestions are not a change elsewhere", () => {
    const hook = renderHook(
      ({ shown, key }) => useEditableSnapshot(shown, key),
      { initialProps: { shown: "suggested-a", key: "revision-1" } },
    );
    act(() => hook.result.current.set("picked"));
    hook.rerender({ shown: "suggested-b", key: "revision-1" });
    expect(hook.result.current.changedElsewhere).toBe(false);
    hook.rerender({ shown: "suggested-b", key: "revision-2" });
    expect(hook.result.current.changedElsewhere).toBe(true);
    expect(hook.result.current.value).toBe("picked");
  });
});
