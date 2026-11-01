import React, { useEffect, useLayoutEffect, useRef, useState } from "react";

const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex="0"]';

/**
 * A small anchored, non-modal dialog (280 or 320 px): the ⓘ explanations, a delete confirm, the
 * About and Unverified notes. It moves focus to `initialFocus` or its first control, closes on Esc
 * and on a click outside, and returns focus to its anchor. It sits under the anchor (above it when
 * there is no room below), inside the window with a 16 px margin. M16.
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
  const [place, setPlace] = useState<{ top: number; left: number } | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useLayoutEffect(() => {
    if (!open) return;
    const position = () => {
      const rect = anchor.current?.getBoundingClientRect();
      const node = box.current;
      if (!rect || !node) return;
      const rtl = getComputedStyle(node).direction === "rtl";
      const room = window.innerWidth - 16;
      const w = Math.min(width, room - 16);
      let left = rtl ? rect.right - w : rect.left;
      left = Math.max(16, Math.min(left, room - w));
      const height = node.offsetHeight;
      const below = rect.bottom + 8;
      const top = below + height > window.innerHeight - 16 && rect.top - 8 - height >= 16 ? rect.top - 8 - height : below;
      setPlace({ top, left });
    };
    position();
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
      style={place ? { top: place.top, left: place.left } : { visibility: "hidden" }}
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
