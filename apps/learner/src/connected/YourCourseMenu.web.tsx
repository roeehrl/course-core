import React, { useEffect, useId, useRef, useState } from "react";

export interface MenuItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  /** Marks the view that is currently shown. */
  current?: boolean;
}
export interface MenuGroup {
  label: string;
  items: MenuItem[];
}

/** The secondary "Your course" control: profile, record and settings live here,
 * away from the one primary learning action. It is a disclosure (a button that
 * shows a list of ordinary buttons), not an ARIA menu, so Tab, Enter and screen
 * reader browse modes all work as they do elsewhere on the page. Escape or a
 * click outside closes it and returns focus to its button. */
export function YourCourseMenu({
  label,
  description,
  groups,
}: {
  label: string;
  /** Who is signed in, shown at the top of the open list. */
  description?: string;
  groups: MenuGroup[];
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLDivElement>(null),
    toggle = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    // Escape is heard on the document: Safari does not focus a button on click,
    // so after opening the list with a pointer the focus may still be on the page.
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      toggle.current?.focus();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  const visible = groups.filter((group) => group.items.length > 0);
  return (
    <div
      className="connected-menu"
      ref={root}
      onBlur={(event) => {
        if (
          open &&
          !event.currentTarget.contains(event.relatedTarget as Node | null) &&
          event.relatedTarget
        )
          setOpen(false);
      }}
    >
      <button
        ref={toggle}
        type="button"
        className="connected-menu-toggle"
        aria-expanded={open}
        aria-controls={`${id}-panel`}
        onClick={() => setOpen((value) => !value)}
      >
        {label} <span aria-hidden="true">{open ? "▴" : "▾"}</span>
      </button>
      <div id={`${id}-panel`} className="connected-menu-panel" hidden={!open}>
        {description && (
          <p className="connected-menu-description">{description}</p>
        )}
        {visible.map((group, index) => (
          <div
            key={group.label}
            role="group"
            aria-labelledby={`${id}-group-${index}`}
          >
            <p className="connected-menu-heading" id={`${id}-group-${index}`}>
              {group.label}
            </p>
            <ul>
              {group.items.map((item) => (
                <li key={item.label}>
                  <button
                    type="button"
                    disabled={item.disabled}
                    aria-current={item.current ? "page" : undefined}
                    onClick={() => {
                      setOpen(false);
                      item.onSelect();
                    }}
                  >
                    {item.label}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}
