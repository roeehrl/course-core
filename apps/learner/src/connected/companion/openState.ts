import { useSyncExternalStore } from "react";
import { lessonReadingAnchor, restoreReadingAnchor, type ReadingAnchor } from "../readingAnchor";
import { defaultDetent, validDetent, type SheetKind } from "./sheetDetents";

/**
 * Whether the companion is open, and how (docked beside the lesson or in focus view; the sheet's
 * height). One store for the host, the dock and every "ask the companion" entry point, so opening
 * it from the lesson never goes through the host's state.
 *
 * Beside the lesson the panel starts closed until the learner opens it, and that choice is
 * remembered on this device (`course:learner-companion-pane`, `open` or `collapsed`); on the
 * course page it starts closed whatever that choice and opens only when asked. As a sheet it starts
 * closed and every open starts at Half (Full on a short window). Focus view is remembered for this
 * browser session only, and only beside the lesson: the host hides the lesson while the view is
 * "focus". Opening or closing the panel keeps the line being read where it is on the screen
 * (readingAnchor.ts).
 */
export type CompanionView = "docked" | "focus";
export type CompanionDetent = "collapsed" | "half" | "full";
export type CompanionSurface = "course" | "lesson";
export interface CompanionOpenState {
  /** The companion is showing: the panel beside the lesson, or the sheet. */
  open: boolean;
  /** "focus" only while the docked companion is open in focus view. */
  view: CompanionView;
  detent: CompanionDetent;
  /** The panel beside the lesson is shown (docked layouts). */
  paneOpen: boolean;
  /** The sheet is open (sheet layouts). */
  sheetOpen: boolean;
  docked: boolean;
}

export const PANE_PREFERENCE = "course:learner-companion-pane";
/** Focus view, for this browser session only. */
export const VIEW_PREFERENCE = "course:learner-companion-view";
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
function readFocusView(): boolean {
  try {
    return window.sessionStorage.getItem(VIEW_PREFERENCE) === "focus";
  } catch {
    return false;
  }
}
function writeFocusView(focus: boolean) {
  try {
    if (focus) window.sessionStorage.setItem(VIEW_PREFERENCE, "focus");
    else window.sessionStorage.removeItem(VIEW_PREFERENCE);
  } catch {
    /* Focus view then lasts for this page only. */
  }
}

interface Raw {
  preference: "open" | "collapsed";
  overviewOpen: boolean;
  sheetOpen: boolean;
  surface: CompanionSurface;
  docked: boolean;
  /** The learner chose focus view (it shows only while docked and open). */
  focus: boolean;
  detent: CompanionDetent;
  /** Which sheet this window uses, while it uses one (the dock reports it). */
  sheet: SheetKind | null;
}
const fresh = (): Raw => ({
  preference: readPanePreference() ?? "collapsed",
  overviewOpen: false,
  sheetOpen: false,
  surface: "course",
  docked: false,
  focus: readFocusView(),
  detent: "half",
  sheet: null,
});
let raw: Raw = {
  preference: "collapsed",
  overviewOpen: false,
  sheetOpen: false,
  surface: "course",
  docked: false,
  focus: false,
  detent: "half",
  sheet: null,
};
function derive(value: Raw): CompanionOpenState {
  const paneOpen = value.surface === "course" ? value.overviewOpen : value.preference === "open";
  const open = value.docked ? paneOpen : value.sheetOpen;
  return {
    open,
    view: value.docked && open && value.focus ? "focus" : "docked",
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
/** What opened the companion last ("trigger", "shortcut", "check", …). */
let openedBy: string | undefined;
/** Whether the last change came from an action (opening, closing) or from the layout or page. */
let lastChange: "action" | "layout" = "layout";
/** Shows or hides the pane beside the lesson: on the course page for this visit only, in a lesson
 * as the remembered choice. The line being read is kept in place (restoreReadingAnchor). */
function setPane(open: boolean) {
  const anchor = (reading = lessonReadingAnchor());
  // Used by the layout this change commits, or by none (the pane was already that way).
  requestAnimationFrame(() => {
    if (reading === anchor) reading = null;
  });
  if (raw.surface === "course") return update({ overviewOpen: open });
  const preference = open ? "open" : "collapsed";
  writePanePreference(preference);
  update({ preference });
}
/** The height a sheet opens at: Half (Full on a short window), or what it shows already. */
function openingDetent(): CompanionDetent {
  const kind = raw.sheet ?? "phone";
  if (raw.sheetOpen && raw.detent !== "collapsed") return validDetent(kind, raw.detent);
  return defaultDetent(kind);
}

export const companionOpen = {
  get: (): CompanionOpenState => state,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  },
  /** Opens the companion where the layout puts it: a sheet at Half every time it opens, or keeps
   * the height it shows. `surface: "course"` opens it on the course page the host is about to
   * show (a notification), whatever page is on screen now. */
  open(source?: string, options: { surface?: CompanionSurface } = {}) {
    openedBy = source;
    lastChange = "action";
    if (options.surface && options.surface !== raw.surface) update(options.surface === "course" ? { surface: "course", overviewOpen: false } : { surface: "lesson" });
    if (raw.docked) setPane(true);
    else update({ sheetOpen: true, detent: openingDetent() });
  },
  /** What opened the companion last: the dock moves focus into it for the trigger and the
   * shortcut; a request to compose focuses the message box itself. */
  openedBy: () => openedBy,
  /** "action" when the last change opened or closed it on request, "layout" when the window, the
   * page or a reset did (the dock animates only the former). */
  lastChange: () => lastChange,
  close() {
    lastChange = "action";
    if (raw.docked) setPane(false);
    else update({ sheetOpen: false });
  },
  toggle(source = "toggle") {
    if (state.open) companionOpen.close();
    else companionOpen.open(source);
  },
  /** The pane beside the lesson, shown or hidden (the dock's own controls). */
  setPaneOpen(open: boolean) {
    lastChange = "action";
    setPane(open);
  },
  /** The sheet, open (at Half, or the height it shows) or closed (the dock's own controls). */
  setSheetOpen(open: boolean) {
    lastChange = "action";
    update(open ? { sheetOpen: true, detent: openingDetent() } : { sheetOpen: false });
  },
  /** Focus view or beside the lesson; remembered for this browser session. */
  setView(view: CompanionView) {
    writeFocusView(view === "focus");
    update({ focus: view === "focus" });
  },
  setDetent(detent: CompanionDetent) {
    update({ detent: validDetent(raw.sheet ?? "phone", detent) });
  },
  /** The sheet this window uses, or null beside the lesson (reported by the dock). A height the
   * new sheet does not have becomes Full. */
  setSheet(sheet: SheetKind | null) {
    update(sheet ? { sheet, detent: validDetent(sheet, raw.detent) } : { sheet });
  },
  /** The host's layout and page: docked beside the lesson or not, the course page or a lesson.
   * Leaving the course page closes its pane again (it opens there only when asked). */
  sync({ docked, surface }: { docked: boolean; surface: CompanionSurface }) {
    lastChange = "layout";
    const patch: Partial<Raw> = surface === "lesson" ? { docked, surface, overviewOpen: false } : { docked, surface };
    // Crossing between the panel and the sheet (a tablet rotated, a window narrowed) keeps what the
    // learner sees, whatever has the focus: an open panel opens the sheet at its opening height, a
    // closed one closes it, and an open sheet shows the panel. Done in the same change, so the
    // companion is never hidden for a frame (which would drop the focus inside it).
    if (raw.docked !== docked && surface === raw.surface) {
      if (raw.docked) {
        const paneOpen = derive(raw).paneOpen;
        patch.sheetOpen = paneOpen;
        if (paneOpen) patch.detent = openingDetent();
      } else if (raw.sheetOpen && !derive(raw).paneOpen) {
        if (surface === "course") patch.overviewOpen = true;
        else {
          writePanePreference("open");
          patch.preference = "open";
        }
      }
    }
    update(patch);
  },
  /** Another enrollment, signing out or an erased course: the sheet closes, focus view ends. */
  resetForEnrollment() {
    lastChange = "layout";
    writeFocusView(false);
    update({ sheetOpen: false, focus: false });
  },
  /** A new host: the remembered choices are read again and nothing is open. */
  reset() {
    raw = fresh();
    reading = null;
    openedBy = undefined;
    lastChange = "layout";
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
