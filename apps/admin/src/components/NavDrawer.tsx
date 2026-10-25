import {
  useEffect,
  useRef,
  type PropsWithChildren,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { lockPageScroll, trapTab } from "./ui";
import { useT } from "../i18n";

/**
 * The workspace navigation on phones and tablets: a modal drawer that slides in from the
 * inline start (the left in English, the right in Hebrew). It is a native modal `<dialog>`, so
 * the page behind is inert and does not scroll; Tab stays inside, and Escape, the close button
 * or a tap outside close it. On opening, focus goes to the current section's item. The caller
 * mounts it while it is open and decides where focus goes after it closes (`onClosed`).
 */
export function NavDrawer({
  id,
  brand,
  onDismiss,
  onClosed,
  children,
}: PropsWithChildren<{
  id?: string;
  /** The product mark and name at the top of the drawer. */
  brand: ReactNode;
  /** Escape, the close button or a tap outside the drawer. */
  onDismiss: () => void;
  /** Runs once the drawer has closed, to put focus where the person continues. */
  onClosed: () => void;
}>) {
  const t = useT();
  const ref = useRef<HTMLDialogElement>(null);
  const latest = useRef({ onDismiss, onClosed });
  latest.current = { onDismiss, onClosed };
  const unmounting = useRef(false);
  useEffect(() => {
    unmounting.current = false;
    const dialog = ref.current!;
    dialog.showModal();
    // The current section first: the person sees where they are and can move from there.
    (
      dialog.querySelector<HTMLElement>(
        '[aria-current="page"]:not(:disabled)',
      ) ?? dialog.querySelector<HTMLElement>(".nav-drawer-close")
    )?.focus();
    const unlock = lockPageScroll();
    return () => {
      unmounting.current = true;
      dialog.close();
      unlock();
      latest.current.onClosed();
    };
  }, []);
  return createPortal(
    <dialog
      ref={ref}
      id={id}
      aria-label={t("navDrawer.title")}
      aria-modal="true"
      className="nav-drawer"
      onCancel={(event) => {
        event.preventDefault();
        onDismiss();
      }}
      onClose={() => {
        // A browser can close a modal dialog without a cancel event (Chrome does on a repeated
        // Escape). Keep the caller's state in step.
        if (!unmounting.current) latest.current.onDismiss();
      }}
      onKeyDown={(event) => trapTab(event, ref.current!)}
      onClick={(event) => {
        // A tap on the backdrop lands on the dialog element itself, outside its box.
        if (event.target !== event.currentTarget) return;
        const rect = ref.current!.getBoundingClientRect();
        if (
          event.clientX < rect.left ||
          event.clientX > rect.right ||
          event.clientY < rect.top ||
          event.clientY > rect.bottom
        )
          onDismiss();
      }}
    >
      <div className="nav-drawer-head">
        {brand}
        <button
          type="button"
          className="nav-drawer-close"
          aria-label={t("navDrawer.close")}
          onClick={onDismiss}
        >
          <X size={20} aria-hidden="true" />
        </button>
      </div>
      <div className="nav-drawer-body">{children}</div>
    </dialog>,
    document.body,
  );
}
