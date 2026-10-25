import type { Locator } from "@playwright/test";

/**
 * Visible text with Hebrew letters that is letter-spaced or case-transformed, one line per
 * element. Tracked capitals are for Latin script: Hebrew has no capitals, and letter-spacing
 * pulls its words apart (docs/i18n.md). Negative tracking (tightened display headings) is allowed.
 */
export function trackedHebrew(scope: Locator): Promise<string[]> {
  return scope.evaluate((root) => {
    const found: string[] = [];
    const seen = new Set<Element>();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = (node.textContent ?? "").trim();
      const element = node.parentElement;
      if (!element || !/[֐-׿]/.test(text) || seen.has(element)) continue;
      seen.add(element);
      if (!element.checkVisibility()) continue;
      const style = getComputedStyle(element);
      const spacing =
        style.letterSpacing === "normal" ? 0 : parseFloat(style.letterSpacing);
      if (spacing > 0 || style.textTransform !== "none")
        found.push(
          `<${element.tagName.toLowerCase()} class="${element.getAttribute("class") ?? ""}"> letter-spacing ${style.letterSpacing}, text-transform ${style.textTransform}: ${text.slice(0, 40)}`,
        );
    }
    return found;
  });
}
