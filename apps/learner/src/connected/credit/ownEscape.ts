import { useEffect, useRef } from "react";

/**
 * Esc inside a credit control (the inline confirm, the ⓘ popover) belongs to that control: it is
 * heard on the document before the companion's own Esc, which on a phone closes the whole drawer
 * (CompanionDock.web.tsx listens in the capture phase), and goes no further. `within` names the
 * control's element while it shows.
 */
export function useOwnEscape(active: boolean, within: () => Element | null | undefined, onEscape: () => void) {
  const latest = useRef({ within, onEscape });
  latest.current = { within, onEscape };
  useEffect(() => {
    if (!active || typeof document === "undefined") return;
    const listener = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      const node = latest.current.within();
      if (!node || !(event.target instanceof Node) || !node.contains(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      latest.current.onEscape();
    };
    document.addEventListener("keydown", listener, true);
    return () => document.removeEventListener("keydown", listener, true);
  }, [active]);
}
