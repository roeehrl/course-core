import React, { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n";
import { colors } from "./ui";
import type { OverlayProps } from "./Overlay";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]';

/**
 * A side sheet at the inline end of the window (full screen on phones). DOM concerns are
 * isolated here; the shared learning UI uses native primitives.
 *
 * The sheet's head stays put: the title (when `titleVisible`) and a close button that shows an
 * icon only, its name ("Close Change password") given to assistive technology. The body
 * scrolls, inside the safe area; a form's actions at the end of it stay in view (connected.css).
 * Opening and closing never move the page behind: the page's place is noted when the sheet
 * opens, focus goes back to the control that opened it without scrolling, and the place is put
 * back if anything moved it.
 */
export function Overlay({ title, titleVisible = false, onClose, children }: OverlayProps) {
  const { t, dir } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  // While part of the body is below its bottom edge, the actions kept there show a divider.
  useEffect(() => {
    const element = body.current;
    if (!element) return;
    const update = () =>
      element.toggleAttribute("data-more-below", element.scrollTop + element.clientHeight < element.scrollHeight - 1);
    update();
    element.addEventListener("scroll", update, { passive: true });
    const sizes = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    sizes?.observe(element);
    if (element.firstElementChild) sizes?.observe(element.firstElementChild);
    return () => {
      element.removeEventListener("scroll", update);
      sizes?.disconnect();
    };
  }, []);
  const titleId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const root = document.getElementById("root");
    const wasInert = root?.inert;
    const html = document.documentElement;
    const overflow = document.body.style.overflow,
      gutter = html.style.scrollbarGutter;
    const left = window.scrollX,
      top = window.scrollY;
    if (root) root.inert = true;
    // Where the window shows a classic scrollbar, its space stays reserved while scrolling is
    // locked, so the page behind does not shift sideways.
    if (window.innerWidth - html.clientWidth > 0) html.style.scrollbarGutter = "stable";
    document.body.style.overflow = "hidden";
    ref.current?.focus({ preventScroll: true });
    // Escape is heard on the document: a button that becomes disabled while it works (Add a
    // passkey, say) drops focus to the page body, outside the sheet.
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      event.preventDefault();
      closeRef.current();
    };
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("keydown", escape);
      if (root) root.inert = !!wasInert;
      document.body.style.overflow = overflow;
      html.style.scrollbarGutter = gutter;
      // The opener is often in the sticky header: plain focus() scrolled the page up to clear
      // the header's scroll padding.
      if (previous?.isConnected) previous.focus({ preventScroll: true });
      if (Math.round(window.scrollX) !== Math.round(left) || Math.round(window.scrollY) !== Math.round(top))
        window.scrollTo({ left, top, behavior: "instant" });
    };
  }, []);
  const closeLabel = t("overlay.close", { title });
  return createPortal(
    <div
      className="learner-sheet-backdrop"
      style={{
        position: "fixed",
        inset: 0,
        background: "#18323766",
        display: "flex",
        justifyContent: "flex-end",
        zIndex: 1000,
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) closeRef.current();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        {...(titleVisible ? { "aria-labelledby": titleId } : { "aria-label": title })}
        tabIndex={-1}
        className="learner-sheet"
        onKeyDown={(event) => {
          if (event.key !== "Tab") return;
          // Hidden fields (a username kept for password managers) cannot take focus, so they
          // are neither end of the cycle.
          const items = Array.from(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter(
            (item) => item.getAttribute("aria-disabled") !== "true" && !item.closest("[hidden]"),
          );
          const first = items[0],
            last = items.at(-1);
          if (!first) {
            event.preventDefault();
            return;
          }
          if (event.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === ref.current)) {
            event.preventDefault();
            first.focus();
          }
        }}
        style={{
          background: colors.paper,
          color: colors.ink,
          // The host's type for the sheet's own head (the page's content keeps its own).
          fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
          width: "min(480px, 100%)",
          height: "100%",
          maxHeight: "100dvh",
          display: "flex",
          flexDirection: "column",
          boxSizing: "border-box",
          outline: "none",
          // The sheet sits at the inline end; its shadow falls toward the page.
          boxShadow: `${dir === "rtl" ? 16 : -16}px 0 60px #18323722`,
        }}
      >
        <div
          className="learner-sheet-head"
          style={{
            flex: "none",
            display: "flex",
            alignItems: "center",
            gap: 12,
            paddingBlock: "max(14px, env(safe-area-inset-top)) 6px",
            paddingInline: "24px 14px",
          }}
        >
          {titleVisible && (
            <h2
              id={titleId}
              className="learner-sheet-title"
              style={{ flex: "1 1 auto", minWidth: 0, margin: 0, fontSize: 22, lineHeight: 1.3, fontWeight: 700 }}
            >
              {title}
            </h2>
          )}
          <button
            type="button"
            className="learner-sheet-close"
            aria-label={closeLabel}
            title={closeLabel}
            onClick={onClose}
            style={{
              flex: "none",
              marginInlineStart: "auto",
              width: 44,
              height: 44,
              display: "inline-grid",
              placeItems: "center",
              padding: 0,
              border: 0,
              borderRadius: 999,
              background: "transparent",
              color: colors.ink,
              cursor: "pointer",
            }}
          >
            <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </button>
        </div>
        <div
          ref={body}
          className="learner-sheet-body"
          style={{
            // The bottom padding, also covered by a form's actions kept at the bottom edge.
            ["--sheet-pad-end" as string]: "max(24px, env(safe-area-inset-bottom))",
            flex: "1 1 auto",
            minHeight: 0,
            overflowY: "auto",
            overscrollBehavior: "contain",
            paddingBlock: "4px var(--sheet-pad-end)",
            paddingLeft: "max(24px, env(safe-area-inset-left))",
            paddingRight: "max(24px, env(safe-area-inset-right))",
          }}
        >
          {children}
        </div>
      </div>
    </div>,
    document.body,
  );
}
