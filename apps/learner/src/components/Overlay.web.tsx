import React, { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n";
import { Button, colors } from "./ui";
import type { OverlayProps } from "./Overlay";

/** DOM concerns are isolated here; the shared learning UI uses native primitives. */
export function Overlay({ title, onClose, children }: OverlayProps) {
  const { t, dir } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const root = document.getElementById("root");
    const wasInert = root?.inert;
    const overflow = document.body.style.overflow;
    if (root) root.inert = true;
    document.body.style.overflow = "hidden";
    ref.current?.focus();
    return () => {
      if (root) root.inert = !!wasInert;
      document.body.style.overflow = overflow;
      previous?.focus();
    };
  }, []);
  return createPortal(
    <div
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
        aria-label={title}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            closeRef.current();
          }
          if (event.key === "Tab") {
            const items = Array.from(
              ref.current?.querySelectorAll<HTMLElement>(
                'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex="0"]',
              ) ?? [],
            ).filter((item) => item.getAttribute("aria-disabled") !== "true");
            const first = items[0],
              last = items.at(-1);
            if (!first) {
              event.preventDefault();
              return;
            }
            if (
              event.shiftKey &&
              (document.activeElement === first ||
                document.activeElement === ref.current)
            ) {
              event.preventDefault();
              last?.focus();
            } else if (
              !event.shiftKey &&
              (document.activeElement === last ||
                document.activeElement === ref.current)
            ) {
              event.preventDefault();
              first.focus();
            }
          }
        }}
        style={{
          background: colors.paper,
          width: "min(480px, 100%)",
          height: "100%",
          overflowY: "auto",
          padding: "24px",
          boxSizing: "border-box",
          outline: "none",
          // The sheet sits at the inline end; its shadow falls toward the page.
          boxShadow: `${dir === "rtl" ? 16 : -16}px 0 60px #18323722`,
        }}
      >
        <Button label={t("overlay.close", { title })} onPress={onClose} kind="quiet" />
        {children}
      </div>
    </div>,
    document.body,
  );
}
