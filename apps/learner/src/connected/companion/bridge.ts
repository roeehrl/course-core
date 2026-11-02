import { useSyncExternalStore } from "react";
import { companionOpen } from "./openState";

/**
 * The companion bridge: how the lesson, the header and the profile talk to the companion without
 * importing it, and how the companion publishes what other surfaces show (unread replies, the
 * latest line). In memory only, never stored. Each field of the activity has one writer.
 */
export type ComposeSource = "check" | "nudge" | "gate" | "selection" | "code" | "video" | "illustration" | "notification" | "edit" | "shortcut";
export interface ComposeRequest {
  source: ComposeSource;
  /** Put in the message box, caret at the end; never sends. */
  text?: string;
  /** Focus the message box (default true; false keeps a touch keyboard down). */
  focus?: boolean;
  /** The thread puts this message's start 16 px from its top and highlights it (M14). */
  revealMessageId?: string;
}
export interface CompanionActivity {
  /** Written by the unread tracker (notify). */
  unread: number;
  firstUnreadId?: string;
  /** challengeId → the reply message about it (notify). */
  replyAbout: Readonly<Record<string, string>>;
  /** A decision waiting on the profile (profile). */
  suggestions: number;
  /** The collapsed bar's one line (conversation): `busy` while a reply is prepared and has no text
   * yet (the bar's dots); once text streams, the line is that text alone. */
  latest: { text: string; busy: boolean } | null;
}
export type NavigateTarget = { to: "profile"; section?: string } | { to: "lesson"; episodeId: string } | { to: "course" };
export interface NavigateHandlers {
  profile(section?: string): void;
  lesson(episodeId: string): void;
  course(): void;
}

const EMPTY_ACTIVITY: CompanionActivity = { unread: 0, replyAbout: {}, suggestions: 0, latest: null };

let available = false;
let activity: CompanionActivity = EMPTY_ACTIVITY;
let replay: ComposeRequest | null = null;
const availableListeners = new Set<(value: boolean) => void>();
const composeListeners = new Set<(request: ComposeRequest) => void>();
const activityListeners = new Set<(value: CompanionActivity) => void>();
let stop: (() => boolean) | null = null;
let selection: (() => boolean) | null = null;
let navigation: NavigateHandlers | null = null;

const shallowEqual = <T extends object>(a: T, b: T) => {
  const keys = Object.keys(a) as (keyof T)[];
  return keys.length === Object.keys(b).length && keys.every((key) => Object.is(a[key], b[key]));
};
const sameValue = (a: unknown, b: unknown) =>
  Object.is(a, b) || (!!a && !!b && typeof a === "object" && typeof b === "object" && shallowEqual(a as object, b as object));

/** Registers one handler slot: the newest registration wins; its cleanup clears only itself. */
function slot<F>(get: () => F | null, set: (value: F | null) => void) {
  return (fn: F) => {
    set(fn);
    return () => {
      if (get() === fn) set(null);
    };
  };
}

export const companionBridge = {
  /** True while the companion region is mounted (the study arm offers the companion). */
  available: () => available,
  setAvailable(value: boolean) {
    if (available === value) return;
    available = value;
    for (const listener of availableListeners) listener(value);
  },
  onAvailable(listener: (value: boolean) => void) {
    availableListeners.add(listener);
    return () => void availableListeners.delete(listener);
  },
  /** Opens the companion and hands the request to its composer; a request made before anyone
   * listens is kept and given to the first listener once. */
  compose(request: ComposeRequest) {
    companionOpen.open(request.source);
    if (!composeListeners.size) {
      replay = request;
      return;
    }
    replay = null;
    for (const listener of composeListeners) listener(request);
  },
  onCompose(listener: (request: ComposeRequest) => void) {
    composeListeners.add(listener);
    if (replay) {
      const request = replay;
      replay = null;
      listener(request);
    }
    return () => void composeListeners.delete(listener);
  },
  registerStop: slot<() => boolean>(() => stop, (fn) => (stop = fn)),
  /** Stops the reply being written, if any; false when nothing was running. */
  stopRunningReply: () => stop?.() ?? false,
  registerSelection: slot<() => boolean>(() => selection, (fn) => (selection = fn)),
  /** Attaches the lesson selection to the next message; false when there is none. */
  attachSelection: () => selection?.() ?? false,
  activity: () => activity,
  /** Merges a patch; nothing happens (and no listener hears) when no field changes. */
  updateActivity(patch: Partial<CompanionActivity>) {
    const keys = Object.keys(patch) as (keyof CompanionActivity)[];
    if (keys.every((key) => sameValue(activity[key], patch[key]))) return;
    activity = { ...activity, ...patch };
    for (const listener of activityListeners) listener(activity);
  },
  onActivity(listener: (value: CompanionActivity) => void) {
    activityListeners.add(listener);
    return () => void activityListeners.delete(listener);
  },
  registerNavigate: slot<NavigateHandlers>(() => navigation, (handlers) => (navigation = handlers)),
  /** Goes to the profile (a section of it), a lesson or the course page; false without a host. */
  navigate(target: NavigateTarget): boolean {
    if (!navigation) return false;
    if (target.to === "profile") navigation.profile(target.section);
    else if (target.to === "lesson") navigation.lesson(target.episodeId);
    else navigation.course();
    return true;
  },
};

export function useCompanionAvailable(): boolean {
  return useSyncExternalStore(companionBridge.onAvailable, companionBridge.available, () => false);
}
export function useCompanionActivity(): CompanionActivity {
  return useSyncExternalStore(companionBridge.onActivity, companionBridge.activity, () => EMPTY_ACTIVITY);
}

/** A place in the lesson to show: a part, a check (optionally its answer), in a lesson. */
export type LessonTarget = { episodeId?: string; blockId?: string; challengeId?: string; focus?: "answer" | "block" };

/** How long a target waits for a lesson that is still mounting. */
export const PENDING_TARGET_MS = 5000;
const lessonListeners = new Set<(target: LessonTarget) => boolean>();
let pendingTarget: { target: LessonTarget; until: number } | null = null;

export const lessonNavigator = {
  /** A lesson part or check that can show targets; it returns true when it handled one. A target
   * held for a lesson that was still mounting is offered to it as it registers. */
  register(fn: (target: LessonTarget) => boolean) {
    lessonListeners.add(fn);
    if (pendingTarget) {
      if (pendingTarget.until < Date.now()) pendingTarget = null;
      else if (fn(pendingTarget.target)) pendingTarget = null;
    }
    return () => void lessonListeners.delete(fn);
  },
  /** Scrolls to the target (scroll-margin-top = header + 16), highlights it (M14) and optionally
   * focuses it. When no listener takes it yet, it is held for up to 5 s. */
  show(target: LessonTarget): boolean {
    for (const listener of lessonListeners) if (listener(target)) {
      pendingTarget = null;
      return true;
    }
    pendingTarget = { target, until: Date.now() + PENDING_TARGET_MS };
    return false;
  },
};

/** Tests: back to a fresh page. */
export function resetCompanionBridge() {
  available = false;
  activity = EMPTY_ACTIVITY;
  replay = null;
  stop = selection = null;
  navigation = null;
  pendingTarget = null;
  availableListeners.clear();
  composeListeners.clear();
  activityListeners.clear();
  lessonListeners.clear();
}
