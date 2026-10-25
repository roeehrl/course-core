import { useLayoutEffect, useState, type RefObject } from "react";

/** Whether an element's content is wider than the element, so it scrolls sideways (a table or a
 * display formula in the narrow companion pane). Updated as either one changes size. */
export function useSidewaysOverflow(ref: RefObject<HTMLElement | null>, enabled = true): boolean {
  const [overflowing, setOverflowing] = useState(false);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!enabled || !element || typeof ResizeObserver !== "function") return;
    const update = () => setOverflowing(element.scrollWidth > element.clientWidth + 1);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    for (const child of Array.from(element.children)) observer.observe(child);
    return () => observer.disconnect();
  }, [ref, enabled]);
  return overflowing;
}
