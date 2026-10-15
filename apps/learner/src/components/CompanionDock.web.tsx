import React, { useLayoutEffect, useRef } from "react";
import type { CompanionDockProps } from "./CompanionDock";

/** The companion beside the lesson (a collapsible complementary pane) or, in a
 * compact or very short window, a modal sheet. The same `<aside>` and children
 * stay mounted across every change, so a draft keeps its value, focus and
 * selection when the window is resized or rotated. */
export function CompanionDock({
  wide,
  open,
  onOpenChange,
  collapsed = false,
  onCollapsedChange,
  children,
}: CompanionDockProps) {
  const returnFocus = useRef<HTMLElement | null>(null);
  const panel = useRef<HTMLElement>(null),
    trigger = useRef<HTMLButtonElement>(null),
    wasWide = useRef(wide),
    last = useRef({ wide, open, collapsed });
  last.current = { wide, open, collapsed };
  const change = useRef(onOpenChange);
  change.current = onOpenChange;
  const collapse = useRef(onCollapsedChange);
  collapse.current = onCollapsedChange;
  const hadFocus = useRef(false);
  useLayoutEffect(() => {
    // Pane -> sheet while the learner is in the companion: keep it open as a sheet.
    if (wasWide.current && !wide && hadFocus.current) change.current(true);
    // Sheet -> pane while the sheet is open: show the pane rather than hiding it.
    if (!wasWide.current && wide && last.current.open && last.current.collapsed)
      collapse.current?.(false);
    wasWide.current = wide;
  }, [wide]);
  const modal = !wide && open;
  const paneVisible = wide && !collapsed;
  // Focus follows the learner's own show/hide of the pane: to the pane when it
  // opens, back to the control that reopens it when it closes.
  const moveFocus = useRef<"panel" | "trigger" | null>(null);
  useLayoutEffect(() => {
    const target = moveFocus.current;
    moveFocus.current = null;
    if (target === "panel" && paneVisible)
      panel.current?.focus({ preventScroll: true });
    if (target === "trigger" && wide && collapsed)
      trigger.current?.focus({ preventScroll: true });
  }, [paneVisible, wide, collapsed]);
  useLayoutEffect(() => {
    if (!modal) return;
    const previous =
      returnFocus.current ?? (document.activeElement as HTMLElement | null);
    const backgrounds = Array.from(
      document.querySelectorAll<HTMLElement>("[data-connected-background]"),
    );
    const inert = backgrounds.map((node) => node.inert),
      overflow = document.body.style.overflow;
    backgrounds.forEach((node) => {
      node.inert = true;
    });
    document.body.style.overflow = "hidden";
    if (!panel.current?.contains(document.activeElement))
      panel.current?.focus();
    return () => {
      backgrounds.forEach((node, i) => {
        node.inert = inert[i] ?? false;
      });
      document.body.style.overflow = overflow;
      queueMicrotask(() => {
        if (!last.current.wide && !last.current.open) {
          const target =
            previous?.isConnected &&
            previous !== document.body &&
            !panel.current?.contains(previous)
              ? previous
              : document.querySelector<HTMLElement>(
                  ".connected-companion-trigger",
                );
          target?.focus({ preventScroll: true });
        }
      });
    };
  }, [modal]);
  function close() {
    hadFocus.current = false;
    if (wide) {
      moveFocus.current = "trigger";
      collapse.current?.(true);
    } else onOpenChange(false);
  }
  const showTrigger = wide ? collapsed : !open;
  return (
    <>
      <button
        ref={trigger}
        hidden={!showTrigger}
        className={`connected-companion-trigger ${wide ? "is-pane-toggle" : ""}`}
        type="button"
        aria-haspopup={wide ? undefined : "dialog"}
        aria-expanded={false}
        aria-controls="connected-companion"
        onClick={(event) => {
          returnFocus.current = event.currentTarget;
          if (wide) {
            moveFocus.current = "panel";
            collapse.current?.(false);
          } else onOpenChange(true);
        }}
      >
        <span aria-hidden="true">✧</span> Companion
      </button>
      {modal && (
        <div
          className="connected-drawer-backdrop"
          aria-hidden="true"
          onClick={() => {
            hadFocus.current = false;
            onOpenChange(false);
          }}
        />
      )}
      <aside
        id="connected-companion"
        ref={panel}
        className={`connected-companion-dock ${wide ? "is-panel" : "is-drawer"}`}
        hidden={wide ? !paneVisible : !open}
        role={modal ? "dialog" : "complementary"}
        aria-modal={modal ? true : undefined}
        aria-label="Your companion"
        tabIndex={-1}
        onFocusCapture={() => {
          hadFocus.current = true;
        }}
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null))
            hadFocus.current = false;
        }}
        // Capture phase: React Native Web text inputs stop key events from bubbling,
        // which would otherwise disable Escape and the focus trap inside a draft.
        onKeyDownCapture={(event) => {
          if (!modal) return;
          if (event.key === "Escape") {
            event.preventDefault();
            hadFocus.current = false;
            onOpenChange(false);
            return;
          }
          if (event.key === "Tab") {
            const items = Array.from(
              panel.current?.querySelectorAll<HTMLElement>(
                'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex="0"]',
              ) ?? [],
            ).filter(
              (el) =>
                el.getAttribute("aria-disabled") !== "true" &&
                !el.closest("[hidden]"),
            );
            const first = items[0],
              end = items.at(-1);
            if (!first) {
              event.preventDefault();
              return;
            }
            if (
              event.shiftKey &&
              (document.activeElement === first ||
                document.activeElement === panel.current)
            ) {
              event.preventDefault();
              end?.focus();
            } else if (
              !event.shiftKey &&
              (document.activeElement === end ||
                document.activeElement === panel.current)
            ) {
              event.preventDefault();
              first.focus();
            }
          }
        }}
      >
        <div className="connected-dock-title">
          <h2>
            <span aria-hidden="true">✧</span> Your companion
          </h2>
          {(!wide || onCollapsedChange) && (
            <button
              type="button"
              aria-label="Close companion"
              aria-expanded={wide ? true : undefined}
              aria-controls={wide ? "connected-companion" : undefined}
              onClick={close}
            >
              <span aria-hidden="true">✕</span>
            </button>
          )}
        </div>
        {children}
      </aside>
    </>
  );
}
