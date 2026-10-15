import { describe, expect, it, vi } from "vitest";
import {
  createCourseApi,
  CourseApiError,
  type ServerSnapshot,
} from "../src/client/apiClient";

const snapshot = {
  enrollmentId: "enrollment-a",
  revision: 7,
} as ServerSnapshot;
function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}
function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("connected API request boundaries", () => {
  it('admits the fresh-question route but rejects path traversal, encoded separators and empty segments before network I/O',async()=>{
    const fetcher=vi.fn<typeof fetch>().mockResolvedValue(json({revision:8})),api=createCourseApi({fetch:fetcher,pending:storage(),accountId:'one',csrf:()=> 'anti-csrf'});
    await api.command(snapshot,'adaptation/fresh-question',{episodeId:'lesson',mode:'independent'});expect(String(fetcher.mock.calls[0]![0])).toContain('/adaptation/fresh-question');
    for(const action of ['../profile','adaptation//fresh-question','adaptation/%2fprofile','adaptation/../profile','/profile','profile?next=other','reviews/ABC/reply','reviews/a.b/reply','reviews/a_b/reply'])await expect(api.command(snapshot,action,{})).rejects.toMatchObject({code:'INVALID_ACTION'});
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("preserves the exact idempotency key and admitted revision after an uncertain network outcome and reload", async () => {
    const pending = storage();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("transport lost"))
      .mockResolvedValue(json({ revision: 8 }));
    const first = createCourseApi({
      fetch: fetcher,
      pending,
      accountId: "one",
      csrf: () => "anti-csrf",
    });
    await expect(
      first.command(snapshot, "read", { blockId: "block" }),
    ).rejects.toMatchObject({ code: "NETWORK_UNCERTAIN" });
    const reloaded = createCourseApi({
      fetch: fetcher,
      pending,
      accountId: "one",
      csrf: () => "anti-csrf",
    });
    expect(
      await reloaded.command({ ...snapshot, revision: 8 }, "read", {
        blockId: "block",
      }),
    ).toEqual({ revision: 8 });
    const a = JSON.parse(fetcher.mock.calls[0]![1]!.body as string),
      b = JSON.parse(fetcher.mock.calls[1]![1]!.body as string);
    expect(b).toEqual(a);
    expect(b.expectedRevision).toBe(7);
    expect(fetcher.mock.calls[1]![1]).toMatchObject({
      credentials: "same-origin",
      redirect: "error",
      headers: { "X-CSRF-Token": "anti-csrf" },
    });
  });
  it("does not replace an unresolved command with changed semantics", async () => {
    const pending = storage(),
      fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("lost"));
    const api = createCourseApi({ fetch: fetcher, pending, accountId: "one" });
    await expect(
      api.command(snapshot, "answers", { answer: 3 }),
    ).rejects.toBeInstanceOf(CourseApiError);
    await expect(
      api.command(snapshot, "answers", { answer: 9 }),
    ).rejects.toMatchObject({ code: "PENDING_UNCERTAIN" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("keeps pending state isolated by learner account and clears rejected commands", async () => {
    const pending = storage(),
      fetcher = vi
        .fn<typeof fetch>()
        .mockRejectedValueOnce(new Error("lost"))
        .mockResolvedValueOnce(
          json({ error: "STALE_REVISION", secret: "do-not-display" }, 409),
        )
        .mockResolvedValueOnce(json({ revision: 8 }));
    const a = createCourseApi({ fetch: fetcher, pending, accountId: "a" }),
      b = createCourseApi({ fetch: fetcher, pending, accountId: "b" });
    await expect(
      a.command(snapshot, "read", { blockId: "a" }),
    ).rejects.toMatchObject({ code: "NETWORK_UNCERTAIN" });
    await expect(
      b.command(snapshot, "read", { blockId: "b" }),
    ).rejects.toMatchObject({ code: "STALE_REVISION" });
    expect(await b.command(snapshot, "read", { blockId: "c" })).toEqual({
      revision: 8,
    });
    expect(fetcher.mock.calls[1]![1]!.body as string).not.toContain(
      'blockId":"a',
    );
  });
  it("does not display arbitrary error payloads or credentials from a failing service", async () => {
    const api = createCourseApi({
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          json(
            { error: "raw-secret-value", message: "private transcript" },
            500,
          ),
        ),
    });
    try {
      await api.request("/api/workspaces");
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(CourseApiError);
      expect((error as Error).message).not.toMatch(
        /raw-secret|private transcript/,
      );
    }
  });
  it("reconciles an uncertain question issue before loading its active question after reload", async () => {
    const pending = storage(),
      fetcher = vi
        .fn<typeof fetch>()
        .mockRejectedValueOnce(new Error("response lost"))
        .mockResolvedValueOnce(
          json({ challengeId: "already-created", revision: 8 }),
        )
        .mockResolvedValueOnce(
          json({
            revision: 8,
            activeChallenges: [{ challengeId: "already-created" }],
          }),
        );
    const api = createCourseApi({ fetch: fetcher, pending, accountId: "one" });
    await expect(
      api.command(snapshot, "challenges", {
        episodeId: "first",
        mode: "independent",
      }),
    ).rejects.toMatchObject({ code: "NETWORK_UNCERTAIN" });
    const restored = createCourseApi({
      fetch: fetcher,
      pending,
      accountId: "one",
    });
    const loaded = await restored.load(snapshot.enrollmentId);
    expect(loaded.activeChallenges[0]!.challengeId).toBe("already-created");
    expect(fetcher.mock.calls[0]![1]!.body).toBe(
      fetcher.mock.calls[1]![1]!.body,
    );
    expect(fetcher.mock.calls[2]![1]!.method).toBe("GET");
  });
});

it("retains the exact pending command when storage throws and blocks changed semantics", async () => {
  const unavailable = vi.fn();
  const denied = {
    getItem() {
      throw Error("denied");
    },
    setItem() {
      throw Error("quota");
    },
    removeItem() {
      throw Error("denied");
    },
  };
  const fetcher = vi
    .fn<typeof fetch>()
    .mockRejectedValueOnce(new Error("lost"))
    .mockImplementation(async () => json({ revision: 8 }));
  const api = createCourseApi({
    fetch: fetcher,
    pending: denied,
    accountId: "one",
    onStorageUnavailable: unavailable,
  });
  await expect(
    api.command(snapshot, "answers", { answer: 3 }),
  ).rejects.toMatchObject({ code: "NETWORK_UNCERTAIN" });
  await expect(
    api.command(snapshot, "answers", { answer: 4 }),
  ).rejects.toMatchObject({ code: "PENDING_UNCERTAIN" });
  await api.command({ ...snapshot, revision: 8 }, "answers", { answer: 3 });
  expect(fetcher.mock.calls[0]![1]!.body).toBe(fetcher.mock.calls[1]![1]!.body);
  expect(unavailable).toHaveBeenCalledTimes(1);
  await api.command({ ...snapshot, revision: 8 }, "read", { blockId: "next" });
  expect(fetcher).toHaveBeenCalledTimes(3);
});
it("fails closed for a corrupt pending command instead of making a new operation", async () => {
  const pending = storage();
  pending.setItem("course:pending:a:enrollment-a", "{bad");
  const fetcher = vi.fn<typeof fetch>();
  const api = createCourseApi({ fetch: fetcher, pending, accountId: "a" });
  await expect(api.load("enrollment-a")).rejects.toMatchObject({
    code: "PENDING_CORRUPT",
  });
  expect(fetcher).not.toHaveBeenCalled();
});

it("preserves code exactly and the retry key when the sandbox service is unavailable", async () => {
  const pending = storage(),
    source = "def solve(input):\n    return input  # café\n";
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(json({ error: "CODE_EVALUATOR_UNAVAILABLE" }, 503))
    .mockResolvedValueOnce(
      json({
        result: {
          passed: false,
          explanation: "Time limit reached.",
          independent: true,
        },
      }),
    );
  const api = createCourseApi({ fetch: fetcher, pending, accountId: "coder" });
  await expect(
    api.command(snapshot, "answers", { challengeId: "code", answer: source }),
  ).rejects.toMatchObject({ code: "CODE_EVALUATOR_UNAVAILABLE" });
  expect(api.hasPending(snapshot.enrollmentId)).toBe(true);
  await api.command({ ...snapshot, revision: 8 }, "answers", {
    challengeId: "code",
    answer: source,
  });
  expect(fetcher.mock.calls[0]![1]!.body).toBe(fetcher.mock.calls[1]![1]!.body);
  expect(JSON.parse(fetcher.mock.calls[1]![1]!.body as string).answer).toBe(
    source,
  );
  expect(api.hasPending(snapshot.enrollmentId)).toBe(false);
});

describe("leaving the page", () => {
  it("cancels in-flight reads cleanly, sends no new ones, leaves writes alone, and recovers if the page stays", async () => {
    let started: (() => void) | undefined;
    const fetcher = vi.fn<typeof fetch>((_url, init) => {
      if (init?.method !== "GET") return Promise.resolve(json({ revision: 8 }));
      return new Promise((resolve, reject) => {
        started?.();
        init.signal?.addEventListener("abort", () => reject(new DOMException("Load cancelled", "AbortError")));
        if (String(_url).endsWith("/fast")) resolve(json({ ok: true }));
      });
    });
    const api = createCourseApi({ fetch: fetcher, pending: storage(), accountId: "leaving", csrf: () => "anti-csrf" });
    const inFlight = api.request("/api/enrollments/enrollment-a/retention");
    window.dispatchEvent(new Event("beforeunload"));
    // An ordinary cancellation, not a network failure the panels would report.
    await expect(inFlight).rejects.toMatchObject({ name: "AbortError" });
    await expect(api.request("/api/enrollments/enrollment-a/policy")).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    // A write is never cancelled by this; the pending-command record covers it.
    await expect(api.command(snapshot, "read", { episodeId: "intro", blockId: "b" })).resolves.toMatchObject({ revision: 8 });
    // The navigation did not happen (or the page came back): reads work again.
    window.dispatchEvent(new Event("pointerdown"));
    await expect(api.request("/fast")).resolves.toEqual({ ok: true });
    window.dispatchEvent(new Event("beforeunload"));
    window.dispatchEvent(new Event("pageshow"));
    await expect(api.request("/fast")).resolves.toEqual({ ok: true });
  });
  it("keeps the caller's own cancellation working alongside it", async () => {
    const fetcher = vi.fn<typeof fetch>((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Load cancelled", "AbortError")));
    }));
    const api = createCourseApi({ fetch: fetcher, pending: storage(), accountId: "own" });
    const controller = new AbortController();
    const pending = api.request("/slow", "GET", undefined, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});
