import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Check, ChevronDown, LayoutGrid, PackagePlus } from "lucide-react";
import { useI18n } from "../i18n";

export interface SwitcherCourse {
  id: string;
  title: string;
}

/**
 * The open course's name as a button that switches course: a searchable list of the courses,
 * with "Add a course…" (when this person may add one) and "All courses" at the bottom. The search
 * field is a combobox that owns the list: arrow keys move through it, Enter chooses, Escape
 * closes it and gives focus back to the button.
 *
 * `variant="inline"` opens the list in the flow under the button (the navigation drawer, which
 * scrolls); otherwise it opens as a popover.
 */
export function CourseSwitcher({
  courses,
  currentId,
  currentTitle,
  disabled = false,
  variant = "popover",
  className = "",
  onSelect,
  onAdd,
  onAll,
}: {
  courses: SwitcherCourse[];
  currentId: string;
  currentTitle: string;
  disabled?: boolean;
  variant?: "popover" | "inline";
  className?: string;
  onSelect: (courseId: string) => void;
  /** Absent when this person cannot add a course here (the entry is then not offered). */
  onAdd?: (() => void) | undefined;
  onAll: () => void;
}) {
  const i18n = useI18n();
  const t = i18n.t;
  const id = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const needle = query.trim().toLocaleLowerCase(i18n.locale);
  const matches = needle
    ? courses.filter((course) =>
        course.title.toLocaleLowerCase(i18n.locale).includes(needle),
      )
    : courses;
  type Option = { key: string; run: () => void };
  const close = (focusButton: boolean) => {
    setOpen(false);
    setQuery("");
    if (focusButton) button.current?.focus();
  };
  const options: Option[] = [
    ...matches.map((course) => ({
      key: `course:${course.id}`,
      run: () => {
        close(true);
        if (course.id !== currentId) onSelect(course.id);
      },
    })),
    ...(onAdd
      ? [
          {
            key: "add",
            run: () => {
              close(false);
              onAdd();
            },
          },
        ]
      : []),
    {
      key: "all",
      run: () => {
        close(false);
        onAll();
      },
    },
  ];
  const activeIndex = Math.min(active, options.length - 1);
  const optionId = (key: string) =>
    `${id}-${key.replace(/[^A-Za-z0-9_-]/g, "_")}`;
  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) close(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  // Keep the active option in view while the arrow keys move through a long list.
  useEffect(() => {
    if (!open) return;
    const key = options[activeIndex]?.key;
    if (key)
      document
        .getElementById(optionId(key))
        ?.scrollIntoView?.({ block: "nearest" });
  }, [open, activeIndex]);
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((activeIndex + step + options.length) % options.length);
    } else if (event.key === "Home" && !query) {
      event.preventDefault();
      setActive(0);
    } else if (event.key === "End" && !query) {
      event.preventDefault();
      setActive(options.length - 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      options[activeIndex]?.run();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === "Tab") close(false);
  };
  const listId = `${id}-list`;
  const option = (
    key: string,
    content: ReactNode,
    extra: { selected?: boolean; dir?: "auto" } = {},
  ) => {
    const index = options.findIndex((item) => item.key === key);
    return (
      <li
        key={key}
        id={optionId(key)}
        role="option"
        aria-selected={extra.selected ?? false}
        className={`course-switcher-option${index === activeIndex ? " active" : ""}`}
        dir={extra.dir}
        onMouseDown={(event) => event.preventDefault()}
        onMouseMove={() => index !== activeIndex && setActive(index)}
        onClick={() => options[index]?.run()}
      >
        {content}
      </li>
    );
  };
  return (
    <div
      ref={root}
      className={`course-switcher is-${variant} ${className}`.trim()}
    >
      <button
        ref={button}
        type="button"
        className="course-switcher-button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={t("adminApp.switcher.label", { title: currentTitle })}
        disabled={disabled}
        onClick={() => {
          if (open) close(false);
          else {
            setActive(
              Math.max(
                0,
                courses.findIndex((c) => c.id === currentId),
              ),
            );
            setOpen(true);
          }
        }}
      >
        <span className="course-switcher-title" dir="auto">
          {currentTitle}
        </span>
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      {open && (
        <div className="course-switcher-popup">
          <input
            ref={input}
            type="search"
            className="course-switcher-search"
            role="combobox"
            aria-label={t("adminApp.switcher.search")}
            placeholder={t("adminApp.switcher.search")}
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={
              options[activeIndex]
                ? optionId(options[activeIndex].key)
                : undefined
            }
            autoComplete="off"
            dir="auto"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
          />
          <ul
            id={listId}
            role="listbox"
            aria-label={t("adminApp.switcher.courses")}
            className="course-switcher-list"
          >
            <li role="presentation">
              <ul role="group" aria-label={t("adminApp.switcher.courses")}>
                {matches.map((course) =>
                  option(
                    `course:${course.id}`,
                    <>
                      <span className="course-switcher-name" dir="auto">
                        {course.title}
                      </span>
                      {course.id === currentId && (
                        <Check
                          size={16}
                          aria-label={t("adminApp.switcher.current")}
                        />
                      )}
                    </>,
                    { selected: course.id === currentId },
                  ),
                )}
              </ul>
            </li>
            <li role="presentation" className="course-switcher-actions">
              <ul role="group" aria-label={t("adminApp.switcher.actions")}>
                {onAdd &&
                  option(
                    "add",
                    <>
                      <PackagePlus size={16} aria-hidden="true" />
                      <span>{t("adminApp.switcher.add")}</span>
                    </>,
                  )}
                {option(
                  "all",
                  <>
                    <LayoutGrid size={16} aria-hidden="true" />
                    <span>{t("adminApp.switcher.manage")}</span>
                  </>,
                )}
              </ul>
            </li>
          </ul>
          {!matches.length && (
            <p className="course-switcher-empty" role="status">
              {t("adminApp.switcher.none", { query: query.trim() })}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
