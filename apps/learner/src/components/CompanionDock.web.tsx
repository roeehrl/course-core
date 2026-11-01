import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CompanionDockProps } from "./CompanionDock";
import { useT } from "../i18n";
import { companionOpen, useCompanionOpenState } from "../connected/companion/openState";
import { companionBridge } from "../connected/companion/bridge";
import { CompanionTrigger } from "../connected/companion/CompanionTrigger.web";
import { CompanionHeader } from "../connected/companion/CompanionHeader.web";
import { PanelSplitter } from "../connected/companion/PanelSplitter.web";
import { CollapsedBar, revealAnchorThenFull, useSheet } from "../connected/companion/CompanionSheet.web";
import { useCompanionShortcut } from "../connected/companion/shortcut";
import { validDetent } from "../connected/companion/sheetDetents";
import { isEditable } from "../connected/layoutViewport";

/**
 * The companion's frame (final design §2): a panel flush at the lesson's inline end with a
 * resizable divider, focus view (the companion takes the page under the header), or a nonmodal
 * bottom sheet on phones, tablets in portrait and short windows. One `<aside>`, always the
 * `complementary` region named "Your companion", stays mounted across every change with the same
 * children, so a draft keeps its value, focus and selection when the window is resized or rotated.
 * Whether it is open, its view and its height come from the companion's open state
 * (connected/companion/openState.ts); the trigger is in the app header.
 *
 * The aside is a column: the header (sticky at its top), then `cc-shell-body`, which fills the rest
 * and holds the conversation. Escape is decided after the conversation had its say (capture phase,
 * because React Native Web text inputs stop key events bubbling): a key something inside used
 * (a menu, a popover, a confirm) is left alone; otherwise it stops a reply being written, then
 * leaves focus view, then closes.
 */
export function CompanionDock({ layout, headerSlot = null, lessonTitle, children }: CompanionDockProps) {
  const t = useT();
  const docked = layout.placement === "docked";
  const kind = docked ? null : layout.sheet ?? "phone";
  const state = useCompanionOpenState();
  const open = state.open;
  const view = docked ? state.view : "docked";
  const detent = kind ? validDetent(kind, state.detent) : state.detent;
  const panel = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const hadFocus = useRef(false);
  const wasDocked = useRef(docked);
  useCompanionShortcut();
  useLayoutEffect(() => companionOpen.setSheet(kind), [kind]);
  // Docked -> sheet while the learner is in the companion: it stays open as a sheet. Sheet ->
  // docked while the sheet is open: the panel shows rather than hiding it.
  useLayoutEffect(() => {
    const before = wasDocked.current;
    wasDocked.current = docked;
    if (before === docked) return;
    if (before && !docked && hadFocus.current) companionOpen.setSheetOpen(true);
    if (!before && docked && companionOpen.get().sheetOpen && !companionOpen.get().paneOpen) companionOpen.setPaneOpen(true);
  }, [docked]);

  // Focus follows the learner's own open and close: into the companion when they open it with the
  // trigger or the shortcut, back to the trigger whenever it closes with focus inside it (heard
  // from the store before React hides it).
  const moveFocus = useRef<"panel" | "trigger" | null>(null);
  useEffect(() => {
    let was = companionOpen.get();
    return companionOpen.subscribe(() => {
      const now = companionOpen.get();
      // A change of layout (panel to sheet) is not the learner closing it.
      const sameLayout = now.docked === was.docked;
      if (now.open && !was.open && ["trigger", "shortcut"].includes(companionOpen.openedBy() ?? "")) moveFocus.current = "panel";
      if (!now.open && was.open && sameLayout && panel.current?.contains(document.activeElement)) moveFocus.current = "trigger";
      was = now;
    });
  }, []);
  // M9 plays when the learner opens the panel, not when a page loads with it open (heard from the
  // store, which says whether an action or the layout opened it).
  const entering = useRef(false);
  useEffect(
    () =>
      companionOpen.subscribe(() => {
        if (companionOpen.get().open && companionOpen.lastChange() === "action") entering.current = true;
      }),
    [],
  );
  const shownBefore = useRef(open);
  useLayoutEffect(() => {
    const aside = panel.current;
    const opening = open && !shownBefore.current && entering.current;
    shownBefore.current = open;
    entering.current = false;
    if (!aside || !opening || !docked) return;
    aside.dataset.entering = "true";
    const done = () => delete aside.dataset.entering;
    aside.addEventListener("animationend", done, { once: true });
    const timer = setTimeout(done, 1000);
    return () => clearTimeout(timer);
  }, [open, docked]);
  useLayoutEffect(() => {
    const target = moveFocus.current;
    moveFocus.current = null;
    if (target === "panel" && open && !panel.current?.contains(document.activeElement)) panel.current?.focus({ preventScroll: true });
    if (target === "trigger" && !open) trigger.current?.focus({ preventScroll: true });
  }, [open]);
  function close() {
    hadFocus.current = false;
    companionOpen.close();
  }
  useExitMotion(panel, docked, open);

  // Focus view: the host hides the lesson; its scroll is kept here and put back on the way out.
  // It is read when the store changes, before React hides the lesson (which would clamp it).
  const lessonScroll = useRef<number | null>(null);
  useEffect(() => {
    let before = companionOpen.get().view;
    return companionOpen.subscribe(() => {
      const next = companionOpen.get().view;
      if (before !== "focus" && next === "focus") lessonScroll.current = window.scrollY;
      before = next;
    });
  }, []);
  const [title, setTitle] = useState(lessonTitle);
  useLayoutEffect(() => {
    if (view !== "focus") {
      const top = lessonScroll.current;
      if (top !== null && Math.round(window.scrollY) !== Math.round(top)) window.scrollTo({ top, behavior: "instant" as ScrollBehavior });
      lessonScroll.current = null;
      return;
    }
    setTitle(lessonTitle ?? document.querySelector(".connected-main h1")?.textContent?.trim() ?? undefined);
  }, [view, lessonTitle]);
  const enterFocus = () => companionOpen.setView("focus");
  const leaveFocus = () => {
    companionOpen.setView("docked");
    // The button that left is gone; focus goes to Expand, which took its place in the header.
    requestAnimationFrame(() => panel.current?.querySelector<HTMLElement>("[data-companion-expand]")?.focus({ preventScroll: true }));
  };
  // M11: the companion's content crossfades between focus view and beside the lesson.
  const viewSeen = useRef(view);
  useLayoutEffect(() => {
    if (viewSeen.current === view) return;
    viewSeen.current = view;
    const body = panel.current;
    if (!body || typeof body.animate !== "function") return;
    const style = getComputedStyle(body);
    const duration = parseFloat(style.getPropertyValue("--motion-m11-duration")) || 0;
    if (duration) body.animate([{ opacity: 0 }, { opacity: 1 }], { duration, easing: style.getPropertyValue("--motion-m11-easing").trim() || "ease" });
  }, [view]);

  useSheet(panel, { kind, open, detent, onDismiss: close });
  // The thread's own scroll draws the header's hairline; until it has one, the aside's does.
  useEffect(() => {
    const aside = panel.current;
    if (!aside) return;
    const scrolled = () => {
      const away = aside.scrollTop > 0;
      if ((aside.dataset.scrolled === "true") !== away) aside.dataset.scrolled = String(away);
    };
    aside.addEventListener("scroll", scrolled, { passive: true });
    return () => aside.removeEventListener("scroll", scrolled);
  }, []);

  const variant = kind ? "sheet" : view === "focus" ? "focus" : "panel";
  return (
    <>
      <CompanionTrigger
        ref={trigger}
        open={open}
        slot={headerSlot}
        onToggle={() => (open ? close() : companionOpen.open("trigger"))}
      />
      {docked && view === "docked" && <PanelSplitter hidden={!open} />}
      <aside
        id="connected-companion"
        ref={panel}
        data-usability="ignore"
        className={`connected-companion-dock ${kind ? `is-sheet is-${kind}` : view === "focus" ? "is-focus" : "is-panel"}`}
        data-placement={kind ? "sheet" : "docked"}
        data-view={view}
        data-detent={kind ? detent : undefined}
        hidden={!open}
        aria-label={t("companionDock.label")}
        tabIndex={-1}
        onFocusCapture={(event) => {
          hadFocus.current = true;
          // G6: the message box at Half first shows the lesson part being asked about, then Full.
          if (kind && kind !== "short" && detent === "half" && isEditable(event.target as Element)) revealAnchorThenFull(kind);
        }}
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) hadFocus.current = false;
        }}
        onKeyDownCapture={(event) => {
          if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
          const native = event.nativeEvent;
          // Decided after the event has been everywhere it goes.
          setTimeout(() => {
            if (native.defaultPrevented) return;
            if (companionBridge.stopRunningReply()) return;
            if (companionOpen.get().view === "focus") return leaveFocus();
            close();
          }, 0);
        }}
      >
        {open && kind && detent === "collapsed" ? (
          <CollapsedBar kind={kind} />
        ) : (
          <CompanionHeader
            variant={variant}
            lessonTitle={title}
            sheet={kind}
            detent={detent}
            onClose={close}
            onExpand={enterFocus}
            onBeside={leaveFocus}
          />
        )}
        <div className="cc-shell-body">{children}</div>
      </aside>
    </>
  );
}

/**
 * M10 and M12 on the way out: the closed aside is drawn once more where it was and fades (beside
 * the lesson, toward the inline end) or slides down (a sheet), then hides. Nothing in it can be
 * pressed or read meanwhile, and the lesson beside it has already taken its width.
 */
function useExitMotion(panel: React.RefObject<HTMLElement | null>, docked: boolean, open: boolean) {
  const last = useRef<DOMRect | null>(null);
  const placement = useRef(docked);
  // Heard before React re-renders: the box is still where it was.
  useEffect(() => {
    let wasOpen = companionOpen.get().open;
    return companionOpen.subscribe(() => {
      const aside = panel.current;
      const now = companionOpen.get().open;
      if (wasOpen && !now && aside && !aside.hidden && companionOpen.lastChange() === "action") last.current = aside.getBoundingClientRect();
      wasOpen = now;
    });
  }, [panel]);
  useLayoutEffect(() => {
    const aside = panel.current;
    const box = last.current;
    last.current = null;
    // A window that changed layout closes the companion without motion: only the learner's own
    // close is animated.
    const moved = placement.current !== docked;
    placement.current = docked;
    if (open || moved || !box || !aside || typeof aside.animate !== "function") return;
    const style = getComputedStyle(aside);
    const name = docked ? "--motion-m10" : "--motion-m12-close";
    const duration = parseFloat(style.getPropertyValue(`${name}-duration`)) || 0;
    if (!duration) return;
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const shift = parseFloat(style.getPropertyValue("--motion-m9-shift")) || 0;
    const towardEnd = style.direction === "rtl" ? -shift : shift;
    aside.hidden = false;
    aside.setAttribute("aria-hidden", "true");
    aside.dataset.leaving = "true";
    Object.assign(aside.style, { position: "fixed", top: `${box.top}px`, left: `${box.left}px`, width: `${box.width}px`, height: `${box.height}px` });
    // The box fades (a sheet slides down); beside the lesson its content also moves toward the
    // inline end, inside the box, so the page never widens.
    const timing = { duration, easing: style.getPropertyValue(`${name}-easing`).trim() || "ease-in" };
    const animation = aside.animate(
      !docked && !still ? [{ transform: "none" }, { transform: "translateY(100%)" }] : [{ opacity: 1 }, { opacity: 0 }],
      timing,
    );
    if (docked && !still)
      for (const child of Array.from(aside.children)) child.animate([{ transform: "none" }, { transform: `translateX(${towardEnd}px)` }], timing);
    const done = () => {
      for (const key of ["position", "top", "left", "width", "height"] as const) aside.style[key] = "";
      aside.removeAttribute("aria-hidden");
      delete aside.dataset.leaving;
      if (!companionOpen.get().open) aside.hidden = true;
    };
    animation.onfinish = done;
    animation.oncancel = done;
    return () => animation.cancel();
  }, [panel, open, docked]);
}
