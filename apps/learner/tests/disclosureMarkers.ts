import { expect, type Locator, type Page } from "@playwright/test";

/** What one <summary> paints as its open/closed indicator. */
export type DisclosureMarker = {
  label: string;
  open: boolean;
  /** The engine's own marker is still drawn (::marker or the legacy
   * ::-webkit-details-marker that older Safari/iOS paints). */
  nativeMarker: boolean;
  /** The design's chevron (::before) is drawn. */
  chevron: boolean;
  /** The chevron's rotation in degrees (-45 closed/right, 45 open/down). */
  rotation: number | null;
  /** Text that ended up in the accessible name from a glyph marker. */
  glyphInName: boolean;
};

/** Inspect every visible <summary> under `scope`. */
export function disclosureMarkers(
  page: Page,
  scope = ".connected-host",
): Promise<DisclosureMarker[]> {
  return page.evaluate((selector) => {
    const rules = Array.from(document.styleSheets).flatMap((sheet) => {
      try {
        return Array.from(sheet.cssRules);
      } catch {
        return [];
      }
    });
    const legacyHidden = (summary: Element) =>
      rules.some((rule) => {
        if (!(rule instanceof CSSStyleRule)) return false;
        if (rule.style.display !== "none") return false;
        return rule.selectorText.split(",").some((part) => {
          const trimmed = part.trim();
          if (!trimmed.endsWith("::-webkit-details-marker")) return false;
          try {
            return summary.matches(
              trimmed.slice(0, -"::-webkit-details-marker".length),
            );
          } catch {
            return false;
          }
        });
      });
    return Array.from(document.querySelectorAll(selector))
      .flatMap((root) =>
        Array.from(root.querySelectorAll<HTMLElement>("details > summary")),
      )
      .filter((el) => el.getClientRects().length > 0)
      .map((summary) => {
        const style = getComputedStyle(summary);
        const marker = getComputedStyle(summary, "::marker");
        const before = getComputedStyle(summary, "::before");
        const listMarker =
          style.display === "list-item" &&
          style.listStyleType !== "none" &&
          marker.content !== '""' &&
          marker.content !== "none";
        const chevron =
          before.content !== "none" &&
          before.content !== "normal" &&
          before.display !== "none" &&
          parseFloat(before.borderRightWidth) > 0 &&
          parseFloat(before.borderBottomWidth) > 0 &&
          before.borderRightStyle !== "none" &&
          before.borderRightColor !== "rgba(0, 0, 0, 0)";
        const matrix = before.transform.match(/^matrix\(([^)]+)\)$/);
        const [a, b] = matrix ? matrix[1]!.split(",").map(Number) : [];
        return {
          label: (summary.textContent ?? "").trim().slice(0, 50),
          open: (summary.parentElement as HTMLDetailsElement).open,
          nativeMarker: listMarker || !legacyHidden(summary),
          chevron,
          rotation:
            a === undefined || b === undefined
              ? null
              : Math.round((Math.atan2(b, a) * 180) / Math.PI),
          glyphInName: /[▸▾▶▼►]/.test(summary.textContent ?? ""),
        };
      });
  }, scope);
}

/** Every visible disclosure shows exactly one indicator, in the right state. */
export async function expectOneIndicatorEach(page: Page, scope?: string) {
  const markers = await disclosureMarkers(page, scope);
  expect(markers.length).toBeGreaterThan(0);
  for (const marker of markers)
    expect(marker, marker.label).toMatchObject({
      nativeMarker: false,
      chevron: true,
      rotation: marker.open ? 45 : -45,
      glyphInName: false,
    });
  return markers;
}

/** Toggle one disclosure and check its native expanded state and chevron follow. */
export async function expectToggleSemantics(
  page: Page,
  details: Locator,
  scope?: string,
) {
  const summary = details.locator(":scope > summary");
  await expect(summary).not.toHaveAttribute("aria-expanded");
  await expect(summary).not.toHaveAttribute("role");
  const wasOpen = await details.evaluate(
    (el) => (el as HTMLDetailsElement).open,
  );
  const label = ((await summary.textContent()) ?? "").trim().slice(0, 50);
  for (const open of [!wasOpen, wasOpen]) {
    await summary.click();
    // The native <details> open state is what assistive technology reports as
    // expanded/collapsed (the summary carries no role or aria-expanded override);
    // the content follows it.
    await expect(details).toHaveJSProperty("open", open);
    const content = details.locator(":scope > :not(summary)").first();
    if (open) await expect(content).toBeVisible();
    else await expect(content).toBeHidden();
    const marker = (await disclosureMarkers(page, scope)).find(
      (entry) => entry.label === label,
    );
    expect(marker, label).toMatchObject({
      open,
      nativeMarker: false,
      chevron: true,
      rotation: open ? 45 : -45,
    });
  }
}
