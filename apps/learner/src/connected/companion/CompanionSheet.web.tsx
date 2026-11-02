import React, { useEffect, useLayoutEffect, useRef } from "react";
import { useT } from "../../i18n";
import { Icon } from "../../components/icons/Icon.web";
import { PreparingDots } from "../ui/PreparingDots.web";
import { motionDuration } from "../ui/media";
import { isEditable, keyboardHeight } from "../layoutViewport";
import { companionFocus } from "../../client/companionFocus";
import { useCompanionActivity } from "./bridge";
import { companionOpen, type CompanionDetent } from "./openState";
import {
  cycleDetent,
  detentHeights,
  dragHeight,
  releaseDetent,
  stepDetent,
  type SheetKind,
} from "./sheetDetents";

/**
 * The companion as a bottom sheet on phones, tablets in portrait and short windows (final design
 * §2.3-§2.5, G6). It is never modal: no scrim, nothing behind it inert, no focus trap, no scroll
 * lock, and it is always the `complementary` region. Its heights are Collapsed, Half (every open)
 * and Full; the handle, the height toggle, ↑/↓ on the handle and a drag move between them. Its
 * height is written as `--sheet-h` on the host element (and the root, whose scroll padding a tablet's
 * page uses), never through React state, so neither a drag nor the keyboard re-renders the lesson.
 */

/** The handle at the sheet's top: a 96 × 44 button drawing a 32 × 4 bar. A press takes Half and
 * Full in turn; ↑/↓ step through the heights. */
export function SheetHandle({ kind, detent }: { kind: SheetKind; detent: CompanionDetent }) {
  const t = useT();
  return (
    <button
      type="button"
      className="cc-shell-handle"
      aria-label={t("companionSheet.resize")}
      data-companion-control=""
      data-sheet-drag=""
      onClick={() => companionOpen.setDetent(cycleDetent(kind, detent))}
      onKeyDown={(event) => {
        if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
        event.preventDefault();
        const next = stepDetent(kind, detent, event.key === "ArrowUp" ? 1 : -1);
        if (next !== detent) companionOpen.setDetent(next);
      }}
    >
      <span className="cc-shell-handle-bar" aria-hidden="true" />
    </button>
  );
}

/** Full height ↔ Half height. It names the height it goes to (`data-detent`). */
export function DetentToggle({ detent }: { detent: CompanionDetent }) {
  const t = useT();
  const toFull = detent !== "full";
  return (
    <button
      type="button"
      className="cc-ui-icon-button cc-shell-header-button"
      aria-label={toFull ? t("companionSheet.full") : t("companionSheet.half")}
      title={toFull ? t("companionSheet.full") : t("companionSheet.half")}
      data-detent={toFull ? "full" : "half"}
      data-companion-control=""
      onClick={() => companionOpen.setDetent(toFull ? "full" : "half")}
    >
      <Icon name="chevrons-up-down" size={20} />
    </button>
  );
}

/** Collapsed: a 72 px bar with the companion's latest line (moving dots while it prepares a
 * reply) and "Show companion". A press anywhere on it opens Half. */
export function CollapsedBar({ kind }: { kind: SheetKind }) {
  const t = useT();
  const { latest } = useCompanionActivity();
  const open = () => companionOpen.setDetent(cycleDetent(kind, "collapsed"));
  return (
    <div className="cc-shell-collapsed" data-sheet-drag="" onClick={open}>
      <span className="cc-shell-collapsed-handle" aria-hidden="true" />
      <Icon name="sparkle" size={20} />
      {latest?.busy && <PreparingDots />}
      <p className="cc-shell-collapsed-text" dir="auto">
        {latest?.text || t("companionSheet.idle")}
      </p>
      <button
        type="button"
        className="cc-ui-icon-button cc-shell-header-button"
        aria-label={t("companionSheet.show")}
        title={t("companionSheet.show")}
        data-companion-control=""
        onClick={(event) => {
          event.stopPropagation();
          open();
        }}
      >
        <Icon name="chevron-up" size={20} />
      </button>
    </div>
  );
}

/** The host element (`.connected-host`, or the demo's frame), where the sheet's per-frame variables are written. */
const hostOf = (element: Element | null) => element?.closest<HTMLElement>(".connected-host, .cc-demo-dock-host") ?? null;
const headerHeight = () => document.querySelector(".connected-header, [data-testid='demo-header']")?.getBoundingClientRect().height ?? 0;
const easing = (element: Element, name: string, fallback: string) =>
  getComputedStyle(element).getPropertyValue(name).trim() || fallback;

/** Scrolls the sheet (its own scroller, or the conversation's) so the field being typed in ends
 * 8 px above the keyboard. */
function keepFieldAboveKeyboard(aside: HTMLElement) {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || active === aside || !aside.contains(active)) return;
  const limit = window.innerHeight - keyboardHeight() - 8;
  const below = active.getBoundingClientRect().bottom - limit;
  if (below <= 0) return;
  for (let node = active.parentElement; node && aside.contains(node); node = node.parentElement) {
    if (node.scrollHeight <= node.clientHeight) continue;
    const before = node.scrollTop;
    node.scrollTop = before + below;
    if (node.scrollTop !== before) return;
  }
}

/** The sheet's heights for this window now (the keyboard included). */
function currentHeights(kind: SheetKind) {
  return detentHeights({ kind, viewport: window.innerHeight, header: headerHeight(), keyboard: keyboardHeight() });
}

/**
 * Keeps the sheet's height in `--sheet-h` on the host and the aside, moves between heights with
 * M12 (`translateY` only), and lets a drag on the handle, the header or the collapsed bar (and on
 * the thread at Half, while it is scrolled to its top) resize or dismiss it.
 */
export function useSheet(
  panel: React.RefObject<HTMLElement | null>,
  { kind, open, detent, onDismiss }: { kind: SheetKind | null; open: boolean; detent: CompanionDetent; onDismiss: () => void },
) {
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  /** The box's height and how far it is drawn below its place (a drag left it there). */
  const shown = useRef<{ box: number; offset: number } | null>(null);
  const running = useRef<Animation | null>(null);
  // Height on every layout change: open, detent, window size, the keyboard, the header.
  useLayoutEffect(() => {
    const aside = panel.current;
    const host = hostOf(aside);
    if (!aside || !host) return;
    // The root has it too: the page's scroll padding is set on `html`.
    const root = document.documentElement;
    if (!kind || !open) {
      host.style.removeProperty("--sheet-h");
      root.style.removeProperty("--sheet-h");
      aside.style.removeProperty("height");
      shown.current = null;
      return;
    }
    let frame = 0;
    const setHeight = (height: number) => {
      aside.style.height = `${height}px`;
      host.style.setProperty("--sheet-h", `${height}px`);
      root.style.setProperty("--sheet-h", `${height}px`);
    };
    const apply = (animate: boolean) => {
      const height = currentHeights(kind)[detent];
      const before = shown.current;
      // A resize that leaves this height as it is (the header observer's first report, a window
      // change the sheet does not feel) lets a running move finish instead of cutting it.
      if (!animate && before && before.box === height && before.offset === 0) return;
      shown.current = { box: height, offset: 0 };
      running.current?.cancel();
      running.current = null;
      const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      if (!animate || typeof aside.animate !== "function" || (before && still)) return setHeight(height);
      const duration = motionDuration(aside, "--motion-m12-duration", 300);
      const ease = easing(aside, "--motion-m12-easing", "cubic-bezier(0.32, 0.72, 0, 1)");
      if (!before) {
        // Opening: up from below the window (reduced motion: a fade).
        setHeight(height);
        running.current = aside.animate(
          still ? [{ opacity: 0 }, { opacity: 1 }] : [{ transform: "translateY(100%)" }, { transform: "none" }],
          { duration, easing: ease },
        );
        return;
      }
      const visible = before.box - before.offset;
      if (height >= visible) {
        // Taller: the new box starts with its top where the old one was drawn and slides up.
        setHeight(height);
        if (height !== visible)
          running.current = aside.animate([{ transform: `translateY(${height - visible}px)` }, { transform: "none" }], { duration, easing: ease });
        return;
      }
      // Shorter: the old box slides down to the new top, then takes the new height, so no gap
      // opens under it while it moves.
      setHeight(before.box);
      const animation = aside.animate(
        [{ transform: `translateY(${before.offset}px)` }, { transform: `translateY(${before.box - height}px)` }],
        { duration, easing: ease, fill: "forwards" },
      );
      running.current = animation;
      animation.onfinish = () => {
        setHeight(height);
        animation.cancel();
      };
    };
    apply(true);
    const resize = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        // The keyboard's room now, not after the host's own frame (useKeyboardInset writes the same).
        host.style.setProperty("--kb", `${keyboardHeight()}px`);
        apply(false);
        // An on-screen keyboard opened or closed: what is being typed in stays above it.
        keepFieldAboveKeyboard(aside);
      });
    };
    window.addEventListener("resize", resize);
    window.visualViewport?.addEventListener("resize", resize);
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(resize) : null;
    const header = document.querySelector(".connected-header");
    if (header) observer?.observe(header);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", resize);
      window.visualViewport?.removeEventListener("resize", resize);
      observer?.disconnect();
    };
  }, [panel, kind, open, detent]);
  useEffect(
    () => () => {
      hostOf(panel.current)?.style.removeProperty("--sheet-h");
      document.documentElement.style.removeProperty("--sheet-h");
    },
    [panel],
  );

  // Dragging: translateY on the aside only, per frame; the height settles on release.
  useEffect(() => {
    const aside = panel.current;
    if (!aside || !kind || !open) return;
    let drag: { start: number; base: number; last: number; samples: { y: number; at: number }[]; moved: boolean; id: number | "touch" } | null = null;
    const heights = () => currentHeights(kind);
    const begin = (y: number, id: number | "touch") => {
      drag = { start: y, base: aside.getBoundingClientRect().height, last: y, samples: [{ y, at: performance.now() }], moved: false, id };
    };
    const move = (y: number) => {
      if (!drag) return false;
      const now = performance.now();
      drag.last = y;
      // The release velocity is measured over the last 80 ms, as a finger's flick is.
      drag.samples = [...drag.samples.filter((sample) => now - sample.at <= 80), { y, at: now }];
      if (!drag.moved && Math.abs(y - drag.start) < 4) return false;
      drag.moved = true;
      const drawn = dragHeight(drag.base, y - drag.start, heights().full);
      aside.style.transform = `translateY(${drag.base - drawn}px)`;
      return true;
    };
    const velocity = (samples: { y: number; at: number }[]) => {
      const first = samples[0]!,
        last = samples.at(-1)!;
      return last.at > first.at ? (last.y - first.y) / (last.at - first.at) : 0;
    };
    const end = () => {
      const current = drag;
      drag = null;
      if (!current?.moved) return false;
      const drawn = dragHeight(current.base, current.last - current.start, heights().full);
      aside.style.transform = "";
      const target = releaseDetent(kind, heights(), drawn, velocity(current.samples));
      if (target === "closed") dismiss.current();
      else if (target === detent) {
        // Back to where it was, from where the finger left it.
        if (typeof aside.animate === "function")
          aside.animate([{ transform: `translateY(${current.base - drawn}px)` }, { transform: "none" }], {
            duration: motionDuration(aside, "--motion-m12-duration", 300),
            easing: easing(aside, "--motion-m12-easing", "ease-out"),
          });
      } else {
        // The new height's animation starts from where the drag left the sheet.
        shown.current = { box: current.base, offset: current.base - drawn };
        companionOpen.setDetent(target);
      }
      return true;
    };
    // The handle, the header and the collapsed bar drag with a pointer (mouse, pen or touch).
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element;
      if (event.button !== 0 || !target.closest("[data-sheet-drag], .cc-shell-header")) return;
      if (target.closest("button:not([data-sheet-drag])")) return;
      begin(event.clientY, event.pointerId);
    };
    const onPointerMove = (event: PointerEvent) => {
      if (drag && drag.id === event.pointerId && move(event.clientY)) aside.setPointerCapture?.(event.pointerId);
    };
    const onPointerUp = (event: PointerEvent) => {
      if (!drag || drag.id !== event.pointerId) return;
      move(event.clientY);
      if (end()) {
        // A drag is not a press: the click that follows on the handle or bar is swallowed.
        const swallow = (click: Event) => {
          click.stopPropagation();
          click.preventDefault();
        };
        aside.addEventListener("click", swallow, { capture: true, once: true });
        setTimeout(() => aside.removeEventListener("click", swallow, { capture: true }), 0);
      }
    };
    // At Half the thread drags the sheet while it is scrolled to its top (touch only: a mouse
    // scrolls with the wheel and drags by the handle).
    const scrolledAway = (from: Element) => {
      for (let node: Element | null = from; node && node !== aside.parentElement; node = node.parentElement)
        if (node instanceof HTMLElement && node.scrollTop > 0) return true;
      return false;
    };
    const onTouchStart = (event: TouchEvent) => {
      const target = event.target as Element;
      if (detent !== "half" || event.touches.length !== 1) return;
      if (!target.closest(".cc-shell-body") || isEditable(target) || scrolledAway(target)) return;
      begin(event.touches[0]!.clientY, "touch");
    };
    const onTouchMove = (event: TouchEvent) => {
      if (drag?.id !== "touch") return;
      if (move(event.touches[0]!.clientY) && event.cancelable) event.preventDefault();
    };
    const onTouchEnd = () => {
      if (drag?.id === "touch") end();
    };
    aside.addEventListener("pointerdown", onPointerDown);
    aside.addEventListener("pointermove", onPointerMove);
    aside.addEventListener("pointerup", onPointerUp);
    aside.addEventListener("pointercancel", onPointerUp);
    aside.addEventListener("touchstart", onTouchStart, { passive: true });
    aside.addEventListener("touchmove", onTouchMove, { passive: false });
    aside.addEventListener("touchend", onTouchEnd);
    aside.addEventListener("touchcancel", onTouchEnd);
    return () => {
      aside.style.transform = "";
      aside.removeEventListener("pointerdown", onPointerDown);
      aside.removeEventListener("pointermove", onPointerMove);
      aside.removeEventListener("pointerup", onPointerUp);
      aside.removeEventListener("pointercancel", onPointerUp);
      aside.removeEventListener("touchstart", onTouchStart);
      aside.removeEventListener("touchmove", onTouchMove);
      aside.removeEventListener("touchend", onTouchEnd);
      aside.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [panel, kind, open, detent]);
}

/**
 * Focusing the message box at Half (G6): first the lesson scrolls so the part the learner asks
 * about stays in the strip Full leaves above the sheet, then the sheet goes Full. The part is the
 * lesson text selected, else the paragraph at the top of the lesson's visible part. Blurring the
 * box never goes back to Half.
 */
export function revealAnchorThenFull(kind: SheetKind) {
  const heights = currentHeights(kind);
  const top = headerHeight();
  // The strip that stays visible above the sheet at Full.
  const stripBottom = window.innerHeight - heights.full;
  const scroller = document.querySelector<HTMLElement>(".connected-host.is-compact .connected-main");
  const anchor = attachedAnchor(top, window.innerHeight - heights.half);
  if (anchor) {
    const box = anchor.getBoundingClientRect();
    // Its first lines go to the top of the strip (8 px under the header); nothing moves when they
    // are already in it.
    const shift = box.top - (top + 8);
    if (Math.abs(shift) >= 1 && (box.top < top || box.top > stripBottom - 24)) {
      if (scroller) scroller.scrollBy({ top: shift, behavior: "instant" as ScrollBehavior });
      else window.scrollBy({ top: shift, behavior: "instant" as ScrollBehavior });
    }
  }
  companionOpen.setDetent("full");
}

/** The lesson element the learner is asking about: the newest attachment's place (the check, the
 * selected lines, the player, the illustration), else the block holding the selected lesson text,
 * else the first lesson block whose top is visible between `top` and `bottom`. */
function attachedAnchor(top: number, bottom: number): Element | null {
  const main = document.querySelector(".connected-main");
  if (!main) return null;
  const attached = companionFocus.anchor();
  if (attached && main.contains(attached)) return attached;
  const selection = document.getSelection?.();
  const node = selection && !selection.isCollapsed ? selection.anchorNode : null;
  const selected = (node instanceof Element ? node : node?.parentElement)?.closest("p, li, pre, figure, h1, h2, h3, section, article");
  if (selected && main.contains(selected)) return selected;
  const blocks = Array.from(main.querySelectorAll("h1, h2, h3, p, li, pre, figure, .connected-check"));
  return (
    blocks.find((block) => {
      const box = block.getBoundingClientRect();
      return box.height > 0 && box.bottom > top && box.top < bottom;
    }) ?? null
  );
}
