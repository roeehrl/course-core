import React, { useEffect, useLayoutEffect, useRef } from "react";

/** The column a popover stays inside, besides the window: the lesson's, beside the companion. */
const COLUMN = ".connected-main";
const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex="0"]';

/**
 * A small anchored, non-modal dialog (280 or 320 px): the ⓘ explanations, a delete confirm, the
 * About and Unverified notes. It moves focus to `initialFocus` or its first control, closes on Esc
 * and on a click outside, and returns focus to its anchor. It sits under the anchor (above it when
 * there is no room below), inside the window with a 16 px margin and, from the lesson, inside the
 * lesson's column: it starts at the anchor's inline start, or ends at its inline end where it would
 * cross the column's end. M16.
 */
export function Popover({
  open,
  onClose,
  anchor,
  label,
  labelledBy,
  width = 280,
  initialFocus,
  className,
  children,
}: {
  open: boolean;
  onClose: () => void;
  anchor: React.RefObject<HTMLElement | null>;
  /** The dialog's name, unless `labelledBy` names an element inside it. */
  label?: string;
  labelledBy?: string;
  width?: 280 | 320;
  initialFocus?: React.RefObject<HTMLElement | null>;
  className?: string;
  children: React.ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useLayoutEffect(() => {
    if (!open) return;
    const position = () => {
      const rect = anchor.current?.getBoundingClientRect();
      const node = box.current;
      if (!rect || !node) return;
      const rtl = getComputedStyle(node).direction === "rtl";
      const w = node.offsetWidth || width;
      // Inside the window, and inside the lesson column for an anchor in the lesson, so a note
      // never runs over the companion docked beside it (16 px margins).
      const column = anchor.current?.closest(COLUMN)?.getBoundingClientRect();
      const start = Math.max(16, column ? column.left + 16 : 16);
      const end = Math.min(window.innerWidth - 16, column ? column.right - 16 : Infinity);
      // From the anchor's inline start; where that crosses the column's inline end, it ends where
      // the anchor ends instead.
      let left = rtl ? rect.right - w : rect.left;
      if (!rtl && left + w > end) left = rect.right - w;
      if (rtl && left < start) left = rect.left;
      left = Math.max(start, Math.min(left, end - w));
      const height = node.offsetHeight;
      const below = rect.bottom + 8;
      const top = below + height > window.innerHeight - 16 && rect.top - 8 - height >= 16 ? rect.top - 8 - height : below;
      // A fixed box is placed in its containing block, which is not the window inside a size
      // container (the companion panel is one): measure where 0,0 lands and correct for it.
      node.style.top = "0px";
      node.style.left = "0px";
      const origin = node.getBoundingClientRect();
      node.style.top = `${top - origin.top}px`;
      node.style.left = `${left - origin.left}px`;
      node.style.visibility = "";
    };
    position();
    // Measured while the box or a box around it still moves (a sheet opening, M16), the origin is
    // that moving box's; place it again once each such motion ends.
    if (typeof document.getAnimations === "function")
      for (const animation of document.getAnimations()) {
        const target = (animation.effect as KeyframeEffect | null)?.target;
        if (target && box.current && target.contains(box.current)) void animation.finished.then(position, position);
      }
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => {
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
    };
  }, [open, anchor, width]);
  useEffect(() => {
    if (!open) return;
    const target = initialFocus?.current ?? box.current?.querySelector<HTMLElement>(FOCUSABLE) ?? box.current;
    target?.focus({ preventScroll: true });
    const returnTo = anchor.current;
    const outside = (event: PointerEvent) => {
      const node = event.target as Node;
      if (!box.current?.contains(node) && !anchor.current?.contains(node)) closeRef.current();
    };
    document.addEventListener("pointerdown", outside, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      if (returnTo?.isConnected && (!document.activeElement || document.activeElement === document.body || box.current?.contains(document.activeElement)))
        returnTo.focus({ preventScroll: true });
    };
  }, [open, anchor, initialFocus]);
  if (!open) return null;
  return (
    <div
      ref={box}
      role="dialog"
      aria-label={labelledBy ? undefined : label}
      aria-labelledby={labelledBy}
      tabIndex={-1}
      className={["cc-ui-popover", `is-${width}`, className].filter(Boolean).join(" ")}
      style={{ visibility: "hidden" }}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
    >
      {children}
    </div>
  );
}
