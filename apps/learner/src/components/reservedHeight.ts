import { useRef } from "react";
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
