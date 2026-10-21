import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createConnectedDraftStore } from "../src/connected/drafts";
import { createCourseApi, type ServerSnapshot } from "../src/client/apiClient";
import {
  ConnectionStatus,
  DraftConflict,
  pendingActionName,
  SLOW_REQUEST_MS,
  usePageReturn,
  useSlow,
} from "../src/connected/connectivity.web";

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}
const KEY = "course:learner-drafts:acct";
const stored = (storage: ReturnType<typeof memoryStorage>) =>
  JSON.parse(storage.data.get(KEY)!);
const tick = () =>
  window.dispatchEvent(new StorageEvent("storage", { key: KEY }));

describe("versioned drafts", () => {
  it("stores {value, updatedAt, deviceId} and reads drafts saved before versions existed", () => {
    const storage = memoryStorage();
    storage.setItem(KEY, JSON.stringify({ old: "from an earlier release" }));
    const tab = createConnectedDraftStore("acct", storage, "device-a/tab-1");
    expect(tab.read("old")).toBe("from an earlier release");
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    tab.write("answer", "mine");
    vi.restoreAllMocks();
    expect(stored(storage).answer).toMatchObject({
      value: "mine",
      updatedAt: 1_000,
      deviceId: "device-a/tab-1",
    });
    expect(stored(storage).old).toEqual({
      value: "from an earlier release",
      updatedAt: 0,
      deviceId: "earlier",
    });
    expect(
      createConnectedDraftStore("acct", storage, "other").read("old"),
    ).toBe("from an earlier release");
  });
  it("a continuation from the version another tab saved is not a conflict", () => {
    const storage = memoryStorage();
    const a = createConnectedDraftStore("acct", storage, "a"),
      b = createConnectedDraftStore("acct", storage, "b");
    const stopA = a.subscribe(() => {}),
      stopB = b.subscribe(() => {});
    a.write("answer", "first");
    tick();
    b.write("answer", "first, then more");
    tick();
    a.write("answer", "first, then more, and more");
    expect(a.conflict("answer")).toBeUndefined();
    expect(createConnectedDraftStore("acct", storage, "c").read("answer")).toBe(
      "first, then more, and more",
    );
    stopA();
    stopB();
  });
  it("keeps both versions when two tabs edit the same draft from the same start, until the learner chooses", () => {
    const storage = memoryStorage();
    const a = createConnectedDraftStore("acct", storage, "a"),
      b = createConnectedDraftStore("acct", storage, "b");
    a.write("answer", "shared start");
    const stopB = b.subscribe(() => {});
    tick();
    stopB();
    // Both edit from "shared start"; b has not seen a's edit when it saves.
    a.write("answer", "edited in tab A");
    b.write("answer", "edited in tab B");
    expect(b.read("answer")).toBe("edited in tab B");
    expect(b.conflict("answer")?.value).toBe("edited in tab A");
    expect(b.conflict("answer")?.deviceId).toBe("a");
    // Both survive a reload of either tab.
    const reloaded = createConnectedDraftStore("acct", storage, "c");
    expect(reloaded.read("answer")).toBe("edited in tab B");
    expect(reloaded.conflict("answer")?.value).toBe("edited in tab A");
    // Tab A hears about B's write and keeps its own text shown, with B's beside it.
    const stopA = a.subscribe(() => {});
    tick();
    expect(a.read("answer")).toBe("edited in tab A");
    expect(a.conflict("answer")?.value).toBe("edited in tab B");
    // Further typing keeps the other version until a choice is made.
    a.write("answer", "edited in tab A, more");
    expect(a.conflict("answer")?.value).toBe("edited in tab B");
    a.resolve("answer", "other");
    expect(a.read("answer")).toBe("edited in tab B");
    expect(a.conflict("answer")).toBeUndefined();
    const stopB2 = b.subscribe(() => {});
    tick();
    // The explicit choice settles the other tab as well.
    expect(b.read("answer")).toBe("edited in tab B");
    expect(b.conflict("answer")).toBeUndefined();
    stopA();
    stopB2();
  });
  it("keeping the shown version discards the other only on request", () => {
    const storage = memoryStorage();
    const a = createConnectedDraftStore("acct", storage, "a"),
      b = createConnectedDraftStore("acct", storage, "b");
    a.write("message", "from A");
    b.write("message", "from B");
    expect(b.conflict("message")?.value).toBe("from A");
    b.resolve("message", "shown");
    expect(b.read("message")).toBe("from B");
    expect(
      createConnectedDraftStore("acct", storage, "c").conflict("message"),
    ).toBeUndefined();
  });
});

describe("saved requests survive a closed tab", () => {
  const snapshot = {
    enrollmentId: "enrollment-a",
    revision: 3,
  } as ServerSnapshot;
  const json = (value: unknown) =>
    new Response(JSON.stringify(value), {
      headers: { "Content-Type": "application/json" },
    });
  it("a new page sends the saved request once with its original key, and other tabs see it", async () => {
    const storage = memoryStorage();
    const sent: string[] = [];
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      if (init?.method === "POST") {
        sent.push(JSON.parse(String(init.body)).idempotencyKey);
        if (sent.length === 1) throw new Error("offline");
        return json({ result: { passed: true } });
      }
      return json({ ...snapshot, revision: 4 });
    });
    const first = createCourseApi({
      fetch: fetcher,
      pending: storage,
      accountId: "one",
      csrf: () => "t",
    });
    await expect(
      first.command(snapshot, "answers", { challengeId: "c", answer: "2" }),
    ).rejects.toMatchObject({
      code: "NETWORK_UNCERTAIN",
    });
    expect(first.pendingAction("enrollment-a")).toBe("answers");
    // Another tab of the same account sees the waiting request and does not start a different one.
    const otherTab = createCourseApi({
      fetch: fetcher,
      pending: storage,
      accountId: "one",
      csrf: () => "t",
    });
    expect(otherTab.hasPending("enrollment-a")).toBe(true);
    await expect(
      otherTab.command(snapshot, "read", { blockId: "b" }),
    ).rejects.toMatchObject({ code: "PENDING_UNCERTAIN" });
    // The tab is closed; a new page loads progress and resolves the saved request.
    const reopened = createCourseApi({
      fetch: fetcher,
      pending: storage,
      accountId: "one",
      csrf: () => "t",
    });
    await reopened.load("enrollment-a");
    expect(sent).toHaveLength(2);
    expect(sent[1]).toBe(sent[0]);
    expect(reopened.takeRecovered("enrollment-a")?.action).toBe("answers");
    expect(reopened.pendingAction("enrollment-a")).toBeNull();
    // The first tab learns from shared storage that nothing is waiting any more.
    expect(first.hasPending("enrollment-a")).toBe(false);
    await reopened.load("enrollment-a");
    expect(sent).toHaveLength(2);
  });
});

describe("connection status", () => {
  it("says offline and that a saved request is not recorded yet, and offers to send it when online", () => {
    const retry = vi.fn();
    const { rerender } = render(
      <ConnectionStatus
        online={false}
        pendingAction="answers"
        pending={false}
        onRetry={retry}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("You’re offline.");
    expect(screen.getByRole("status")).toHaveTextContent(
      "Not recorded yet: your answer is saved on this device and is sent when you reconnect.",
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    rerender(
      <ConnectionStatus
        online
        pendingAction="answers"
        pending={false}
        onRetry={retry}
      />,
    );
    expect(screen.getByRole("status")).not.toHaveTextContent("offline");
    fireEvent.click(
      screen.getByRole("button", { name: "Send saved request now" }),
    );
    expect(retry).toHaveBeenCalledOnce();
    rerender(
      <ConnectionStatus
        online
        pendingAction={null}
        pending={false}
        onRetry={retry}
      />,
    );
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(pendingActionName("reviews/abc/reply")).toBe(
      "your reply to the reviewer",
    );
    expect(pendingActionName("unknown")).toBe("your last change");
  });
  it("offers both draft versions with plain choices", () => {
    const keep = vi.fn(),
      use = vi.fn();
    render(
      <DraftConflict
        label="Your answer"
        shown={{ value: "mine", updatedAt: 2, deviceId: "a" }}
        other={{ value: "theirs", updatedAt: 1, deviceId: "b" }}
        onKeepShown={keep}
        onUseOther={use}
      />,
    );
    expect(
      screen.getByRole("region", { name: "Two versions of Your answer" }),
    ).toBeVisible();
    expect(screen.getByText("theirs")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Use the other version" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Keep the version shown here" }),
    );
    expect(use).toHaveBeenCalledOnce();
    expect(keep).toHaveBeenCalledOnce();
  });
  it("reports a return to a hidden page with how long it was away", () => {
    const onReturn = vi.fn();
    function Probe() {
      usePageReturn(onReturn);
      return null;
    }
    render(<Probe />);
    const state = vi.spyOn(document, "visibilityState", "get");
    state.mockReturnValue("hidden");
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    state.mockReturnValue("visible");
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    expect(onReturn).toHaveBeenCalledOnce();
    expect(onReturn.mock.calls[0]![0]).toBeGreaterThanOrEqual(0);
    state.mockRestore();
  });
});

describe("slow network (I06)", () => {
  it("says the server is slow once a request has run for a while, and stops when it ends", () => {
    vi.useFakeTimers();
    try {
      function Host({ busy }: { busy: boolean }) {
        return (
          <ConnectionStatus
            online
            pendingAction={null}
            pending={busy}
            slow={useSlow(busy)}
            onRetry={() => undefined}
          />
        );
      }
      const { rerender } = render(<Host busy />);
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
      act(() => vi.advanceTimersByTime(SLOW_REQUEST_MS));
      expect(screen.getByRole("status")).toHaveTextContent(
        "The server is slow to answer. Keep this page open",
      );
      expect(screen.queryByRole("button")).not.toBeInTheDocument();
      rerender(<Host busy={false} />);
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
      // A new request starts the wait again from zero.
      rerender(<Host busy />);
      act(() => vi.advanceTimersByTime(SLOW_REQUEST_MS - 1));
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
  it("a read that never answers fails with READ_TIMEOUT and a clear message; writes have no client timeout", async () => {
    vi.useFakeTimers();
    try {
      const hung = vi.fn<typeof fetch>(
        (_url, init) =>
          new Promise((_resolve, reject) =>
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            ),
          ),
      );
      const api = createCourseApi({ fetch: hung, readTimeoutMs: 1000, csrf: () => "c" });
      const read = api.request("/api/enrollments").catch((error) => error);
      await vi.advanceTimersByTimeAsync(1000);
      const error = await read;
      expect(error).toMatchObject({ code: "READ_TIMEOUT" });
      expect(error.message).toBe(
        "The server took too long to answer. Nothing was changed; check your connection and try again.",
      );
      let settled = false;
      void api.request("/api/profile", "POST", {}).finally(() => (settled = true));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(settled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
