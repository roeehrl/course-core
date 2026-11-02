import React, { useLayoutEffect, useRef } from "react";
import { companionLayout } from "../domain/companionLayout";
import { companionOpen, useCompanionOpenValue } from "../connected/companion/openState";
import { CompanionDock } from "./CompanionDock.web";
import type { DemoCompanionDockProps } from "./DemoCompanionDock";

/** Where the demo's header draws the companion trigger (web): an element in the header row. */
export function DemoCompanionSlot({ onSlot }: { onSlot: (element: HTMLElement | null) => void }) {
  return <div ref={onSlot} className="connected-header-companion" />;
}

/**
 * The demo's companion on the real companion's frame (`/demo`, final design §4.19): the same
 * docked panel at the page's inline end, full height under the header, with its divider, About,
 * Expand (focus view) and Close, and the trigger in the header; a nonmodal sheet on phones,
 * tablets in portrait and short windows. The demo's own guidance and notes are its content. The
 * header runs the window's full width above the page and the panel, as the connected app's does,
 * so its trigger stays put when the panel opens or closes; only the page under it makes room for
 * the panel (layout.css), and the panel's width is kept like the real one's.
 */
export function DemoCompanionDock({ width, height, headerSlot, lessonTitle, header = null, companion, children }: DemoCompanionDockProps) {
  const layout = companionLayout(width, height);
  const docked = layout.placement === "docked";
  const host = useRef<HTMLDivElement>(null);
  const open = useCompanionOpenValue("open");
  const view = useCompanionOpenValue("view");
  // The store follows this window. The demo is a page of its own: like the course page, beside
  // it the panel shows for this visit (open at first) and is not remembered on the device.
  useLayoutEffect(() => {
    companionOpen.sync({ docked, surface: "course" });
  }, [docked]);
  // Beside the page it shows the first time the window is wide enough for it.
  const shown = useRef(false);
  useLayoutEffect(() => {
    if (!docked || shown.current) return;
    shown.current = true;
    companionOpen.open("demo", { surface: "course" });
  }, [docked]);
  useLayoutEffect(() => () => companionOpen.reset(), []);
  // The panel starts under the header, whatever height the header takes.
  useLayoutEffect(() => {
    const header = document.querySelector<HTMLElement>("[data-testid='demo-header']");
    const node = host.current;
    if (!header || !node || typeof ResizeObserver !== "function") return;
    const measure = () => {
      const value = `${Math.round(header.getBoundingClientRect().height)}px`;
      if (node.style.getPropertyValue("--cc-demo-header") !== value) node.style.setProperty("--cc-demo-header", value);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(header);
    measure();
    return () => observer.disconnect();
  }, []);
  return (
    <div
      ref={host}
      className="cc-demo-dock-host"
      data-docked={docked && open ? (view === "focus" ? "focus" : "open") : undefined}
    >
      {header}
      {/* The learning content, which the panel's divider names (`aria-controls`). */}
      <div id="connected-learning" className="cc-demo-page">{children}</div>
      {companion && (
        <CompanionDock layout={layout} headerSlot={headerSlot} {...(lessonTitle ? { lessonTitle } : {})}>
          {companion}
        </CompanionDock>
      )}
    </div>
  );
}
