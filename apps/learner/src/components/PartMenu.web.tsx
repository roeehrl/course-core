import React, {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Icon } from "./icons/Icon.web";
import { useT } from "../i18n";

export interface IllustrationPart {
  id: string;
  label: string;
}

/**
 * "Ask about this part" under an illustration (final design §3.9): an outline pill that opens the
 * app's menu, titled "Which part?", one 44 px row per labelled part and a check on the part
 * asked about last. Choosing a part asks about it. The rows are a single-choice menu
 * (`menuitemradio`): ↑/↓, Home and End move, Enter or Space chooses, Esc and Tab close it and
 * return focus to the pill, a click outside closes it. It sits in `document.body` (the lesson's
 * parts paint over anything inside them), under the pill or above it near the window's bottom,
 * and follows the pill when the page scrolls. M16.
 */
export function PartMenu({
  parts,
  current,
  onChoose,
}: {
  parts: readonly IllustrationPart[];
  /** The part asked about last, checked in the menu. */
  current?: string;
  /** `byKeyboard`: chosen with Enter or Space, not a pointer. */
  onChoose: (part: IllustrationPart, byKeyboard: boolean) => void;
}) {
  const t = useT();
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const start = useRef<"current" | "last">("current");
  const rows = () =>
    Array.from(
      list.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ??
        [],
    );
  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) button.current?.focus({ preventScroll: true });
  }, []);
  /** Under the pill (above it near the window's bottom), inside the window, wherever it scrolls. */
  const place = useCallback(() => {
    const anchor = button.current?.getBoundingClientRect();
    const node = box.current;
    if (!anchor || !node) return;
    const height = node.offsetHeight,
      width = node.offsetWidth;
    const rtl = getComputedStyle(node).direction === "rtl";
    const top =
      anchor.bottom + 4 + height > window.innerHeight - 8 && anchor.top - 4 - height >= 8 ? anchor.top - 4 - height : anchor.bottom + 4;
    const room = document.documentElement.clientWidth || window.innerWidth;
    const left = Math.max(8, Math.min(rtl ? anchor.right - width : anchor.left, room - 8 - width));
    // A fixed box is placed in its containing block: measure where 0,0 lands and correct for it.
    node.style.top = "0px";
    node.style.left = "0px";
    const origin = node.getBoundingClientRect();
    node.style.top = `${top - origin.top}px`;
    node.style.left = `${left - origin.left}px`;
  }, []);
  useLayoutEffect(() => {
    if (!open) return;
    place();
    const items = rows();
    const checked = items.find((item) => item.getAttribute("aria-checked") === "true");
    (start.current === "last" ? items.at(-1) : checked ?? items[0])?.focus({ preventScroll: true });
  }, [open, place]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!box.current?.contains(target) && !button.current?.contains(target)) close(false);
    };
    let frame = 0;
    const follow = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(place);
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("scroll", follow, true);
    window.addEventListener("resize", follow);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("scroll", follow, true);
      window.removeEventListener("resize", follow);
    };
  }, [open, close, place]);
  const choose = (part: IllustrationPart, byKeyboard: boolean) => {
    close(true);
    onChoose(part, byKeyboard);
  };
  const move = (event: React.KeyboardEvent) => {
    const items = rows();
    const at = items.indexOf(document.activeElement as HTMLElement);
    const go = (index: number) => {
      event.preventDefault();
      items[(index + items.length) % items.length]?.focus({
        preventScroll: true,
      });
    };
    if (event.key === "ArrowDown") go(at + 1);
    else if (event.key === "ArrowUp") go(at - 1);
    else if (event.key === "Home") go(0);
    else if (event.key === "End") go(items.length - 1);
    else if (event.key === "Escape" || event.key === "Tab") {
      event.preventDefault();
      close(true);
    }
  };
  return (
    <div className="cc-ui-menu-anchor cc-ask-part">
      <button
        ref={button}
        type="button"
        className="cc-ui-pill cc-ui-pill-outline cc-ui-pill-36 cc-ask-pill"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={`${id}-menu`}
        onClick={() => {
          start.current = "current";
          setOpen((value) => !value);
        }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          start.current = event.key === "ArrowUp" ? "last" : "current";
          setOpen(true);
        }}
      >
        <Icon name="sparkle" size={16} />
        <span>{t("partMenu.button")}</span>
      </button>
      {typeof document !== "undefined" &&
        createPortal(
          <div
            ref={box}
            hidden={!open}
            className="cc-ui-menu cc-ask-part-menu"
            onKeyDown={move}
          >
            <div id={`${id}-title`} className="cc-ask-part-title">
              {t("partMenu.title")}
            </div>
            <div
              ref={list}
              id={`${id}-menu`}
              role="menu"
              aria-labelledby={`${id}-title`}
            >
              {parts.map((part) => (
                <div
                  key={part.id}
                  role="menuitemradio"
                  aria-checked={part.id === current}
                  tabIndex={-1}
                  className="cc-ui-menu-item cc-ask-part-item"
                  onClick={(event) => choose(part, event.detail === 0)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    choose(part, true);
                  }}
                >
                  <span dir="auto">{part.label}</span>
                  {part.id === current && <Icon name="check" size={16} />}
                </div>
              ))}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
