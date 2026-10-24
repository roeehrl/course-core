import { test, expect, type Browser } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const axeTags = ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"];
async function signIn(
  browser: Browser,
  baseURL: string,
  code: string,
  info: {
    project: {
      use: {
        isMobile?: boolean;
        viewport?: { width: number; height: number } | null;
      };
    };
  },
) {
  const context = await browser.newContext({
    baseURL,
    ...(info.project.use.viewport
      ? { viewport: info.project.use.viewport }
      : {}),
    ...(info.project.use.isMobile ? { isMobile: true, hasTouch: true } : {}),
  });
  const page = await context.newPage();
  await page.goto("/admin/");
  await page.getByLabel("One-time sign-in code").fill(code);
  await page.getByRole("button", { name: "Use code", exact: true }).click();
  return page;
}

// Real API and PostgreSQL: the staff notification center reads its conditions from their sources
// (a failed AI run, the AI budget at 90%), shows each only to roles that can act on it, and opens
// the place to act.
test("the staff bell shows failed runs and the budget, by role, and opens the run inspector", async ({
  page,
  browser,
}, info) => {
  const fixture = await (
    await page.request.post("/test/notifications-fixture")
  ).json();
  const baseURL = info.project.use.baseURL!;

  const owner = await signIn(browser, baseURL, fixture.ownerCode, info);
  const bell = owner.getByRole("button", { name: /^Notifications, \d+ unread$/ });
  await expect(bell).toBeVisible();
  await bell.click();
  const panel = owner.getByRole("dialog", { name: "Needs attention" });
  await expect(panel.getByText("1 AI run failed in the last day")).toBeVisible();
  await expect(panel.getByText("AI spending is at 90% of the limit")).toBeVisible();
  expect(
    (await new AxeBuilder({ page: owner }).withTags(axeTags).analyze())
      .violations,
  ).toEqual([]);
  await expect(
    owner.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    ),
  ).resolves.toBeLessThanOrEqual(1);
  await panel
    .getByRole("listitem")
    .filter({ hasText: "AI run failed" })
    .getByRole("button", { name: "Go there" })
    .click();
  await expect(owner.getByRole("heading", { level: 1 })).toHaveText(
    "Run inspector",
  );
  // Opening it marked it read; the server keeps that.
  await owner.reload();
  await owner.getByRole("button", { name: /^Notifications/ }).click();
  await expect(
    owner
      .getByRole("listitem")
      .filter({ hasText: "AI run failed" })
      .getByText("New"),
  ).toHaveCount(0);

  // An instructor inspects runs but does not manage the budget.
  const instructor = await signIn(browser, baseURL, fixture.instructorCode, info);
  await instructor
    .getByRole("button", { name: /^Notifications, \d+ unread$/ })
    .click();
  const theirs = instructor.getByRole("dialog", { name: "Needs attention" });
  await expect(theirs.getByText("1 AI run failed in the last day")).toBeVisible();
  await expect(theirs.getByText(/AI spending/)).toHaveCount(0);
});
