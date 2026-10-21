import React, { useEffect, useRef } from "react";

/** Interactive parts of a lesson whose use holds a waiting personal change back (E03). */
export type PresenceKind = "activity" | "simulation" | "component";
export type PresenceState = "open" | "closed";
/** Sends one presence report; `leaving` asks for a request that survives the page unloading. */
export type ReportPresence = (blockId: string, kind: PresenceKind, state: PresenceState, leaving?: boolean) => void;

/** How often an open part is reported again while it stays in view. The server lets a report
 * lapse after 90 seconds without a repeat (services/api/src/activity-presence.ts). */
export const PRESENCE_REPEAT_MS = 45_000;

/**
 * The learner is working in a part of the lesson from their first interaction with it (a press,
 * a key, an edit) until they leave it: it scrolls out of view, the tab is hidden, the page is left,
 * the part is finished or it unmounts. While they are in it, a personal change to this lesson waits
 * (the server's safe-boundary rule) and the app repeats the report every PRESENCE_REPEAT_MS. Just
 * reading past a part never counts. Reports are best effort and never block the lesson.
 */
export function usePresence(element: React.RefObject<HTMLElement | null>, report: ((state: PresenceState, leaving?: boolean) => void) | undefined, done = false) {
  const reporter = useRef(report);
  reporter.current = report;
  useEffect(() => {
    const node = element.current;
    if (!node || !reporter.current || done) return;
    let engaged = false, visible = true;
    let timer: ReturnType<typeof setInterval> | undefined;
    const send = (state: PresenceState, leaving = false) => {
      try {
        reporter.current?.(state, leaving);
      } catch {
        // A lost report only means a change may wait a little longer, or land a little sooner.
      }
    };
    const leave = (leaving = false) => {
      if (!engaged) return;
      engaged = false;
      clearInterval(timer);
      send("closed", leaving);
    };
    const engage = () => {
      if (engaged || !visible || document.visibilityState === "hidden") return;
      engaged = true;
      send("open");
      timer = setInterval(() => (document.visibilityState === "hidden" ? leave() : send("open")), PRESENCE_REPEAT_MS);
    };
    const observer =
      typeof IntersectionObserver === "undefined"
        ? undefined
        : new IntersectionObserver((entries) => {
            visible = entries.some((entry) => entry.isIntersecting);
            if (!visible) leave();
          });
    observer?.observe(node);
    const hidden = () => document.visibilityState === "hidden" && leave(true);
    const pagehide = () => leave(true);
    const events = ["pointerdown", "keydown", "input", "change"] as const;
    for (const name of events) node.addEventListener(name, engage, { passive: true });
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", pagehide);
    return () => {
      for (const name of events) node.removeEventListener(name, engage);
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("pagehide", pagehide);
      observer?.disconnect();
      leave(true);
    };
  }, [element, done, Boolean(report)]);
}

/** A wrapper that reports the learner's use of the part inside it (see usePresence). */
export function PresenceRegion({
  blockId,
  kind,
  report,
  done = false,
  children,
}: {
  blockId: string;
  kind: PresenceKind;
  report: ReportPresence | undefined;
  done?: boolean;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  usePresence(ref, report && ((state, leaving) => report(blockId, kind, state, leaving)), done);
  return (
    <div ref={ref} className="connected-presence" data-presence-block={blockId}>
      {children}
    </div>
  );
}
