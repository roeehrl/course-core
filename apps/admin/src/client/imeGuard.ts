/**
 * Input method editors (Japanese, Chinese, Korean, and others) use Enter to commit
 * the text being composed. That Enter must never submit a form. Browsers report it
 * as a keydown with `isComposing` set or keyCode 229, and some (Safari) send it
 * right after `compositionend`. One document-level guard covers every form in the
 * app: a submit that comes from such an Enter is cancelled before React sees it.
 * Text inputs that submit on Enter themselves (React Native Web `onSubmitEditing`)
 * already ignore composing keys; explicit handlers use `isImeEnter`.
 */
export function isImeEnter(event: {
  key?: string;
  isComposing?: boolean;
  keyCode?: number;
  nativeEvent?: { isComposing?: boolean; keyCode?: number };
}): boolean {
  if (event.key !== "Enter" && event.keyCode !== 229) return false;
  const native = event.nativeEvent ?? event;
  return (
    event.isComposing === true ||
    native.isComposing === true ||
    event.keyCode === 229 ||
    native.keyCode === 229
  );
}

/** Installs the guard on `target` (the document by default); returns the uninstaller. */
export function installImeSubmitGuard(
  target: Document | undefined = typeof document === "undefined"
    ? undefined
    : document,
): () => void {
  if (!target) return () => {};
  let composing = false,
    block = false,
    timer: ReturnType<typeof setTimeout> | undefined;
  // Block only for the rest of this keystroke: the submit an IME Enter could
  // trigger is dispatched synchronously from that key's default action.
  const blockThisTask = () => {
    block = true;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      block = false;
      timer = undefined;
    }, 0);
  };
  const start = () => {
    composing = true;
  };
  const end = () => {
    composing = false;
    blockThisTask();
  };
  const key = (event: Event) => {
    const keyboard = event as KeyboardEvent;
    if (isImeEnter(keyboard) || (composing && keyboard.key === "Enter"))
      blockThisTask();
  };
  const submit = (event: Event) => {
    if (!composing && !block) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  target.addEventListener("compositionstart", start, true);
  target.addEventListener("compositionend", end, true);
  target.addEventListener("keydown", key, true);
  target.addEventListener("submit", submit, true);
  return () => {
    if (timer) clearTimeout(timer);
    target.removeEventListener("compositionstart", start, true);
    target.removeEventListener("compositionend", end, true);
    target.removeEventListener("keydown", key, true);
    target.removeEventListener("submit", submit, true);
  };
}
