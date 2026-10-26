/**
 * Focus Not Obscured (WCAG 2.4.11) in a lesson: a control that keyboard or script focus reaches
 * behind the sticky answer actions is scrolled clear of them.
 *
 * Focus that a press gives a control (the default action of mousedown, which a tap fires too) is
 * left where it is. It lands where the learner is pressing, so that spot is in view; scrolling
 * then would carry the control out from under the press before its release, the release would
 * land on something else, and the control would never be clicked. The course 0.1.6 acceptance on
 * Core 0.1.60 lost a tap on a choice option this way: pressed 5 px above the answer actions, the
 * option was scrolled up 85 px and the release fell below it.
 *
 * `onFocus` hears every focus inside the lesson. Returns the cleanup.
 */
export function keepFocusClearOfAnswerActions(
  scroller: () => { scrollBy?: (options: ScrollToOptions) => void },
  onFocus: (target: HTMLElement) => void,
  doc: Document = document,
): () => void {
  let pressFocus = false;
  const pressing = () => {
    pressFocus = true;
    // The focus a press gives comes in the same task as its mousedown.
    setTimeout(() => {
      pressFocus = false;
    }, 0);
  };
  const focused = (event: FocusEvent) => {
    const target = event.target as HTMLElement;
    if (!target.closest?.(".connected-lesson-keeper")) return;
    onFocus(target);
    if (pressFocus) return;
    const bar = doc.querySelector<HTMLElement>(".connected-answer-actions");
    if (!bar || bar.contains(target)) return;
    const box = target.getBoundingClientRect(), cover = bar.getBoundingClientRect();
    const behindBar = box.bottom > cover.top && box.top < cover.bottom;
    if (behindBar) scroller().scrollBy?.({ top: box.bottom - cover.top + 12, behavior: "instant" });
  };
  doc.addEventListener("mousedown", pressing, { capture: true, passive: true });
  doc.addEventListener("focusin", focused);
  return () => {
    doc.removeEventListener("mousedown", pressing, { capture: true });
    doc.removeEventListener("focusin", focused);
  };
}
