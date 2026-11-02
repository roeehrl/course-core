import { useSyncExternalStore } from "react";

/** Whether a media query matches now; false where there is no `matchMedia` (React Native, server). */
export function matches(query: string): boolean {
  try {
    return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches;
  } catch {
    return false;
  }
}

/** A media query as React state: re-renders when it starts or stops matching. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (notify) => {
      if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
      const list = window.matchMedia(query);
      list.addEventListener?.("change", notify);
      return () => list.removeEventListener?.("change", notify);
    },
    () => matches(query),
    () => false,
  );
}

export const MEDIA = {
  coarse: "(pointer: coarse)", // i18n-ignore: CSS media query, never shown to people
  hoverNone: "(hover: none)", // i18n-ignore: CSS media query, never shown to people
  reducedMotion: "(prefers-reduced-motion: reduce)", // i18n-ignore: CSS media query, never shown to people
} as const;

/** A touch screen or other coarse pointer: 44 px targets, Enter makes a new line. */
export const useCoarsePointer = () => useMediaQuery(MEDIA.coarse);
/** No hover (touch): controls that appear on hover are shown all the time. */
export const useHoverNone = () => useMediaQuery(MEDIA.hoverNone);
/** `prefers-reduced-motion: reduce`: every motion falls back as §1.5 says. */
export const useReducedMotion = () => useMediaQuery(MEDIA.reducedMotion);

/**
 * A CSS time (`150ms`, `.15s`) in milliseconds; undefined when it is not one. The built
 * stylesheet is minified, which writes `150ms` as `.15s`, so the unit is always read.
 */
export function cssTime(value: string): number | undefined {
  const match = /^\s*(-?(?:\d+\.?\d*|\.\d+))(ms|s)\s*$/i.exec(value);
  if (!match) return undefined;
  const amount = Number(match[1]);
  return match[2]!.toLowerCase() === "s" ? amount * 1000 : amount;
}

/** A motion token's duration (`--motion-m10-duration`) on an element, in milliseconds. */
export function motionDuration(element: Element, name: string, fallback = 0): number {
  return cssTime(getComputedStyle(element).getPropertyValue(name)) ?? fallback;
}
