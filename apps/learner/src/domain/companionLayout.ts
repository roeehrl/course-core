import { companionPlacement, windowClass, type WindowClass } from "./windowClass";

/**
 * Where the companion goes in a window, and whether the page uses its compact layout (the lesson
 * scrolls in its own pane, the companion button has a row of its own).
 *
 * - `placement`: `docked` beside the lesson, or a `sheet` over it.
 * - `sheet`: which sheet (`phone`, `tablet` or `short` for a short landscape window), null when
 *   docked.
 * - `compactPage`: the page's compact layout (`is-compact`).
 *
 * Today's rule: docked when the window is not compact and at least 600 px high.
 */
export interface CompanionLayout {
  placement: "docked" | "sheet";
  sheet: "phone" | "tablet" | "short" | null;
  compactPage: boolean;
  windowClass: WindowClass;
}

export function companionLayout(width: number, height: number, fontScale = 1): CompanionLayout {
  const size = windowClass(width, fontScale);
  const docked = companionPlacement(size, height) === "pane";
  return {
    placement: docked ? "docked" : "sheet",
    sheet: docked ? null : size === "compact" ? (height < 480 ? "short" : "phone") : size === "medium" ? "tablet" : "short",
    compactPage: !docked,
    windowClass: size,
  };
}
