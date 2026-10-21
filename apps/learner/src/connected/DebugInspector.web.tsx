import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { WindowClass } from "../domain/windowClass";
import { openInspectorBridge } from "../client/inspectorBridge";
import { inspectorUrl, type InspectorAccess } from "../client/inspectorClient";
import { useT } from "../i18n";

export interface DebugInspectorProps {
  /** From the server; the entry renders nothing unless it says the inspector is available. */
  access: InspectorAccess;
  enrollmentId: string;
  episodeId: string;
  /** The part of the lesson the learner is on now, opened first. */
  blockId?: string | undefined;
  windowSize: WindowClass;
}

/**
 * The authorized debug inspector, reachable from the current activity (U01, I04). Secondary and
 * never part of the required learning path: an owner or admin opens it beside the lesson. It is
 * a side panel on expanded windows, a pane under the lesson on medium ones, and a full-screen
 * dialog on compact ones; the lesson stays mounted under it, so closing resumes where it was.
 *
 * The panel frames the inspector page (/admin/inspector) of the admin app: the same inspector,
 * routes and permissions as the read-only learner view. Each open loads it again, and the
 * server records each load as a staff view the learner can see.
 */
export function DebugInspector({ access, enrollmentId, episodeId, blockId, windowSize }: DebugInspectorProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  // The part open when the panel opened: later moves in the lesson do not reload (and re-record) it.
  const openedBlock = useRef(blockId);
  const modal = windowSize === "compact";
  const close = useRef(() => {
    setOpen(false);
    queueMicrotask(() => trigger.current?.focus({ preventScroll: true }));
  });
  // The frame closes the panel through this window's bridge (Escape inside it, for example).
  useEffect(() => (open ? openInspectorBridge(close.current) : undefined), [open]);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") close.current(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  // Full screen on compact windows: the rest of the page is inert until it closes.
  useLayoutEffect(() => {
    if (!open || !modal) return;
    const backgrounds = Array.from(document.querySelectorAll<HTMLElement>("[data-connected-background]"));
    const inert = backgrounds.map((node) => node.inert), overflow = document.body.style.overflow;
    backgrounds.forEach((node) => { node.inert = true; });
    document.body.style.overflow = "hidden";
    return () => {
      backgrounds.forEach((node, i) => { node.inert = inert[i] ?? false; });
      document.body.style.overflow = overflow;
    };
  }, [open, modal]);
  useLayoutEffect(() => { if (open) panel.current?.focus({ preventScroll: true }); }, [open]);
  if (!access.available) return null;
  const placement = windowSize === "expanded" ? "is-side" : windowSize === "medium" ? "is-pane" : "is-full";
  const src = inspectorUrl(access.path, { enrollmentId, episodeId, blockId: openedBlock.current });
  return (
    <>
      <div className="connected-debug-entry">
        <button
          ref={trigger}
          type="button"
          className="connected-debug-trigger"
          aria-haspopup={modal ? "dialog" : undefined}
          aria-expanded={open}
          aria-controls="connected-debug-inspector"
          onClick={() => { openedBlock.current = blockId; setOpen((value) => !value); }}
        >
          {open ? t("debugInspector.close") : t("debugInspector.open")}
        </button>
        <span className="connected-muted">{t("debugInspector.notice")}</span>
      </div>
      {open && createPortal(
        <section
          ref={panel}
          id="connected-debug-inspector"
          className={`connected-inspector ${placement}`}
          tabIndex={-1}
          {...(modal ? { role: "dialog", "aria-modal": true } : { role: "complementary" })}
          aria-label={t("debugInspector.title")}
          data-placement={placement}
        >
          <div className="connected-inspector-title">
            <h2>{t("debugInspector.title")}</h2>
            <button type="button" aria-label={t("debugInspector.closeLabel")} onClick={close.current}>✕</button>
          </div>
          <iframe className="connected-inspector-frame" title={t("debugInspector.frame")} src={src} />
        </section>,
        // Outside the lesson, which turns inert under the full-screen dialog.
        trigger.current?.closest<HTMLElement>(".connected-host") ?? document.body,
      )}
    </>
  );
}
