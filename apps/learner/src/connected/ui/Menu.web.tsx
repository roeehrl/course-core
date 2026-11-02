import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "../../components/icons/Icon.web";
import type { IconName } from "../../components/icons/icons";

export interface MenuItem {
  id: string;
  label: string;
  icon?: IconName;
  /** Destructive: drawn in `--danger`. */
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

export interface MenuTriggerProps {
  ref: React.RefObject<HTMLButtonElement | null>;
  "aria-haspopup": "menu";
  "aria-expanded": boolean;
  "aria-controls": string;
  onClick: () => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => void;
}

/**
 * A menu of actions (`role="menu"`): ↑/↓, Home and End move between items, Enter or Space runs
 * one, Esc and Tab close it and Esc returns focus to its button, a click outside closes it. Rows
 * are 40 px (44 coarse). It opens downward and flips upward near the bottom of the window. M16.
 */
export function Menu({
  label,
  items,
  trigger,
  className,
  align = "end",
}: {
  label: string;
  items: readonly MenuItem[];
  trigger: (props: MenuTriggerProps) => React.ReactNode;
  className?: string;
  /** Which edge of the button the menu lines up with. */
  align?: "start" | "end";
}) {
  const id = useId();
  const button = useRef<HTMLButtonElement | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [up, setUp] = useState(false);
  const first = useRef<"first" | "last">("first");
  const enabled = () => Array.from(list.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])') ?? []);
  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) button.current?.focus({ preventScroll: true });
  }, []);
  useLayoutEffect(() => {
    if (!open) return;
    const anchor = button.current?.getBoundingClientRect();
    const height = list.current?.offsetHeight ?? 0;
    setUp(!!anchor && anchor.bottom + height + 8 > window.innerHeight && anchor.top - height - 8 >= 0);
    const items = enabled();
    (first.current === "last" ? items.at(-1) : items[0])?.focus({ preventScroll: true });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!list.current?.contains(target) && !button.current?.contains(target)) close(false);
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [open, close]);
  const move = (event: React.KeyboardEvent) => {
    const items = enabled();
    const at = items.indexOf(document.activeElement as HTMLElement);
    const go = (index: number) => {
      event.preventDefault();
      items[(index + items.length) % items.length]?.focus({ preventScroll: true });
    };
    if (event.key === "ArrowDown") go(at + 1);
    else if (event.key === "ArrowUp") go(at - 1);
    else if (event.key === "Home") go(0);
    else if (event.key === "End") go(items.length - 1);
    else if (event.key === "Escape") {
      event.preventDefault();
      close(true);
    } else if (event.key === "Tab") close(false);
  };
  return (
    <div className={["cc-ui-menu-anchor", className].filter(Boolean).join(" ")}>
      {trigger({
        ref: button,
        "aria-haspopup": "menu",
        "aria-expanded": open,
        "aria-controls": id,
        onClick: () => {
          first.current = "first";
          setOpen((value) => !value);
        },
        onKeyDown: (event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            first.current = event.key === "ArrowUp" ? "last" : "first";
            setOpen(true);
          }
        },
      })}
      <div
        ref={list}
        id={id}
        role="menu"
        aria-label={label}
        hidden={!open}
        className={`cc-ui-menu is-${align}${up ? " is-up" : ""}`}
        onKeyDown={move}
      >
        {items.map((item) => (
          <div
            key={item.id}
            role="menuitem"
            tabIndex={-1}
            aria-disabled={item.disabled || undefined}
            className={`cc-ui-menu-item${item.danger ? " is-danger" : ""}`}
            onClick={() => {
              if (item.disabled) return;
              close(true);
              item.onSelect();
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              if (item.disabled) return;
              close(true);
              item.onSelect();
            }}
          >
            {item.icon && <Icon name={item.icon} size={16} />}
            <span>{item.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
