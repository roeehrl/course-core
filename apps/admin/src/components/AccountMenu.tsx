import {
  Fragment,
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentType,
  type KeyboardEvent,
} from "react";
import { Check, ChevronDown, UserRound } from "lucide-react";
import { useT } from "../i18n";
import { focusInPlace } from "./ui";

type Icon = ComponentType<{
  size?: number;
  "aria-hidden"?: "true";
  className?: string;
}>;

export type AccountMenuItem =
  | {
      kind: "action";
      id: string;
      label: string;
      icon?: Icon;
      /** The item opens a dialog: screen readers hear that before choosing it. */
      opensDialog?: boolean;
      disabled?: boolean;
      onSelect: () => void;
    }
  | {
      kind: "radio";
      id: string;
      label: string;
      checked: boolean;
      /** The label's own language and direction (a language's native name). */
      lang?: string;
      dir?: "ltr" | "rtl";
      disabled?: boolean;
      onSelect: () => void;
    };
export interface AccountMenuGroup {
  id: string;
  /** Names a group of choices (for example the languages); actions need none. */
  label?: string;
  icon?: Icon;
  items: AccountMenuItem[];
}

/** One or two letters for the avatar: the first and last word of the name. */
export function initials(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const chosen = words.length > 1 ? [words[0]!, words.at(-1)!] : words;
  return chosen
    .map((word) => Array.from(word)[0]!.toLocaleUpperCase())
    .join("");
}

/** The width the open menu takes, inside an 8px margin on narrow windows. */
const MENU_WIDTH = 300;
/** Below the button when this much room is left there (or more than above it). */
const ROOM_BELOW = 360;
interface Place {
  top?: number;
  bottom?: number;
  end: number;
  width: number;
  maxHeight: number;
}

/**
 * The signed-in person's menu in the top bar (WAI-ARIA menu button). The button shows their
 * initials and name; Enter, Space or Down Arrow opens the menu on the first item, Up Arrow on the
 * last. In the menu, the arrow keys, Home and End move between items, a letter jumps to the next
 * item starting with it, Escape or Tab closes it, and focus goes back to the button. The menu
 * floats over the page (fixed under the button, or above it when the button is low in the
 * window, as on phones), so opening it never moves anything.
 */
export function AccountMenu({
  name,
  detail,
  groups,
}: {
  name: string;
  /** A second line under the name, such as the username. */
  detail?: string | null;
  groups: AccountMenuGroup[];
}) {
  const t = useT();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<Place>({
    end: 8,
    width: MENU_WIDTH,
    maxHeight: 480,
  });
  const root = useRef<HTMLDivElement>(null),
    button = useRef<HTMLButtonElement>(null),
    menu = useRef<HTMLDivElement>(null);
  const start = useRef<"first" | "last">("first");
  const visible = groups.filter((group) => group.items.length > 0);
  const letters = initials(name);

  const measure = (): Place => {
    const rect = button.current!.getBoundingClientRect();
    const viewport = document.documentElement.clientWidth;
    const height = window.innerHeight;
    const width = Math.min(MENU_WIDTH, viewport - 16);
    const rtl = getComputedStyle(button.current!).direction === "rtl";
    // The menu's inline end lines up with the button's, and the menu stays inside the window.
    const end = Math.round(
      Math.max(
        8,
        Math.min(rtl ? rect.left : viewport - rect.right, viewport - 8 - width),
      ),
    );
    const below = height - rect.bottom - 14,
      above = rect.top - 14;
    return below >= ROOM_BELOW || below >= above
      ? { top: Math.round(rect.bottom + 6), end, width, maxHeight: below }
      : {
          bottom: Math.round(height - rect.top + 6),
          end,
          width,
          maxHeight: above,
        };
  };
  const show = (where: "first" | "last") => {
    start.current = where;
    setPlace(measure());
    setOpen(true);
  };
  // The button sits in the sticky top bar: focus goes back to it without scrolling the page.
  const close = (returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) focusInPlace(button.current);
  };
  const items = () =>
    Array.from(
      menu.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [],
    );
  const focusAt = (index: number) => {
    const list = items();
    if (list.length) list[(index + list.length) % list.length]!.focus();
  };

  useEffect(() => {
    if (!open) return;
    focusAt(start.current === "first" ? 0 : -1);
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) close(false);
    };
    const follow = () => setPlace(measure());
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", follow);
    window.addEventListener("scroll", follow, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("resize", follow);
      window.removeEventListener("scroll", follow, true);
    };
  }, [open]);

  const choose = (item: AccountMenuItem) => {
    if (item.disabled) return;
    // Focus is on the button before the action runs, so a dialog it opens returns focus there.
    close(true);
    item.onSelect();
  };
  const onMenuKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const list = items();
    const index = list.indexOf(document.activeElement as HTMLElement);
    const move = (to: number) => {
      event.preventDefault();
      focusAt(to);
    };
    switch (event.key) {
      case "ArrowDown":
        return move(index + 1);
      case "ArrowUp":
        return move(index - 1);
      case "Home":
      case "PageUp":
        return move(0);
      case "End":
      case "PageDown":
        return move(-1);
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        return close(true);
      case "Tab":
        event.preventDefault();
        return close(true);
    }
    if (
      event.key.length === 1 &&
      /\S/.test(event.key) &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      const key = event.key.toLocaleLowerCase();
      const order = [...list.slice(index + 1), ...list.slice(0, index + 1)];
      const match = order.find((item) =>
        (item.textContent ?? "").trim().toLocaleLowerCase().startsWith(key),
      );
      if (match) {
        event.preventDefault();
        match.focus();
      }
    }
  };

  return (
    <div className="account-menu" ref={root}>
      <button
        ref={button}
        id={`${id}-button`}
        type="button"
        className="account-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? `${id}-menu` : undefined}
        aria-label={t("accountMenu.button", { name })}
        onClick={() => (open ? close(true) : show("first"))}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            show(event.key === "ArrowDown" ? "first" : "last");
          }
        }}
      >
        <span className="account-avatar" aria-hidden="true">
          {letters || <UserRound size={16} />}
        </span>
        <span className="account-name" dir="auto">
          {name}
        </span>
        <ChevronDown
          size={16}
          aria-hidden="true"
          className={`account-chevron ${open ? "open" : ""}`}
        />
      </button>
      {open && (
        <div
          className="account-popover"
          style={{
            top: place.top,
            bottom: place.bottom,
            insetInlineEnd: place.end,
            width: place.width,
            maxHeight: place.maxHeight,
          }}
        >
          <div className="account-identity">
            <span className="account-avatar large" aria-hidden="true">
              {letters || <UserRound size={18} />}
            </span>
            <div>
              <strong dir="auto">{name}</strong>
              {detail && <small dir="ltr">{detail}</small>}
            </div>
          </div>
          <div
            ref={menu}
            id={`${id}-menu`}
            role="menu"
            aria-labelledby={`${id}-button`}
            className="account-items"
            onKeyDown={onMenuKey}
          >
            {visible.map((group, index) => {
              const entries = group.items.map((item) => (
                <MenuEntry key={item.id} item={item} onChoose={choose} />
              ));
              return (
                <Fragment key={group.id}>
                  {index > 0 && (
                    <div role="separator" className="account-separator" />
                  )}
                  {group.label ? (
                    <div role="group" aria-label={group.label}>
                      <div className="account-group-label" aria-hidden="true">
                        {group.icon && <group.icon size={14} />}
                        {group.label}
                      </div>
                      {entries}
                    </div>
                  ) : (
                    entries
                  )}
                </Fragment>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function MenuEntry({
  item,
  onChoose,
}: {
  item: AccountMenuItem;
  onChoose: (item: AccountMenuItem) => void;
}) {
  const common = {
    type: "button" as const,
    tabIndex: -1,
    className: "account-item",
    "aria-disabled": item.disabled || undefined,
    onClick: () => onChoose(item),
  };
  if (item.kind === "radio")
    return (
      <button {...common} role="menuitemradio" aria-checked={item.checked}>
        <span className="account-item-icon">
          {item.checked && <Check size={16} aria-hidden="true" />}
        </span>
        <span lang={item.lang} dir={item.dir}>
          {item.label}
        </span>
      </button>
    );
  return (
    <button
      {...common}
      role="menuitem"
      aria-haspopup={item.opensDialog ? "dialog" : undefined}
    >
      <span className="account-item-icon">
        {item.icon && <item.icon size={17} aria-hidden="true" />}
      </span>
      <span>{item.label}</span>
    </button>
  );
}
