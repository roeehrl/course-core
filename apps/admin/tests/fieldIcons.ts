import type { Locator } from "@playwright/test";

/** A box in viewport pixels. */
export interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** A visible text field that has an icon or a sign (an `<svg>`, or an `aria-hidden` element such
 * as a "$") in the same wrapper, measured in the browser. */
export interface FieldWithIcons {
  /** The field's id, or the start of its markup. */
  field: string;
  /** The field's resolved CSS direction. */
  direction: string;
  /** The field's border box. */
  outer: Box;
  /** Where the placeholder, typed text and the browser's clear button render: the content box,
   * inside the border and padding. The browser clips the text to it, so an icon that stays out
   * of this box cannot cover any of it, whatever is typed. */
  text: Box;
  icons: { icon: string; box: Box; overlapX: number; overlapY: number }[];
}

/**
 * Every visible text field under `scope` that shares its wrapper with an icon or sign, with the
 * boxes of both. An icon intersects the text when both `overlapX` and `overlapY` are positive.
 */
export function fieldsWithIcons(scope: Locator): Promise<FieldWithIcons[]> {
  return scope.evaluate((root) => {
    const px = (value: string) => parseFloat(value) || 0;
    const round = (n: number) => Math.round(n * 10) / 10;
    const box = (r: DOMRect) => ({
      left: round(r.left),
      right: round(r.right),
      top: round(r.top),
      bottom: round(r.bottom),
    });
    const fields = root.querySelectorAll<HTMLElement>(
      'input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"]), textarea, select',
    );
    const found: FieldWithIcons[] = [];
    for (const field of fields) {
      const wrap = field.parentElement;
      if (!wrap || !field.checkVisibility()) continue;
      const icons = [
        ...wrap.querySelectorAll<Element>('svg, [aria-hidden="true"]'),
      ].filter(
        (icon) =>
          !field.contains(icon) &&
          !icon.parentElement?.closest("svg") &&
          icon.checkVisibility() &&
          icon.getBoundingClientRect().width > 0,
      );
      if (!icons.length) continue;
      const r = field.getBoundingClientRect(),
        style = getComputedStyle(field);
      const text = {
        left: round(r.left + px(style.borderLeftWidth) + px(style.paddingLeft)),
        right: round(
          r.right - px(style.borderRightWidth) - px(style.paddingRight),
        ),
        top: round(r.top + px(style.borderTopWidth) + px(style.paddingTop)),
        bottom: round(
          r.bottom - px(style.borderBottomWidth) - px(style.paddingBottom),
        ),
      };
      found.push({
        field: field.id || field.outerHTML.slice(0, 80),
        direction: style.direction,
        outer: box(r),
        text,
        icons: icons.map((icon) => {
          const b = icon.getBoundingClientRect();
          return {
            icon: icon.outerHTML.slice(0, 60),
            box: box(b),
            overlapX: round(
              Math.min(text.right, b.right) - Math.max(text.left, b.left),
            ),
            overlapY: round(
              Math.min(text.bottom, b.bottom) - Math.max(text.top, b.top),
            ),
          };
        }),
      });
    }
    return found;
  });
}

/** One line per icon that covers part of its field's text box, for an `expect(...).toEqual([])`. */
export async function fieldIconOverlaps(
  scope: Locator,
  where = "",
): Promise<string[]> {
  return (await fieldsWithIcons(scope)).flatMap((field) =>
    field.icons
      .filter((icon) => icon.overlapX > 0 && icon.overlapY > 0)
      .map(
        (icon) =>
          `${where}${field.field}: ${icon.icon} covers ${icon.overlapX}px of the text box (${field.direction})`,
      ),
  );
}
