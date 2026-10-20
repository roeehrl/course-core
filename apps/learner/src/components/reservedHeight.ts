import { useLayoutEffect, useRef } from "react";
import { useWindowDimensions, type LayoutChangeEvent } from "react-native";

// Heights only, keyed by panel, enrollment and window width; nothing private.
const settledHeights = new Map<string, number>();

/** Keeps a data-dependent panel at the height it last settled at (for the same
 * key and window width) while it loads again, for example when the learner
 * reopens their profile. Its loaded size depends on the learner's data, so the
 * first load in a session cannot be reserved and still grows. Only the first
 * layout after each load is remembered: a disclosure the learner opens later
 * is closed again on the next mount and must not inflate the reservation. */
export function useReservedHeight(key: string, settled: boolean) {
  const { width } = useWindowDimensions();
  const slot = `${key}:${Math.round(width)}`;
  const recorded = useRef(false);
  if (!settled) recorded.current = false;
  return {
    minHeight: settled ? undefined : settledHeights.get(slot),
    onLayout(event: LayoutChangeEvent) {
      if (!settled || recorded.current) return;
      recorded.current = true;
      settledHeights.set(slot, event.nativeEvent.layout.height);
    },
  };
}

/** The web (DOM) form of useReservedHeight for panels rendered as HTML: attach
 * `ref` to the element and apply `minHeight` to its style. */
export function useReservedBlock<T extends HTMLElement>(
  key: string,
  settled: boolean,
) {
  const { width } = useWindowDimensions();
  const slot = `${key}:${Math.round(width)}`;
  const ref = useRef<T>(null);
  const recorded = useRef(false);
  if (!settled) recorded.current = false;
  useLayoutEffect(() => {
    if (!settled || recorded.current || !ref.current) return;
    recorded.current = true;
    settledHeights.set(slot, ref.current.getBoundingClientRect().height);
  });
  return { ref, minHeight: settled ? undefined : settledHeights.get(slot) };
}

const shownPanels = new Map<string, boolean>();
/** Whether an optional panel was shown when it last settled in this session. */
export const wasShown = (key: string) => shownPanels.get(key);
export const rememberShown = (key: string, shown: boolean) => {
  shownPanels.set(key, shown);
};
