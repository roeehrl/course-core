import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { CompanionMessage } from "../src/client/companionClient";
import { companionBridge, resetCompanionBridge } from "../src/connected/companion/bridge";
import { companionOpen } from "../src/connected/companion/openState";
import { SEEN_PREFIX, newestReply, readSeen, unreadReplies, useCompanionActivity } from "../src/connected/companion/unread";

let n = 0;
const enrollment = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
const at = (minute: number) => new Date(Date.UTC(2026, 10, 1, 10, minute)).toISOString();
const question = (id: string, minute: number, over: Partial<CompanionMessage> = {}): CompanionMessage => ({
  id,
  role: "learner",
  content: `Question ${id}`,
  context: { episodeId: "min" },
  created_at: at(minute),
  job_id: `job-${id}`,
  ...over,
});
const reply = (id: string, minute: number, job: string): CompanionMessage => ({
  id,
  role: "assistant",
  content: `Reply ${id}`,
  context: { episodeId: "min" },
  created_at: at(minute),
  job_id: job,
});
const unreadNow = () => {
  const { unread, firstUnreadId, replyAbout } = companionBridge.activity();
  return { unread, firstUnreadId, replyAbout };
};

beforeEach(() => {
  resetCompanionBridge();
  window.localStorage.clear();
  companionOpen.reset();
});
afterEach(() => vi.restoreAllMocks());

describe("unread replies", () => {
  it("counts the replies after the last one this device showed, oldest first, by the check they are about", () => {
    const messages = [
      question("q1", 0, { context: { episodeId: "min", attachedCheck: { challengeId: "c1", ordinal: 1 } } }),
      reply("r1", 1, "job-q1"),
      question("q2", 2, { context: { episodeId: "min", attachedCheck: { challengeId: "c2", ordinal: 2 } } }),
      reply("r2", 3, "job-q2"),
      // A reply without a job id belongs to the question before it.
      question("q3", 4, { job_id: null, context: { episodeId: "min", attachedCheck: { challengeId: "c1", ordinal: 1 } } }),
      reply("r3", 5, "job-unknown"),
    ];
    expect(unreadReplies(messages, "")).toEqual({ unread: 3, firstUnreadId: "r1", replyAbout: { c1: "r3", c2: "r2" } });
    expect(unreadReplies(messages, at(1))).toEqual({ unread: 2, firstUnreadId: "r2", replyAbout: { c1: "r3", c2: "r2" } });
    expect(unreadReplies(messages, at(5))).toEqual({ unread: 0, firstUnreadId: undefined, replyAbout: {} });
    expect(newestReply(messages)).toBe(at(5));
    expect(newestReply([question("q", 0)])).toBe("");
  });

  it("publishes replies that settle while the companion is closed and clears them when it shows", () => {
    const id = enrollment();
    const asked = [question("q1", 0, { context: { episodeId: "min", attachedCheck: { challengeId: "c1", ordinal: 1 } } })];
    const { rerender } = renderHook(({ messages, open }) => useCompanionActivity(messages, open, id), {
      initialProps: { messages: [] as CompanionMessage[], open: false },
    });
    // Before anything is loaded nothing is recorded.
    expect(readSeen(id)).toBeNull();
    rerender({ messages: asked, open: false });
    expect(window.localStorage.getItem(SEEN_PREFIX + id)).toBe("");
    expect(unreadNow()).toEqual({ unread: 0, firstUnreadId: undefined, replyAbout: {} });
    rerender({ messages: [...asked, reply("r1", 1, "job-q1")], open: false });
    expect(unreadNow()).toEqual({ unread: 1, firstUnreadId: "r1", replyAbout: { c1: "r1" } });
    // Opened: seen, and remembered on this device.
    rerender({ messages: [...asked, reply("r1", 1, "job-q1")], open: true });
    expect(unreadNow()).toEqual({ unread: 0, firstUnreadId: undefined, replyAbout: {} });
    expect(window.localStorage.getItem(SEEN_PREFIX + id)).toBe(at(1));
    rerender({ messages: [...asked, reply("r1", 1, "job-q1")], open: false });
    expect(unreadNow().unread).toBe(0);
  });

  it("counts a reply that arrived since this device last showed the conversation, after a reload", () => {
    const id = enrollment();
    window.localStorage.setItem(SEEN_PREFIX + id, at(1));
    const messages = [question("q1", 0), reply("r1", 1, "job-q1"), question("q2", 2), reply("r2", 3, "job-q2")];
    renderHook(() => useCompanionActivity(messages, false, id));
    expect(unreadNow()).toEqual({ unread: 1, firstUnreadId: "r2", replyAbout: {} });
  });

  it("calls nothing new on a device that never showed the conversation", () => {
    const id = enrollment();
    const messages = [question("q1", 0), reply("r1", 1, "job-q1")];
    renderHook(() => useCompanionActivity(messages, false, id));
    expect(unreadNow().unread).toBe(0);
    expect(readSeen(id)).toBe(at(1));
  });

  it("does not count a reply as seen in a hidden tab or the phone's collapsed bar", () => {
    const id = enrollment();
    window.localStorage.setItem(SEEN_PREFIX + id, "");
    const messages = [question("q1", 0), reply("r1", 1, "job-q1")];
    const hidden = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    renderHook(() => useCompanionActivity(messages, true, id));
    expect(unreadNow().unread).toBe(1);
    hidden.mockReturnValue("visible");
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    expect(unreadNow().unread).toBe(0);

    const other = enrollment();
    window.localStorage.setItem(SEEN_PREFIX + other, "");
    act(() => {
      companionOpen.sync({ docked: false, surface: "lesson" });
      companionOpen.setDetent("collapsed");
    });
    renderHook(() => useCompanionActivity(messages, true, other));
    expect(unreadNow().unread).toBe(1);
    act(() => companionOpen.setDetent("half"));
    expect(unreadNow().unread).toBe(0);
  });

  it("keeps working without device storage, and clears the dot when the conversation goes", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const id = enrollment();
    const asked = [question("q1", 0)];
    const { rerender, unmount } = renderHook(({ messages }) => useCompanionActivity(messages, false, id), { initialProps: { messages: asked } });
    rerender({ messages: [...asked, reply("r1", 1, "job-q1")] });
    expect(unreadNow().unread).toBe(1);
    unmount();
    expect(unreadNow()).toEqual({ unread: 0, firstUnreadId: undefined, replyAbout: {} });
  });
});
