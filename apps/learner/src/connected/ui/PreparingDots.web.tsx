import React, { useEffect, useState } from "react";
import type { PreparingDotsProps } from "./PreparingDots";

export type { PreparingDotsProps } from "./PreparingDots";

/** After this long the dots stop pulsing (no loop runs longer than 15 s unattended, §1.5). */
export const DOTS_STATIC_AFTER_MS = 15_000;

/**
 * Three 6 px dots, staggered 160 ms on a 1.2 s cycle (M5). They go still after 15 s, and are drawn
 * still at 60 % with reduced motion and in `CanvasText` with forced colours (primitives.css).
 */
export function PreparingDots({ label, className }: PreparingDotsProps) {
  const [still, setStill] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setStill(true), DOTS_STATIC_AFTER_MS);
    return () => clearTimeout(timer);
  }, []);
  return (
    <span
      className={["cc-ui-dots", still ? "is-still" : "", className].filter(Boolean).join(" ")}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <span />
      <span />
      <span />
    </span>
  );
}
