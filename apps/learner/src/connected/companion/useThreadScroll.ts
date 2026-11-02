import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { highlightBlock } from "../ui/highlight";
import { MEDIA, matches } from "../ui/media";

/** Where an anchored message's top sits below the thread's top edge (final design §3.8). */
export const ANCHOR_GAP = 16;
/** How close to the end counts as "at the latest" (Jump to latest hides). */
const AT_END = 8;

export interface ThreadScroll {
  /** Jump to latest shows while the end of the conversation is below the view. */
  jumpVisible: boolean;
  /** New content arrived below while the learner was away from the end (the Jump dot). */
  jumpDot: boolean;
  /** Scrolls to the end of the latest content (smooth unless motion is reduced). */
  jump(): void;
  /**
   * Anchor on send (G1, M3): scrolls so `element` starts 16 px below the thread's top and keeps
   * room under it, so the reply grows downward from there and nothing moves while it streams.
   * With `question` (the companion's closing question being answered), that question's first line
   * is anchored instead, as long as `element` then still sits in the upper half of the view.
   */
  anchor(element: HTMLElement, question?: HTMLElement | null): void;
  /** Puts a message's start 16 px from the top and highlights it (M14). */
  reveal(element: HTMLElement): void;
  /** Opens at the latest content (or at `element`, the oldest unread reply). */
  open(element?: HTMLElement | null): void;
}

const reduced = () => matches(MEDIA.reducedMotion);
/** An element's top inside the scroller's content, whatever lies between them. */
function offsetIn(scroller: HTMLElement, element: HTMLElement) {
  return element.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
}

/**
 * The thread's scrolling (final design §3.8 items 1-5, G1): it is the only scroller in the
 * companion. A send anchors the new question near the top with room under it (a spacer that stays
 * until the next send); text that streams in never moves the view, and a reply that finishes off
 * screen never pulls it down. Jump to latest appears while the end is below the view, with a dot
 * once something new arrived there. The thread says when it is scrolled away from its top
 * (`data-scrolled`, for the panel header's hairline).
 */
export function useThreadScroll(
  thread: RefObject<HTMLElement | null>,
  end: RefObject<HTMLElement | null>,
  spacer: RefObject<HTMLElement | null>,
): ThreadScroll {
  const [jumpVisible, setJumpVisible] = useState(false);
  const [jumpDot, setJumpDot] = useState(false);
  /** The scroll position an anchor asked for; the spacer keeps it reachable. */
  const anchored = useRef<number | null>(null);
  /** The view rests at the anchor and the learner has not scrolled since: it is held there. */
  const held = useRef(false);
  const lastEnd = useRef(0);
  const visible = useRef(false);

  const measure = useCallback(() => {
    const scroller = thread.current, marker = end.current;
    if (!scroller || !marker) return;
    if (scroller.scrollTop > 0) scroller.setAttribute("data-scrolled", "true");
    else scroller.removeAttribute("data-scrolled");
    const endAt = offsetIn(scroller, marker);
    const below = endAt > scroller.scrollTop + scroller.clientHeight + AT_END;
    setJumpVisible(below);
    if (!below) setJumpDot(false);
    else if (endAt > lastEnd.current + 1 && lastEnd.current > 0) setJumpDot(true);
    lastEnd.current = endAt;
  }, [thread, end]);

  /**
   * The spacer under the anchored question: enough room for the anchor's scroll position. It sits
   * after the observed content, not inside it, so resizing it from the observer never resizes what
   * the observer watches (a loop WebKit reports as an error and answers by dropping notifications).
   */
  const fitSpacer = useCallback(() => {
    const scroller = thread.current, content = end.current?.parentElement, room = spacer.current;
    if (!scroller || !content || !room) return;
    let size = 0;
    if (anchored.current !== null) {
      const contentEnd = offsetIn(scroller, content) + content.getBoundingClientRect().height;
      const style = getComputedStyle(scroller);
      const padding = Number.parseFloat(style.paddingBlockEnd || style.paddingBottom || "0") || 0;
      size = Math.max(0, Math.ceil(anchored.current + scroller.clientHeight - contentEnd - padding));
    }
    const next = `${size}px`;
    if (room.style.blockSize !== next) room.style.blockSize = next;
  }, [thread, end, spacer]);

  useEffect(() => {
    const scroller = thread.current;
    if (!scroller) return;
    const onScroll = () => {
      // The anchor's own scroll came to rest there: from now on the view is held at it.
      if (anchored.current !== null && Math.abs(scroller.scrollTop - anchored.current) < 1) held.current = true;
      measure();
    };
    // The learner's own scrolling (wheel, touch, the scroll bar, keys in the thread) lets go of it;
    // the room under the question stays until the next send.
    const letGo = () => {
      held.current = false;
    };
    const onKey = (event: KeyboardEvent) => {
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) letGo();
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    scroller.addEventListener("wheel", letGo, { passive: true });
    scroller.addEventListener("touchstart", letGo, { passive: true });
    scroller.addEventListener("pointerdown", letGo, { passive: true });
    scroller.addEventListener("keydown", onKey);
    const observer = typeof ResizeObserver === "function"
      ? new ResizeObserver(() => {
          fitSpacer();
          // Content that shrank for a moment (one state of a reply giving way to the next) can
          // clamp the scroll before the spacer grows back: the held view is put back where it was.
          if (held.current && anchored.current !== null && Math.abs(scroller.scrollTop - anchored.current) >= 1) scroller.scrollTop = anchored.current;
          measure();
        })
      : null;
    observer?.observe(scroller);
    const content = scroller.firstElementChild;
    if (content) observer?.observe(content);
    measure();
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      scroller.removeEventListener("wheel", letGo);
      scroller.removeEventListener("touchstart", letGo);
      scroller.removeEventListener("pointerdown", letGo);
      scroller.removeEventListener("keydown", onKey);
      observer?.disconnect();
    };
  }, [thread, measure, fitSpacer]);

  const scrollTo = (top: number, smooth: boolean) => {
    const scroller = thread.current;
    if (!scroller) return;
    if (typeof scroller.scrollTo === "function") scroller.scrollTo({ top, behavior: smooth && !reduced() ? "smooth" : "auto" });
    else scroller.scrollTop = top;
  };

  const toEnd = (smooth: boolean) => {
    const scroller = thread.current, marker = end.current;
    if (!scroller || !marker) return;
    const style = getComputedStyle(scroller);
    const padding = Number.parseFloat(style.paddingBlockEnd || style.paddingBottom || "0") || 0;
    scrollTo(Math.max(0, offsetIn(scroller, marker) + padding - scroller.clientHeight), smooth);
  };

  return {
    jumpVisible,
    jumpDot,
    jump() {
      held.current = false;
      setJumpDot(false);
      toEnd(true);
    },
    anchor(element, question) {
      const scroller = thread.current;
      if (!scroller) return;
      let top = offsetIn(scroller, element) - ANCHOR_GAP;
      if (question) {
        const alternative = offsetIn(scroller, question) - ANCHOR_GAP;
        // Question, answer and reply read as one unit, while the answer stays in the upper half.
        if (alternative < top && top - alternative < scroller.clientHeight / 2) top = alternative;
      }
      anchored.current = Math.max(0, top);
      held.current = false;
      fitSpacer();
      scrollTo(anchored.current, true);
    },
    reveal(element) {
      const scroller = thread.current;
      if (!scroller) return;
      held.current = false;
      scrollTo(Math.max(0, offsetIn(scroller, element) - ANCHOR_GAP), true);
      highlightBlock(element);
    },
    open(element) {
      const scroller = thread.current;
      if (!scroller) return;
      anchored.current = null;
      held.current = false;
      fitSpacer();
      if (element) scrollTo(Math.max(0, offsetIn(scroller, element) - ANCHOR_GAP), false);
      else toEnd(false);
      visible.current = true;
      measure();
    },
  };
}

/** Calls `onShown` each time `element` becomes visible (the panel or sheet opens again). */
export function useOnShown(element: RefObject<HTMLElement | null>, onShown: () => void) {
  const callback = useRef(onShown);
  callback.current = onShown;
  useLayoutEffect(() => {
    const node = element.current;
    if (!node || typeof ResizeObserver !== "function") return;
    let shown = node.getClientRects().length > 0;
    const observer = new ResizeObserver(() => {
      const now = node.getClientRects().length > 0;
      if (now && !shown) callback.current();
      shown = now;
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [element]);
}
