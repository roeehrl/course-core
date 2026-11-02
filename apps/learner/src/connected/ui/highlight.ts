import { MEDIA, matches } from "./media";

/**
 * Brief attention marks (final design §1.5). The CSS in primitives.css draws them from data
 * attributes, so any element can carry one.
 *
 * - M14 `highlightBlock`: the `--accent-soft` fill held 1400 ms, then fading 600 ms (2000 ms in
 *   all); with reduced motion it holds 2 s and goes without a fade.
 * - M15 `ringComposer`: a 2 px `--accent` outline held 2000 ms, then fading 300 ms; with reduced
 *   motion the ring goes without a fade.
 *
 * Each returns a function that removes the mark at once. Marking an element again restarts it.
 */
export const HIGHLIGHT_MS = { hold: 1400, fade: 600 } as const;
export const RING_MS = { hold: 2000, fade: 300 } as const;

const running = new WeakMap<HTMLElement, () => void>();

function mark(el: HTMLElement, attribute: string, hold: number, fade: number): () => void {
  running.get(el)?.();
  const reduced = matches(MEDIA.reducedMotion);
  const holdFor = reduced ? hold + fade : hold;
  const fadeFor = reduced ? 0 : fade;
  el.setAttribute(attribute, "hold");
  let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
    if (fadeFor === 0) return clear();
    el.setAttribute(attribute, "fade");
    timer = setTimeout(clear, fadeFor);
  }, holdFor);
  function clear() {
    if (timer) clearTimeout(timer);
    timer = undefined;
    el.removeAttribute(attribute);
    if (running.get(el) === clear) running.delete(el);
  }
  running.set(el, clear);
  return clear;
}

/** M14: shows where a jump landed (a lesson part, a check, a message). */
export function highlightBlock(el: HTMLElement): () => void {
  return mark(el, "data-cc-highlight", HIGHLIGHT_MS.hold, HIGHLIGHT_MS.fade);
}

/** M15: shows that text was put into an already-open composer. */
export function ringComposer(el: HTMLElement): () => void {
  return mark(el, "data-cc-ring", RING_MS.hold, RING_MS.fade);
}
