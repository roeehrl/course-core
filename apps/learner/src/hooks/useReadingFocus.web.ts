import { useEffect, type RefObject } from "react";
import type { ScrollView, View } from "react-native";
export function useReadingFocus(
  routeKey: string,
  scroll: RefObject<ScrollView | null>,
  _content: RefObject<View | null>,
) {
  useEffect(() => {
    scroll.current?.scrollTo({ y: 0, animated: false });
    const heading = document.querySelector<HTMLElement>(
      '#learning-content [role="heading"]',
    );
    heading?.setAttribute("tabindex", "-1");
    if (heading) heading.style.outline = "none";
    heading?.focus({ preventScroll: true });
  }, [routeKey, scroll]);
}
