import { useSyncExternalStore } from "react";
import { readingAnchor, restoreReadingAnchor, type ReadingAnchor } from "../readingAnchor";

/**
 * Whether the companion is open, and how (docked beside the lesson or in focus view; the sheet's
 * height). One store for the host, the dock and every "ask the companion" entry point, so opening
 * it from the lesson never goes through the host's state.
 *
 * Beside the lesson the pane starts collapsed until the learner opens it, and that choice is
 * remembered on this device (`course:learner-companion-pane`, `open` or `collapsed`); on the
 * course page it starts closed whatever that choice and opens only when asked. As a sheet it starts
 * closed. Opening or closing the pane keeps the line being read where it is on the screen
 * (readingAnchor.ts).
 */
export type CompanionView = "docked" | "focus";
export type CompanionDetent = "collapsed" | "half" | "full";
export type CompanionSurface = "course" | "lesson";
export interface CompanionOpenState {
  /** The companion is showing: the pane beside the lesson, or the sheet. */
  open: boolean;
  view: CompanionView;
  detent: CompanionDetent;
  /** The pane beside the lesson is shown (docked layouts). */
  paneOpen: boolean;
  /** The sheet is open (sheet layouts). */
  sheetOpen: boolean;
  docked: boolean;
}

export const PANE_PREFERENCE = "course:learner-companion-pane";
/** The learner's last explicit choice to show or hide the pane. A device preference only. */
function readPanePreference(): "open" | "collapsed" | undefined {
  try {
    const value = window.localStorage.getItem(PANE_PREFERENCE);
    return value === "open" || value === "collapsed" ? value : undefined;
  } catch {
    return;
  }
}
function writePanePreference(value: "open" | "collapsed") {
  try {
    window.localStorage.setItem(PANE_PREFERENCE, value);
  } catch {
    /* The choice then lasts for this page only. */
  }
}

interface Raw {
  preference: "open" | "collapsed";
  overviewOpen: boolean;
  sheetOpen: boolean;
  surface: CompanionSurface;
  docked: boolean;
  view: CompanionView;
  detent: CompanionDetent;
}
const fresh = (): Raw => ({
  preference: readPanePreference() ?? "collapsed",
  overviewOpen: false,
  sheetOpen: false,
  surface: "course",
  docked: false,
  view: "docked",
  detent: "full",
});
let raw: Raw = { preference: "collapsed", overviewOpen: false, sheetOpen: false, surface: "course", docked: false, view: "docked", detent: "full" };
function derive(value: Raw): CompanionOpenState {
  const paneOpen = value.surface === "course" ? value.overviewOpen : value.preference === "open";
  return {
    open: value.docked ? paneOpen : value.sheetOpen,
    view: value.view,
    detent: value.detent,
    paneOpen,
    sheetOpen: value.sheetOpen,
    docked: value.docked,
  };
}
let state = derive(raw);
const listeners = new Set<() => void>();
function update(patch: Partial<Raw>) {
  const next = { ...raw, ...patch };
  if ((Object.keys(next) as (keyof Raw)[]).every((key) => next[key] === raw[key])) return;
  raw = next;
  const derived = derive(raw);
  const same = (Object.keys(derived) as (keyof CompanionOpenState)[]).every((key) => derived[key] === state[key]);
  if (same) return;
  state = derived;
  for (const listener of listeners) listener();
}

let reading: ReadingAnchor | null = null;
/** Shows or hides the pane beside the lesson: on the course page for this visit only, in a lesson
 * as the remembered choice. The line being read is kept in place (restoreReadingAnchor). */
function setPane(open: boolean) {
  const header = document.querySelector(".connected-header")?.getBoundingClientRect().bottom ?? 0;
  const anchor = (reading = readingAnchor(document.querySelector(".connected-main"), header));
  // Used by the layout this change commits, or by none (the pane was already that way).
  requestAnimationFrame(() => {
    if (reading === anchor) reading = null;
  });
  if (raw.surface === "course") return update({ overviewOpen: open });
  const preference = open ? "open" : "collapsed";
  writePanePreference(preference);
  update({ preference });
}

export const companionOpen = {
  get: (): CompanionOpenState => state,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  },
  /** Opens the companion where the layout puts it. `surface: "course"` opens it on the course page
   * the host is about to show (a notification), whatever page is on screen now. */
  open(_source?: string, options: { surface?: CompanionSurface } = {}) {
    if (options.surface && options.surface !== raw.surface) update(options.surface === "course" ? { surface: "course", overviewOpen: false } : { surface: "lesson" });
    if (raw.docked) setPane(true);
    else update({ sheetOpen: true });
  },
  close() {
    if (raw.docked) setPane(false);
    else update({ sheetOpen: false });
  },
  toggle() {
    if (state.open) companionOpen.close();
    else companionOpen.open("toggle");
  },
  /** The pane beside the lesson, shown or hidden (the dock's own controls). */
  setPaneOpen(open: boolean) {
    setPane(open);
  },
  /** The sheet, open or closed (the dock's own controls). */
  setSheetOpen(open: boolean) {
    update({ sheetOpen: open });
  },
  setView(view: CompanionView) {
    update({ view });
  },
  setDetent(detent: CompanionDetent) {
    update({ detent });
  },
  /** The host's layout and page: docked beside the lesson or not, the course page or a lesson.
   * Leaving the course page closes its pane again (it opens there only when asked). */
  sync({ docked, surface }: { docked: boolean; surface: CompanionSurface }) {
    update(surface === "lesson" ? { docked, surface, overviewOpen: false } : { docked, surface });
  },
  /** Another enrollment, signing out or an erased course: the sheet closes, focus view ends. */
  resetForEnrollment() {
    update({ sheetOpen: false, view: "docked" });
  },
  /** A new host: the remembered choice is read again and nothing is open. */
  reset() {
    raw = fresh();
    reading = null;
    state = derive(raw);
    for (const listener of listeners) listener();
  },
  /** After the pane opened or closed: puts the line being read back where it was. */
  restoreReadingAnchor() {
    const anchor = reading;
    reading = null;
    if (anchor) restoreReadingAnchor(anchor);
  },
};

/** The open state, re-rendering only when it changes. */
export function useCompanionOpenState(): CompanionOpenState {
  return useSyncExternalStore(companionOpen.subscribe, companionOpen.get, companionOpen.get);
}
/** One value of the open state, re-rendering only when that value changes. */
export function useCompanionOpenValue<K extends keyof CompanionOpenState>(key: K): CompanionOpenState[K] {
  return useSyncExternalStore(companionOpen.subscribe, () => companionOpen.get()[key], () => companionOpen.get()[key]);
}
