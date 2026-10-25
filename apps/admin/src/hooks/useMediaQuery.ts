import { useCallback, useSyncExternalStore } from "react";

/**
 * Window widths where the administration changes its frame. At `WIDE_MIN_WIDTH` and above the
 * navigation is the persistent sidebar; below it a compact top app bar opens the navigation as a
 * drawer. Below `PHONE_MAX_WIDTH` the course picker and refresh move from the bar into the
 * drawer, so the bar keeps room for the section name. The stylesheet uses the same numbers.
 */
export const WIDE_MIN_WIDTH = 1100;
export const PHONE_MAX_WIDTH = 719;

const noMatchMedia = () =>
  typeof window === "undefined" || typeof window.matchMedia !== "function";

/** Whether a media query matches now, kept in step as the window changes. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (notify: () => void) => {
      if (noMatchMedia()) return () => {};
      const list = window.matchMedia(query);
      list.addEventListener("change", notify);
      return () => list.removeEventListener("change", notify);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => !noMatchMedia() && window.matchMedia(query).matches,
    () => false,
  );
}

export type FrameLayout = "wide" | "tablet" | "phone";
/**
 * The administration frame for the current window. Without media query support (a test
 * environment, for example) it is the wide frame.
 */
export function useFrameLayout(): FrameLayout {
  // i18n-ignore: a media query, never shown to people
  const compact = useMediaQuery(`(max-width: ${WIDE_MIN_WIDTH - 0.02}px)`);
  // i18n-ignore: a media query, never shown to people
  const phone = useMediaQuery(`(max-width: ${PHONE_MAX_WIDTH + 0.98}px)`);
  return !compact ? "wide" : phone ? "phone" : "tablet";
}
