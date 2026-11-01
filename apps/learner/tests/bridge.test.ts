import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  PENDING_TARGET_MS,
  companionBridge,
  lessonNavigator,
  resetCompanionBridge,
  useCompanionActivity,
  useCompanionAvailable,
} from "../src/connected/companion/bridge";
import { PANE_PREFERENCE, companionOpen } from "../src/connected/companion/openState";
import { companionLayout } from "../src/domain/companionLayout";

beforeEach(() => {
  resetCompanionBridge();
  window.localStorage.clear();
  companionOpen.reset();
});
afterEach(() => vi.useRealTimers());

describe("companion bridge", () => {
  it("merges activity from its writers and stays quiet when nothing changes", () => {
    const heard = vi.fn();
    companionBridge.onActivity(heard);
    companionBridge.updateActivity({ unread: 2, firstUnreadId: "m1", replyAbout: { c1: "m1" } });
    companionBridge.updateActivity({ latest: { text: "Compare them", busy: false } });
    expect(companionBridge.activity()).toEqual({
      unread: 2,
      firstUnreadId: "m1",
      replyAbout: { c1: "m1" },
      suggestions: 0,
      latest: { text: "Compare them", busy: false },
    });
    expect(heard).toHaveBeenCalledTimes(2);
    // The same values again (new objects, equal fields): nobody re-renders.
    companionBridge.updateActivity({ unread: 2, replyAbout: { c1: "m1" }, latest: { text: "Compare them", busy: false } });
    expect(heard).toHaveBeenCalledTimes(2);
    companionBridge.updateActivity({ suggestions: 1 });
    expect(companionBridge.activity().unread).toBe(2);
    const { result } = renderHook(() => useCompanionActivity());
    expect(result.current.suggestions).toBe(1);
    act(() => companionBridge.updateActivity({ unread: 0 }));
    expect(result.current.unread).toBe(0);
  });

  it("opens the companion and replays a request made before the composer listens, once", () => {
    companionOpen.sync({ docked: false, surface: "lesson" });
    companionBridge.compose({ source: "check", text: "Why 2?" });
    expect(companionOpen.get().open).toBe(true);
    const first = vi.fn(),
      second = vi.fn();
    const stop = companionBridge.onCompose(first);
    expect(first).toHaveBeenCalledWith({ source: "check", text: "Why 2?" });
    companionBridge.onCompose(second);
    expect(second).not.toHaveBeenCalled();
    companionBridge.compose({ source: "selection", focus: false });
    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledWith({ source: "selection", focus: false });
    stop();
  });

  it("tells subscribers when the companion becomes available", () => {
    const { result } = renderHook(() => useCompanionAvailable());
    expect(result.current).toBe(false);
    act(() => companionBridge.setAvailable(true));
    expect(result.current).toBe(true);
    expect(companionBridge.available()).toBe(true);
  });

  it("calls the newest stop, selection and navigation handlers, and forgets one only when it unregisters itself", () => {
    expect(companionBridge.stopRunningReply()).toBe(false);
    const older = vi.fn(() => true),
      newer = vi.fn(() => false);
    const dropOlder = companionBridge.registerStop(older);
    companionBridge.registerStop(newer);
    dropOlder();
    expect(companionBridge.stopRunningReply()).toBe(false);
    expect(newer).toHaveBeenCalledOnce();
    companionBridge.registerSelection(() => true);
    expect(companionBridge.attachSelection()).toBe(true);
    expect(companionBridge.navigate({ to: "course" })).toBe(false);
    const profile = vi.fn(),
      lesson = vi.fn(),
      course = vi.fn();
    companionBridge.registerNavigate({ profile, lesson, course });
    expect(companionBridge.navigate({ to: "profile", section: "decisions" })).toBe(true);
    companionBridge.navigate({ to: "lesson", episodeId: "min" });
    companionBridge.navigate({ to: "course" });
    expect(profile).toHaveBeenCalledWith("decisions");
    expect(lesson).toHaveBeenCalledWith("min");
    expect(course).toHaveBeenCalledOnce();
  });
});

describe("lesson navigator", () => {
  it("offers a target to every listener until one takes it", () => {
    const no = vi.fn(() => false),
      yes = vi.fn(() => true);
    lessonNavigator.register(no);
    lessonNavigator.register(yes);
    expect(lessonNavigator.show({ blockId: "reading" })).toBe(true);
    expect(no).toHaveBeenCalledWith({ blockId: "reading" });
  });

  it("holds a target for a lesson still mounting for up to 5 s", () => {
    vi.useFakeTimers();
    expect(lessonNavigator.show({ episodeId: "max", challengeId: "c1", focus: "answer" })).toBe(false);
    const late = vi.fn(() => true);
    lessonNavigator.register(late);
    expect(late).toHaveBeenCalledWith({ episodeId: "max", challengeId: "c1", focus: "answer" });
    // Taken once: the next listener does not get it again.
    const next = vi.fn(() => true);
    lessonNavigator.register(next);
    expect(next).not.toHaveBeenCalled();
    lessonNavigator.show({ blockId: "gone" });
    resetCompanionBridge();
    lessonNavigator.show({ blockId: "old" });
    vi.advanceTimersByTime(PENDING_TARGET_MS + 1);
    const tooLate = vi.fn(() => true);
    lessonNavigator.register(tooLate);
    expect(tooLate).not.toHaveBeenCalled();
  });
});

describe("companion open state", () => {
  it("remembers the pane in a lesson, opens on the course page only when asked, and keeps the sheet apart", () => {
    companionOpen.sync({ docked: true, surface: "lesson" });
    expect(companionOpen.get().open).toBe(false);
    companionOpen.open("trigger");
    expect(companionOpen.get()).toMatchObject({ open: true, paneOpen: true, sheetOpen: false, view: "docked" });
    expect(window.localStorage.getItem(PANE_PREFERENCE)).toBe("open");
    // The course page: closed until asked, whatever the lesson's choice.
    companionOpen.sync({ docked: true, surface: "course" });
    expect(companionOpen.get().open).toBe(false);
    companionOpen.open("notification", { surface: "course" });
    expect(companionOpen.get().open).toBe(true);
    expect(window.localStorage.getItem(PANE_PREFERENCE)).toBe("open");
    companionOpen.sync({ docked: true, surface: "lesson" });
    companionOpen.sync({ docked: true, surface: "course" });
    expect(companionOpen.get().open).toBe(false);
    // As a sheet: closed until opened, closed again for another enrollment.
    companionOpen.sync({ docked: false, surface: "lesson" });
    expect(companionOpen.get().open).toBe(false);
    companionOpen.toggle();
    expect(companionOpen.get().open).toBe(true);
    companionOpen.resetForEnrollment();
    expect(companionOpen.get().open).toBe(false);
    // A new host reads the remembered choice again.
    window.localStorage.setItem(PANE_PREFERENCE, "collapsed");
    companionOpen.reset();
    companionOpen.sync({ docked: true, surface: "lesson" });
    expect(companionOpen.get().open).toBe(false);
  });

  it("docks the companion beside the lesson in a wide, tall window and uses a sheet otherwise", () => {
    expect(companionLayout(1440, 960)).toMatchObject({ placement: "docked", sheet: null, compactPage: false, windowClass: "expanded" });
    expect(companionLayout(834, 1112)).toMatchObject({ placement: "sheet", sheet: "tablet", compactPage: false, windowClass: "medium" });
    expect(companionLayout(390, 844)).toMatchObject({ placement: "sheet", sheet: "phone", compactPage: true });
    expect(companionLayout(1024, 470)).toMatchObject({ placement: "sheet", sheet: "short", compactPage: true });
    expect(companionLayout(700, 500)).toMatchObject({ placement: "sheet", sheet: "tablet" });
    // Text scaled up: the effective width decides.
    expect(companionLayout(900, 960, 2)).toMatchObject({ placement: "sheet", windowClass: "compact" });
  });
});
