import React, { useLayoutEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import { lessonReadingAnchor, restoreReadingAnchor, type ReadingAnchor } from "../readingAnchor";
import {
  clampWidth,
  dragWidth,
  forgetWidth,
  keyWidth,
  panelRange,
  readWidth,
  writeWidth,
  type PanelRange,
} from "./panelWidth";

/**
 * The divider between the lesson and the docked companion, and the handle that resizes the panel
 * (final design §2.1, G8): a 1 px line in its own grid column with a 16 px hit zone and a 4 × 32
 * grip that is always visible. A drag follows the pointer every frame and pulls to 400 and 560;
 * a double click goes back to the default. As a WAI-ARIA window splitter it takes ←/→ (16 px),
 * Shift+←/→ (64 px), Home/End and Enter (400 ↔ 560), arrows in screen direction.
 *
 * The width is written as `--panel-w` on the host element, never through React state, so a drag
 * re-renders neither the lesson nor the companion; it is kept on this device when the drag ends,
 * and the line being read in the lesson goes back to where it was (SCR-6).
 */
export function PanelSplitter({ hidden }: { hidden: boolean }) {
  const t = useT();
  const node = useRef<HTMLDivElement>(null);
  const width = useRef(0);
  const [range, setRange] = useState<PanelRange>(() => panelRange(layoutWidth()));
  const rangeRef = useRef(range);
  rangeRef.current = range;
  // The connected host, or the demo's frame (DemoCompanionDock.web.tsx).
  const host = () => node.current?.closest<HTMLElement>(".connected-host, .cc-demo-dock-host") ?? null;
  const rtl = () => (node.current ? getComputedStyle(node.current).direction === "rtl" : false);
  /** Draws a width: the host's variable and the separator's value (no React render). */
  const draw = (value: number) => {
    width.current = value;
    host()?.style.setProperty("--panel-w", `${value}px`);
    node.current?.setAttribute("aria-valuenow", String(value));
  };
  /** A width the learner chose: drawn, kept on this device, and the lesson put back in place. */
  const commit = (value: number, anchor: ReadingAnchor | null) => {
    draw(value);
    writeWidth(value);
    if (anchor) requestAnimationFrame(() => restoreReadingAnchor(anchor));
  };
  // The window's width sets the range; the remembered width is kept inside it.
  useLayoutEffect(() => {
    const fit = () => {
      const next = panelRange(layoutWidth());
      const current = rangeRef.current;
      if (next.min !== current.min || next.max !== current.max || next.default !== current.default) setRange(next);
      draw(clampWidth(readWidth() ?? next.default, next));
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);
  useLayoutEffect(
    () => () => {
      node.current?.closest<HTMLElement>(".connected-host, .cc-demo-dock-host")?.style.removeProperty("--panel-w");
    },
    [],
  );

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const element = event.currentTarget;
    element.setPointerCapture?.(event.pointerId);
    const start = { x: event.clientX, width: width.current, anchor: lessonReadingAnchor(), right: rtl() };
    let frame = 0,
      x = start.x;
    element.dataset.dragging = "true";
    const move = (moved: PointerEvent) => {
      x = moved.clientX;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => draw(dragWidth(start.width, x - start.x, start.right, rangeRef.current)));
    };
    const up = () => {
      cancelAnimationFrame(frame);
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerup", up);
      element.removeEventListener("pointercancel", up);
      delete element.dataset.dragging;
      const value = dragWidth(start.width, x - start.x, start.right, rangeRef.current);
      if (value !== start.width) commit(value, start.anchor);
    };
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerup", up);
    element.addEventListener("pointercancel", up);
  };

  return (
    <div
      ref={node}
      className="cc-shell-splitter"
      hidden={hidden}
      role="separator"
      tabIndex={0}
      aria-label={t("panelSplitter.label")}
      aria-orientation="vertical"
      aria-controls="connected-learning"
      aria-valuemin={range.min}
      aria-valuemax={range.max}
      aria-valuenow={width.current || range.default}
      onPointerDown={onPointerDown}
      onDoubleClick={() => {
        const anchor = lessonReadingAnchor();
        forgetWidth();
        draw(rangeRef.current.default);
        requestAnimationFrame(() => anchor && restoreReadingAnchor(anchor));
      }}
      onKeyDown={(event) => {
        const next = keyWidth(width.current, event, rtl(), rangeRef.current);
        if (next === null) return;
        event.preventDefault();
        if (next !== width.current) commit(next, lessonReadingAnchor());
      }}
    />
  );
}

/** The window's layout width (no scrollbar). */
function layoutWidth() {
  return typeof document === "undefined" ? 0 : document.documentElement.clientWidth;
}
