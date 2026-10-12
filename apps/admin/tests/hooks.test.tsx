import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useRemote, useWorkspace } from "../src/hooks/useAdmin";
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
