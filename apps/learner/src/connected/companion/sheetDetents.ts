/**
 * The companion sheet's heights and how a drag or a key moves between them (final design §2.3-§2.5).
 *
 * Phone and tablet sheets have three heights: Collapsed (a 72 px bar), Half (half the window, the
 * height every open starts at) and Full (up to a strip of lesson under the header: 88 px on a phone,
 * 120 on a tablet, 48 while an on-screen keyboard is open). A short window (under 480 px high) has
 * Collapsed and Full only and opens at Full, which leaves 48 px of the window's top (342 px tall on
 * an 844 × 390 phone): there the sheet also covers the header, which has no room beside it.
 */
export type SheetKind = "phone" | "tablet" | "short";
export type Detent = "collapsed" | "half" | "full";

export const COLLAPSED_HEIGHT = 72;
/** The lesson left visible under the header at Full. */
export const FULL_STRIP: Record<SheetKind, number> = { phone: 88, tablet: 120, short: 48 };
export const KEYBOARD_STRIP = 48;
/** A downward flick faster than this (px per ms) closes the sheet from Half or below, else goes one
 * height lower. */
export const FLICK_VELOCITY = 0.5;
/** Dragged this far below Collapsed (a share of its height), the sheet closes on release. */
export const DISMISS_SHARE = 0.25;
/** Pulled above Full, the sheet follows at this fraction of the pointer (a rubber band). */
export const RUBBER_BAND = 0.3;

export function detentsFor(kind: SheetKind): Detent[] {
  return kind === "short" ? ["collapsed", "full"] : ["collapsed", "half", "full"];
}
export function defaultDetent(kind: SheetKind): Detent {
  return kind === "short" ? "full" : "half";
}
/** A height this sheet does not have becomes the nearest it has (Half on a short window is Full). */
export function validDetent(kind: SheetKind, detent: Detent): Detent {
  return detentsFor(kind).includes(detent) ? detent : "full";
}

export interface SheetGeometry {
  kind: SheetKind;
  /** The layout viewport's height (the window, not shrunk by a keyboard). */
  viewport: number;
  /** The app header's drawn height. */
  header: number;
  /** How much of the window's bottom an on-screen keyboard covers. */
  keyboard: number;
}

/** Each height in px, measured from the window's bottom edge (the keyboard's part included). */
export function detentHeights({ kind, viewport, header, keyboard }: SheetGeometry): Record<Detent, number> {
  const strip = keyboard > 0 ? KEYBOARD_STRIP : FULL_STRIP[kind];
  const top = kind === "short" ? FULL_STRIP.short : header + strip;
  const full = Math.max(COLLAPSED_HEIGHT, Math.round(viewport - top));
  const half = Math.min(full, Math.max(COLLAPSED_HEIGHT, Math.round(viewport / 2)));
  return { collapsed: COLLAPSED_HEIGHT, half, full };
}

/** ↑ (`direction` 1) or ↓ (-1) from `current`: the next height that way, or the same at the end. */
export function stepDetent(kind: SheetKind, current: Detent, direction: 1 | -1): Detent {
  const list = detentsFor(kind);
  const index = list.indexOf(validDetent(kind, current));
  return list[Math.max(0, Math.min(list.length - 1, index + direction))]!;
}

/** A tap on the handle: Half and Full take turns; Collapsed opens to Half (Full on a short window). */
export function cycleDetent(kind: SheetKind, current: Detent): Detent {
  if (current === "collapsed") return defaultDetent(kind);
  if (kind === "short") return "collapsed";
  return current === "full" ? "half" : "full";
}

/** How tall the sheet is drawn while dragged `dy` px down (negative: up) from `base`, with the rubber
 * band above Full. */
export function dragHeight(base: number, dy: number, full: number): number {
  const height = base - dy;
  return height > full ? full + (height - full) * RUBBER_BAND : height;
}

/** Where a released drag settles: the next height in the direction of a fast flick, else the
 * nearest; `closed` when dragged a quarter below Collapsed or flicked down from Half or below.
 * `velocity` is in px per ms, positive downward. */
export function releaseDetent(
  kind: SheetKind,
  heights: Record<Detent, number>,
  height: number,
  velocity: number,
): Detent | "closed" {
  if (height < heights.collapsed * (1 - DISMISS_SHARE)) return "closed";
  const list = detentsFor(kind).map((detent) => ({ detent, height: heights[detent] }));
  if (velocity > FLICK_VELOCITY) {
    // A flick down from Half or lower dismisses the sheet; from higher up it goes one height down.
    const half = heights[kind === "short" ? "collapsed" : "half"];
    if (height <= half + 1) return "closed";
    const lower = list.filter((item) => item.height < height - 1).at(-1);
    return lower?.detent ?? "closed";
  }
  if (velocity < -FLICK_VELOCITY) {
    const higher = list.find((item) => item.height > height + 1);
    return higher?.detent ?? list.at(-1)!.detent;
  }
  return list.reduce((best, item) => (Math.abs(item.height - height) < Math.abs(best.height - height) ? item : best)).detent;
}
