import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import { useStickyHeight } from "../hooks/useStickyHeight";

export interface NavSection {
  /** The id of the section's element on the page. */
  id: string;
  label: string;
}

/**
 * The section being read: the last one whose top has passed the bottom of the link bar (the first
 * one before any has), and the last one at the very end of the page however short it is. Followed
 * as the page scrolls, and as sections open or grow.
 */
function useCurrentSection(
  ids: string[],
  bar: { current: HTMLElement | null },
) {
  const [current, setCurrent] = useState<string>();
  const key = ids.join(" ");
  useEffect(() => {
    const pick = () => {
      const sections = key
        .split(" ")
        .map((id) => document.getElementById(id))
        .filter((el): el is HTMLElement => !!el);
      const offset = (bar.current?.getBoundingClientRect().bottom ?? 0) + 24;
      let found = sections[0];
      for (const section of sections)
        if (section.getBoundingClientRect().top <= offset) found = section;
      if (
        window.innerHeight + window.scrollY >=
        document.documentElement.scrollHeight - 2
      )
        found = sections.at(-1);
      setCurrent(found?.id);
    };
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(pick);
    };
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    const resized =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(schedule);
    resized?.observe(document.body);
    pick();
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      resized?.disconnect();
    };
  }, [key, bar]);
  return current;
}

/**
 * The sticky "On this page" link bar of a long page (styles.css .section-nav), the same on every
 * page: it sticks under the top edge, marks the section being read, and on a narrow screen is one
 * line that scrolls sideways (the far edge fades while there is more, and the current link stays
 * in view). Its height is published as `--section-nav-height`, so anchors, focus and a sticky list
 * below it stop under it. A link opens its section when the section is a closed disclosure.
 */
export function SectionNav({
  label,
  sections,
}: {
  label: string;
  sections: NavSection[];
}) {
  const bar = useRef<HTMLElement | null>(null);
  const publishHeight = useStickyHeight("--section-nav-height");
  const ref = useCallback(
    (element: HTMLElement | null) => {
      bar.current = element;
      publishHeight(element);
    },
    [publishHeight],
  );
  const current = useCurrentSection(
    sections.map((s) => s.id),
    bar,
  );
  useEffect(() => {
    const nav = bar.current,
      list = nav?.querySelector("ol");
    if (!nav || !list) return;
    const fade = () =>
      nav.toggleAttribute(
        "data-overflow",
        list.scrollWidth > list.clientWidth + 1 &&
          Math.abs(list.scrollLeft) + list.clientWidth < list.scrollWidth - 1,
      );
    const link = list.querySelector<HTMLElement>("[aria-current]");
    if (link) {
      const a = link.getBoundingClientRect(),
        box = list.getBoundingClientRect();
      if (a.left < box.left || a.right > box.right)
        list.scrollBy({ left: a.left - box.left - (box.width - a.width) / 2 });
    }
    fade();
    list.addEventListener("scroll", fade, { passive: true });
    window.addEventListener("resize", fade);
    return () => {
      list.removeEventListener("scroll", fade);
      window.removeEventListener("resize", fade);
    };
  }, [current, sections.length]);
  const jump = (id: string) => (event: MouseEvent) => {
    event.preventDefault();
    const target = document.getElementById(id);
    if (target instanceof HTMLDetailsElement) target.open = true;
    target?.scrollIntoView({ block: "start" });
    target?.focus({ preventScroll: true });
  };
  return (
    <nav ref={ref} className="section-nav" aria-label={label}>
      <ol>
        {sections.map((section) => (
          <li key={section.id}>
            <a
              href={`#${section.id}`}
              onClick={jump(section.id)}
              aria-current={current === section.id ? "true" : undefined}
            >
              {section.label}
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}
