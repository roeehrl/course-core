/**
 * Rows of tabs or views that scroll sideways (the "On this page" bar, view switches) fade at an
 * edge while more of the row is past it, on either side, so a tab cut by the edge reads as "there
 * is more" rather than as clipped. One document-level watcher marks each row with
 * `data-fade-start` / `data-fade-end` (the reading start and end: right to left in Hebrew), and
 * styles.css draws the fades.
 */
export const SCROLL_ROWS = ".section-nav :is(ol, ul), nav.segmented";

/** Marks one row from its scroll position. Right-to-left rows scroll to negative positions. */
export function markScrollFades(row: Element) {
  const room = row.scrollWidth - row.clientWidth;
  const position = Math.abs(row.scrollLeft);
  row.toggleAttribute("data-fade-start", room > 1 && position > 1);
  row.toggleAttribute("data-fade-end", room > 1 && position < room - 1);
}

export function installScrollFades(root: Document = document) {
  if (typeof window === "undefined" || !root.body) return;
  const watched = new WeakSet<Element>();
  const resized =
    typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver((entries) => {
          for (const entry of entries) markScrollFades(entry.target);
        });
  const scan = () => {
    for (const row of Array.from(root.querySelectorAll(SCROLL_ROWS))) {
      if (!watched.has(row)) {
        watched.add(row);
        resized?.observe(row);
      }
      markScrollFades(row);
    }
  };
  root.addEventListener(
    "scroll",
    (event) => {
      const target = event.target;
      if (target instanceof Element && target.matches(SCROLL_ROWS))
        markScrollFades(target);
    },
    { capture: true, passive: true },
  );
  window.addEventListener("resize", scan, { passive: true });
  let frame = 0;
  new MutationObserver(() => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(scan);
  }).observe(root.body, { childList: true, subtree: true });
  scan();
}
