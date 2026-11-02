/**
 * The docked companion panel's width (final design §2.1): what a window allows, where the splitter
 * snaps, how the keyboard moves it, and the learner's width remembered on this device.
 *
 * The lesson column never goes below 480 px (479 + the 1 px divider), the panel never below 360 or
 * above 720. The default is 400 where the lesson keeps at least 540 px beside it, else less, as
 * the width table says (1024: 400 → 544, 900: 360 → 420, 840: 360 fixed).
 */
export const PANEL_MIN = 360;
export const PANEL_MAX = 720;
export const PANEL_DEFAULT = 400;
export const PANEL_WIDE = 560;
/** The lesson column's least width, with the divider. */
export const LESSON_MIN = 480;
/** Below 540 px of lesson the default gives way, down to the minimum. */
const LESSON_DEFAULT_ROOM = 540;
/** Snap points and how close the pointer must come (§2.1, G8). */
export const SNAPS = [PANEL_DEFAULT, PANEL_WIDE] as const;
export const SNAP_DISTANCE = 12;
/** Keyboard steps: an arrow, Shift and an arrow. */
export const STEP = 16;
export const BIG_STEP = 64;
export const WIDTH_PREFERENCE = "course:learner-companion-width";

export interface PanelRange {
  min: number;
  max: number;
  default: number;
}

/** What a docked window `width` px wide allows. */
export function panelRange(width: number): PanelRange {
  const room = Number.isFinite(width) ? width : 0;
  const max = Math.max(PANEL_MIN, Math.min(PANEL_MAX, Math.floor(room - LESSON_MIN)));
  const fallback = Math.max(PANEL_MIN, Math.min(PANEL_DEFAULT, Math.floor(room - LESSON_DEFAULT_ROOM)));
  return { min: PANEL_MIN, max, default: Math.min(fallback, max) };
}

export const clampWidth = (value: number, range: PanelRange) =>
  Math.round(Math.max(range.min, Math.min(range.max, Number.isFinite(value) ? value : range.default)));

/** A dragged width, pulled to 400 or 560 when it comes within 12 px of one the window allows. */
export function snapWidth(value: number, range: PanelRange): number {
  const width = clampWidth(value, range);
  for (const snap of SNAPS)
    if (snap >= range.min && snap <= range.max && Math.abs(width - snap) <= SNAP_DISTANCE) return snap;
  return width;
}

/** The width after dragging the divider by `dx` screen pixels: the panel is at the inline end, so
 * in a left-to-right page a move to the left widens it, in a right-to-left one a move to the right. */
export function dragWidth(start: number, dx: number, rtl: boolean, range: PanelRange): number {
  return snapWidth(start + (rtl ? dx : -dx), range);
}

/** The width after a key on the splitter, or null for a key it does not use. Arrows follow the
 * screen: ← moves the divider left whatever the reading direction (§5). */
export function keyWidth(
  current: number,
  key: { key: string; shiftKey?: boolean },
  rtl: boolean,
  range: PanelRange,
): number | null {
  const step = key.shiftKey ? BIG_STEP : STEP;
  switch (key.key) {
    case "ArrowLeft":
      return clampWidth(current + (rtl ? -step : step), range);
    case "ArrowRight":
      return clampWidth(current + (rtl ? step : -step), range);
    case "Home":
      return range.min;
    case "End":
      return range.max;
    case "Enter":
      return clampWidth(current === PANEL_DEFAULT ? PANEL_WIDE : PANEL_DEFAULT, range);
    default:
      return null;
  }
}

/** The learner's width on this device, or undefined. Storage can be off; nothing breaks then. */
export function readWidth(): number | undefined {
  try {
    const value = Number(window.localStorage.getItem(WIDTH_PREFERENCE));
    return Number.isFinite(value) && value >= PANEL_MIN ? value : undefined;
  } catch {
    return undefined;
  }
}
export function writeWidth(value: number) {
  try {
    window.localStorage.setItem(WIDTH_PREFERENCE, String(Math.round(value)));
  } catch {
    /* The width then lasts for this page only. */
  }
}
export function forgetWidth() {
  try {
    window.localStorage.removeItem(WIDTH_PREFERENCE);
  } catch {
    /* Nothing was kept. */
  }
}
