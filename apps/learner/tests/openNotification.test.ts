import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { companionBridge, lessonNavigator, resetCompanionBridge, type ComposeRequest, type LessonTarget } from "../src/connected/companion/bridge";
import { companionOpen } from "../src/connected/companion/openState";
import { openNotificationTarget, type NotificationHost } from "../src/connected/notifications/openNotification";
import { connectedSnapshot } from "./connectedFixtures";

const ENROLLMENT = "00000000-0000-4000-8000-0000000000e1",
  REPLY = "00000000-0000-4000-8000-0000000000a2";

function host(over: Partial<NotificationHost> = {}) {
  const server = connectedSnapshot();
  const calls: string[] = [];
  const value: NotificationHost = {
    transact: async (action) => action(),
    refresh: vi.fn(async (id: string) => {
      calls.push(`refresh:${id}`);
      return server;
    }),
    setPreview: vi.fn(),
    setEpisodeId: vi.fn((id) => void calls.push(`episode:${id ?? "none"}`)),
    setPlacement: vi.fn(),
    setView: vi.fn((view) => void calls.push(`view:${view}`)),
    openEpisode: vi.fn((id) => void calls.push(`open:${id}`)),
    companionOpen,
    ...over,
  };
  return { host: value, calls, server };
}
/** Lets the transaction settle and the two frames after it run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 80));
let composed: ComposeRequest[] = [];
let coarse = false;

beforeEach(() => {
  resetCompanionBridge();
  window.localStorage.clear();
  companionOpen.reset();
  composed = [];
  coarse = false;
  companionBridge.onCompose((request) => void composed.push(request));
  window.matchMedia = ((query: string) =>
    ({ matches: query === "(pointer: coarse)" ? coarse : false, media: query, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList);
});
afterEach(() => {
  vi.restoreAllMocks();
  delete (window as { matchMedia?: unknown }).matchMedia;
});

describe("opening a notification", () => {
  it("takes a reply to its lesson, shows the part it was about and opens the companion at the reply", async () => {
    const { host: page, calls } = host();
    const shown: LessonTarget[] = [];
    // The host's layout: beside the page, on the course page. The lesson is still mounting: the
    // target waits for it.
    companionOpen.sync({ docked: true, surface: "course" });
    expect(companionOpen.get().open).toBe(false);
    openNotificationTarget({ enrollmentId: ENROLLMENT, companion: true, episodeId: "intro", blockId: "reading", replyMessageId: REPLY }, page);
    await settle();
    expect(calls).toEqual([`refresh:${ENROLLMENT}`, "open:intro"]);
    lessonNavigator.register((target) => (shown.push(target), true));
    expect(shown).toEqual([{ episodeId: "intro", blockId: "reading" }]);
    // The pane of the lesson, not the course page's.
    companionOpen.sync({ docked: true, surface: "lesson" });
    expect(companionOpen.get().open).toBe(true);
    // A fine pointer: the message box takes focus.
    expect(composed).toEqual([{ source: "notification", focus: true, revealMessageId: REPLY }]);
  });

  it("goes back beside the lesson from focus view before it shows the part, so the lesson is on screen", async () => {
    const { host: page } = host();
    const shown: { target: LessonTarget; view: string }[] = [];
    // The lesson is mounted already and the learner left the companion in focus view.
    companionOpen.sync({ docked: true, surface: "lesson" });
    companionOpen.open("trigger");
    companionOpen.setView("focus");
    expect(companionOpen.get().view).toBe("focus");
    lessonNavigator.register((target) => (shown.push({ target, view: companionOpen.get().view }), true));
    openNotificationTarget({ enrollmentId: ENROLLMENT, companion: true, episodeId: "intro", blockId: "reading", replyMessageId: REPLY }, page);
    await settle();
    expect(companionOpen.get()).toMatchObject({ open: true, view: "docked" });
    // Shown once, after the lesson came back: never into the hidden lesson.
    expect(shown).toEqual([{ target: { episodeId: "intro", blockId: "reading" }, view: "docked" }]);
  });

  it("keeps a touch keyboard down", async () => {
    coarse = true;
    const { host: page } = host();
    openNotificationTarget({ enrollmentId: ENROLLMENT, companion: true, episodeId: "intro", replyMessageId: REPLY }, page);
    await settle();
    expect(composed).toEqual([{ source: "notification", focus: false, revealMessageId: REPLY }]);
  });

  it("opens the course page with the companion when the lesson left the course or is closed", async () => {
    for (const target of [
      { enrollmentId: ENROLLMENT, companion: true, replyMessageId: REPLY, lessonGone: true },
      { enrollmentId: ENROLLMENT, companion: true, episodeId: "removed-lesson", replyMessageId: REPLY },
    ]) {
      composed = [];
      companionOpen.reset();
      companionOpen.sync({ docked: true, surface: "lesson" });
      const { host: page, calls } = host();
      openNotificationTarget(target, page);
      await settle();
      expect(calls).toEqual([`refresh:${ENROLLMENT}`, "episode:none", "view:learn"]);
      expect(page.openEpisode).not.toHaveBeenCalled();
      companionOpen.sync({ docked: true, surface: "course" });
      expect(companionOpen.get().open).toBe(true);
      expect(composed).toEqual([{ source: "notification", focus: true, revealMessageId: REPLY }]);
    }
    // A lesson the learner's policy closed is not opened either.
    const { host: page, server } = host();
    server.inaccessibleEpisodeIds = ["intro"];
    openNotificationTarget({ enrollmentId: ENROLLMENT, companion: true, episodeId: "intro", replyMessageId: REPLY }, page);
    await settle();
    expect(page.openEpisode).not.toHaveBeenCalled();
  });

  it("opens other notifications on the course page without the companion", async () => {
    const { host: page, calls } = host();
    openNotificationTarget({ enrollmentId: ENROLLMENT, companion: false }, page);
    await vi.waitFor(() => expect(calls).toEqual([`refresh:${ENROLLMENT}`, "episode:none", "view:learn"]));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(composed).toEqual([]);
    companionOpen.sync({ docked: true, surface: "course" });
    expect(companionOpen.get().open).toBe(false);
  });

  it("does nothing more when the course cannot be loaded", async () => {
    const { host: page } = host({ refresh: vi.fn(async () => Promise.reject(new Error("NETWORK"))) });
    openNotificationTarget({ enrollmentId: ENROLLMENT, companion: true, episodeId: "intro", replyMessageId: REPLY }, page);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(page.openEpisode).not.toHaveBeenCalled();
    expect(composed).toEqual([]);
  });
});
