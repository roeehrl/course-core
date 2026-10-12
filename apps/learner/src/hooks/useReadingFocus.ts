import { useEffect, type RefObject } from "react";
import {
  AccessibilityInfo,
  findNodeHandle,
  type ScrollView,
  type View,
} from "react-native";
export function useReadingFocus(
  routeKey: string,
  scroll: RefObject<ScrollView | null>,
  content: RefObject<View | null>,
) {
  useEffect(() => {
    scroll.current?.scrollTo({ y: 0, animated: false });
    const handle = findNodeHandle(content.current);
    if (handle) AccessibilityInfo.setAccessibilityFocus(handle);
  }, [routeKey, scroll, content]);
}
