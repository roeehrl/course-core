import { test, expect, type Locator, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { workspaceNav } from "../workspaceNav";
import enApp from "../../src/i18n/messages/en/adminApp.json" with { type: "json" };
import heApp from "../../src/i18n/messages/he/adminApp.json" with { type: "json" };
import enAi from "../../src/i18n/messages/en/aiServices.json" with { type: "json" };
import heAi from "../../src/i18n/messages/he/aiServices.json" with { type: "json" };
import enSignIn from "../../src/i18n/messages/en/signIn.json" with { type: "json" };
import heSignIn from "../../src/i18n/messages/he/signIn.json" with { type: "json" };

/**
 * Tablets show a sticky top app bar (menu button, section name, course picker). Nothing the page
 * scrolls to may end up under it: a link to a section, the browser scrolling a control into view
 * and keyboard focus all stop below the bar, at its measured height, also after the bar grows.
 * Checked on AI services → Spending limits, whose per-learner choice is a pair of small radios,
 * at 768, 834 and 1024px in English and Hebrew, with axe including WCAG 2.2 target size.
 * The test sets its own window sizes, so it runs once, in the desktop project.
 */
const CATALOGS = {
  en: { app: enApp, ai: enAi, signIn: enSignIn },
  he: { app: heApp, ai: heAi, signIn: heSignIn },
} as const;
const WCAG = ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"];

async function barBottom(page: Page) {
  const box = (await page.locator(".app-bar").boundingBox())!;
  return box.y + box.height;
}
async function expectBelowBar(page: Page, target: Locator, what: string) {
  const box = (await target.boundingBox())!;
  expect(box.y, `${what} starts below the bar`).toBeGreaterThanOrEqual(
    await barBottom(page),
  );
}
async function expectAccessible(page: Page, what: string) {
  expect(
    (await new AxeBuilder({ page }).withTags(WCAG).analyze()).violations.map(
      (v) => `${what}: ${v.id} ${v.nodes.map((n) => n.target).join(" ")}`,
    ),
  ).toEqual([]);
}
const publishedHeight = (page: Page) =>
  page.evaluate(() =>
    document.documentElement.style.getPropertyValue("--app-bar-height"),
  );

for (const width of [768, 834, 1024])
  for (const locale of ["en", "he"] as const)
    test(`nothing scrolls under the sticky app bar on AI services at ${width}px (${locale}) @desktop-only`, async ({
      page,
    }) => {
      const { app, ai, signIn } = CATALOGS[locale];
      await page.setViewportSize({ width, height: 900 });
      const fixture = await (
        await page.request.post("/test/pricing-fixture")
      ).json();
      await page.goto(`/admin/?locale=${locale}`);
      await page.getByLabel(signIn["code"]).fill(fixture.code);
      await page
        .getByRole("button", { name: signIn["useCode"], exact: true })
        .click();
      await (
        await workspaceNav(page)
      )
        .getByRole("button", { name: app["nav.providers"], exact: true })
        .click();
      const bar = page.locator(".app-bar");
      await expect(bar).toBeVisible();
      const spending = page.locator("#ai-spending");
      const perLearner = spending.getByRole("radio", {
        name: ai["spending.learnerLimitOption"],
      });
      await expect(perLearner).toBeVisible();

      // The page's scroll padding is the bar's measured height plus a gap.
      const height = Math.ceil((await bar.boundingBox())!.height);
      expect(await publishedHeight(page)).toBe(`${height}px`);
      expect(
        await page.evaluate(
          () => getComputedStyle(document.documentElement).scrollPaddingTop,
        ),
      ).toBe(`${height + 12}px`);

      // A link to the section, the browser scrolling a control into view, and focus.
      await page.locator('a[href="#ai-spending"]').first().click();
      await expectBelowBar(page, spending, "Spending limits after its link");
      await perLearner.evaluate((el) => el.scrollIntoView());
      await expectBelowBar(page, perLearner, "per-learner radio");
      await perLearner.check();
      await expectBelowBar(page, perLearner, "per-learner radio after a tap");
      await expectAccessible(page, `${width}px ${locale}`);
      // Scrolled so the radio sits under the bar, then focused (as Tab would): the browser
      // scrolls it back out from under the bar.
      await perLearner.evaluate((el) => {
        el.blur();
        window.scrollBy(0, el.getBoundingClientRect().top - 20);
      });
      expect((await perLearner.boundingBox())!.y).toBeLessThan(
        await barBottom(page),
      );
      await perLearner.focus();
      await expect(perLearner).toBeFocused();
      await expectBelowBar(page, perLearner, "focused per-learner radio");

      // A taller bar (a wrapped title, larger text): the padding follows it.
      await bar.evaluate((el) => {
        el.style.minHeight = "128px";
      });
      await expect.poll(() => publishedHeight(page)).toBe("128px");
      await perLearner.evaluate((el) => el.scrollIntoView());
      await expectBelowBar(page, perLearner, "per-learner radio, taller bar");
      await expectAccessible(page, `${width}px ${locale}, taller bar`);
    });
