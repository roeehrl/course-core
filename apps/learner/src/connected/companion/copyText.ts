/**
 * Puts text on the clipboard; resolves false when the browser refused. The Clipboard API needs a
 * secure page; elsewhere (the app over plain http on a local network) a hidden field is copied
 * the older way.
 */
export async function copyText(text: string): Promise<boolean> {
  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
  try {
    if (typeof clipboard?.writeText === "function") {
      await clipboard.writeText(text);
      return true;
    }
  } catch {
    /* Refused (no permission, not focused): try the older way. */
  }
  if (typeof document === "undefined") return false;
  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.opacity = "0";
  const focused = document.activeElement as HTMLElement | null;
  document.body.append(field);
  field.select();
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }
  field.remove();
  focused?.focus({ preventScroll: true });
  return copied;
}
