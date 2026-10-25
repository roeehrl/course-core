import type { Locator, Page } from "@playwright/test";

/** A horizontal extent in CSS pixels, measured from the field's border-box left edge. */
export interface Extent {
  left: number;
  right: number;
}

/** Where a field's visible text (its placeholder or its value) is drawn. */
export interface FieldText {
  /** The content box: inside the border and padding, where the browser draws the text. */
  content: Extent;
  /** Each line of drawn text, top to bottom. */
  lines: Extent[];
  /** The text's last line hugs the content box's left or right edge (within 3px). */
  hugsLeft: boolean;
  hugsRight: boolean;
}

/**
 * Measures where a field's placeholder or typed text is actually painted. The text inside an
 * input or textarea (and its placeholder) lives in the browser's own shadow tree, out of reach of
 * layout APIs, so this takes a screenshot of the field and finds the pixels that differ from its
 * background in its content box. Short lines show the alignment: the last line of a start-aligned
 * Hebrew placeholder hugs the right edge, an English one the left edge. The caret is hidden and a
 * textarea's resize grip is switched off while measuring.
 */
export async function fieldText(field: Locator): Promise<FieldText> {
  const content = await field.evaluate((element) => {
    (element as HTMLElement).style.resize = "none";
    const r = element.getBoundingClientRect(),
      s = getComputedStyle(element),
      px = (value: string) => parseFloat(value) || 0;
    return {
      width: r.width,
      left: px(s.borderLeftWidth) + px(s.paddingLeft),
      right: r.width - px(s.borderRightWidth) - px(s.paddingRight),
      top: px(s.borderTopWidth) + px(s.paddingTop),
      bottom: r.height - px(s.borderBottomWidth) - px(s.paddingBottom),
    };
  });
  const png = await field.screenshot({ animations: "disabled", caret: "hide" });
  const lines = await (field.page() as Page).evaluate(
    async ({ data, box }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${data}`;
      await image.decode();
      const scale = image.width / box.width;
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d")!;
      context.drawImage(image, 0, 0);
      const { data: pixels } = context.getImageData(
        0,
        0,
        image.width,
        image.height,
      );
      const x0 = Math.ceil(box.left * scale),
        x1 = Math.floor(box.right * scale),
        y0 = Math.ceil(box.top * scale),
        y1 = Math.floor(box.bottom * scale);
      const at = (x: number, y: number) => (y * image.width + x) * 4;
      // The background is the content box's most common colour.
      const counts = new Map<number, number>();
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++) {
          const i = at(x, y),
            key = (pixels[i]! << 16) | (pixels[i + 1]! << 8) | pixels[i + 2]!;
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
      const background = [...counts].sort((a, b) => b[1] - a[1])[0]![0];
      const ink = (x: number, y: number) => {
        const i = at(x, y);
        return (
          Math.abs(pixels[i]! - ((background >> 16) & 255)) +
            Math.abs(pixels[i + 1]! - ((background >> 8) & 255)) +
            Math.abs(pixels[i + 2]! - (background & 255)) >
          90
        );
      };
      const found: { left: number; right: number }[] = [];
      let open = false;
      for (let y = y0; y < y1; y++) {
        let left = Infinity,
          right = -Infinity;
        for (let x = x0; x < x1; x++)
          if (ink(x, y)) {
            left = Math.min(left, x);
            right = Math.max(right, x + 1);
          }
        if (right < 0) {
          open = false;
          continue;
        }
        if (!open) found.push({ left, right });
        const line = found[found.length - 1]!;
        line.left = Math.min(line.left, left);
        line.right = Math.max(line.right, right);
        open = true;
      }
      return found.map((line) => ({
        left: line.left / scale,
        right: line.right / scale,
      }));
    },
    { data: png.toString("base64"), box: content },
  );
  const last = lines[lines.length - 1];
  return {
    content: { left: content.left, right: content.right },
    lines,
    hugsLeft: !!last && last.left - content.left <= 3,
    hugsRight: !!last && content.right - last.right <= 3,
  };
}

/**
 * Visible empty text fields under `scope` that do not resolve to the page's direction. A
 * free-text field has no dir attribute and keeps the UI's direction; one marked dir="auto"
 * resolves to left to right while it is empty, so in Hebrew its caret and placeholder start at
 * the left. Fields marked dir="ltr" (codes, URLs, emails) are left to right on purpose.
 */
export function emptyFieldsAgainstPage(scope: Locator): Promise<string[]> {
  return scope.evaluate((root) => {
    const page = document.documentElement.dir === "rtl" ? "rtl" : "ltr";
    return [
      ...root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
        'textarea, input:is(:not([type]), [type="text"], [type="search"])',
      ),
    ]
      .filter(
        (field) =>
          field.value === "" &&
          field.getAttribute("dir") !== "ltr" &&
          field.checkVisibility() &&
          !field.matches(`:dir(${page})`),
      )
      .map(
        (field) =>
          `${field.id || field.outerHTML.slice(0, 80)} is ${page === "rtl" ? "ltr" : "rtl"}`,
      );
  });
}
