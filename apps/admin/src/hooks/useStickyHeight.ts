import { useCallback, useRef } from "react";

/**
 * A callback ref for a sticky bar that publishes the bar's height on `<html>` as a CSS custom
 * property (`--app-bar-height` by default) and keeps it in step as the bar grows or shrinks (a
 * wrapped title, larger text). The stylesheet's `scroll-padding-top` reads it, so focus, links to
 * an anchor and find-in-page stop below the bar instead of under it.
 */
export function useStickyHeight(property = "--app-bar-height") {
  const observer = useRef<ResizeObserver | null>(null);
  return useCallback(
    (element: HTMLElement | null) => {
      const root = document.documentElement;
      observer.current?.disconnect();
      observer.current = null;
      if (!element) {
        root.style.removeProperty(property);
        return;
      }
      const publish = () =>
        root.style.setProperty(
          property,
          `${Math.ceil(element.getBoundingClientRect().height)}px`,
        );
      publish();
      if (typeof ResizeObserver === "undefined") return;
      observer.current = new ResizeObserver(publish);
      observer.current.observe(element);
    },
    [property],
  );
}
