import React, { useLayoutEffect, useRef } from "react";
import type { CompanionDockProps } from "./CompanionDock";
export function CompanionDock({
  wide,
  open,
  onOpenChange,
  children,
}: CompanionDockProps) {
  const returnFocus = useRef<HTMLElement | null>(null);
  const panel = useRef<HTMLElement>(null),
    wasWide = useRef(wide),
    last = useRef({ wide, open });
  last.current = { wide, open };
  const change = useRef(onOpenChange);
  change.current = onOpenChange;
  const hadFocus = useRef(false);
  useLayoutEffect(() => {
    if (wasWide.current && !wide && hadFocus.current) change.current(true);
    wasWide.current = wide;
  }, [wide]);
  const modal = !wide && open;
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
  return (
    <>
      {
        <button
          hidden={wide || open}
          className="connected-companion-trigger"
          type="button"
          aria-haspopup="dialog"
          aria-expanded={false}
          aria-controls="connected-companion"
          onClick={(event) => {
            returnFocus.current = event.currentTarget;
            onOpenChange(true);
          }}
        >
          <span aria-hidden="true">✧</span> Companion
        </button>
      }
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
        hidden={!wide && !open}
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
        onKeyDown={(event) => {
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
          {!wide && (
            <button
              type="button"
              aria-label="Close companion"
              onClick={() => {
                hadFocus.current = false;
                onOpenChange(false);
              }}
            >
              ✕
            </button>
          )}
        </div>
        {children}
      </aside>
    </>
  );
}
