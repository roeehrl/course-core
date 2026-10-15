import { useEffect, useRef, useState } from "react";

/** Size of the layout viewport: the window the page is laid out in.
 *
 * React Native Web's `useWindowDimensions` reports the *visual* viewport, which an
 * on-screen keyboard shrinks on iOS and current Android Chrome. Choosing the
 * wide/compact learner layout from that height flips a landscape tablet into the
 * compact layout as soon as the learner focuses a field, which closes the side
 * companion pane and swaps the scroll container mid-typing. The layout decision
 * therefore uses the layout viewport instead. Behaviour that really should follow
 * the visible area above the keyboard can still read `window.visualViewport`. */
export interface ViewportSize {
  width: number;
  height: number;
}

/** `documentElement.client*` is the layout viewport minus scrollbars; unlike
 * `innerWidth`/`innerHeight` it ignores pinch zoom and the iOS keyboard. */
export function measureLayoutViewport(root: Element = document.documentElement): ViewportSize {
  return { width: root.clientWidth, height: root.clientHeight };
}

/** True for elements that summon an on-screen keyboard when focused. */
export function isEditable(element: Element | null | undefined): boolean {
  if (!element) return false;
  if ((element as HTMLElement).isContentEditable) return true;
  if (element.tagName === "TEXTAREA") return !(element as HTMLTextAreaElement).readOnly;
  if (element.tagName !== "INPUT") return false;
  const input = element as HTMLInputElement;
  return (
    !input.readOnly &&
    !["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"].includes(input.type)
  );
}

/** Some browsers (older Android Chrome, or `interactive-widget=resizes-content`)
 * shrink the layout viewport for the keyboard as well. While an editable element
 * is focused, a height-only shrink is therefore held back until editing ends;
 * width changes (rotation, window resizes) and height growth apply at once. */
export function nextLayoutSize(
  previous: ViewportSize,
  measured: ViewportSize,
  editing: boolean,
): ViewportSize {
  if (editing && measured.width === previous.width && measured.height < previous.height)
    return previous;
  if (measured.width === previous.width && measured.height === previous.height)
    return previous;
  return measured;
}

export function useLayoutViewport(): ViewportSize {
  const [size, setSize] = useState(() => measureLayoutViewport());
  useEffect(() => {
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() =>
        setSize((previous) =>
          nextLayoutSize(previous, measureLayoutViewport(), isEditable(document.activeElement)),
        ),
      );
    };
    update();
    // `focusout` fires before focus moves on; the deferred measurement sees the
    // element that receives focus (or none) and releases a held-back shrink.
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    document.addEventListener("focusout", update);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
      document.removeEventListener("focusout", update);
    };
  }, []);
  return size;
}

/** How much of `container`'s visible bottom an on-screen keyboard (or other
 * browser chrome) covers: the gap between the container's visible bottom edge
 * and the bottom of the visual viewport. */
export function keyboardInset(
  containerBottom: number,
  layoutHeight: number,
  visual: { height: number; offsetTop: number } | null | undefined,
): number {
  if (!visual) return 0;
  const visibleBottom = Math.min(containerBottom, layoutHeight);
  return Math.max(0, Math.round(visibleBottom - (visual.offsetTop + visual.height)));
}

/** Keeps the CSS variable `--keyboard-inset` on `host` up to date, so sticky
 * actions (`bottom: var(--keyboard-inset)`) stay above the on-screen keyboard.
 * The container is the element the lesson scrolls in: the compact layout's own
 * scroll pane, otherwise the window. */
export function useKeyboardInset(
  host: { current: HTMLElement | null },
  container: () => Element | null,
) {
  const find = useRef(container);
  find.current = container;
  useEffect(() => {
    const visual = window.visualViewport;
    if (!visual) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const element = find.current();
        const bottom = element ? element.getBoundingClientRect().bottom : window.innerHeight;
        const inset = keyboardInset(bottom, window.innerHeight, window.visualViewport);
        host.current?.style.setProperty("--keyboard-inset", `${inset}px`);
      });
    };
    update();
    visual.addEventListener("resize", update);
    visual.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    return () => {
      cancelAnimationFrame(frame);
      visual.removeEventListener("resize", update);
      visual.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [host]);
}
