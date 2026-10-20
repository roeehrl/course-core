import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { chooseFromMenu } from "./learner-menu";

// A learner links two of their own courses in My profile, sees the suggestions one coordinator pass
// stores from the staff mapping, confirms one and dismisses another, then turns sharing off again,
// at phone, tablet and desktop sizes, with no axe violations and no sideways scrolling.
async function accessible(page: Page) {
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
}

test("a learner opts in per course pair, acts on suggestions, and can turn sharing off", async ({ page, request }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const session = await (await request.post("/test/cross-course-session")).json();
  await page.goto(`/#signin=${session.token}`);
  await page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Ordering practice", exact: true }) })
    .getByRole("button", { name: "Open course", exact: true }).click();
  await page.getByRole("button", { name: "Start course", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Ordering practice", exact: true })).toBeVisible();
  await chooseFromMenu(page, "My profile");
  const panel = page.getByRole("region", { name: "Sharing between your courses" });
  const toggle = panel.getByRole("checkbox", { name: "Share with Ordering values" });
  await expect(toggle).not.toBeChecked();
  await expect(panel.getByText(/never your answers, questions, notes or goal/)).toBeVisible();
  await accessible(page);

  await toggle.check();
  await expect(panel.getByText("Sharing with Ordering values is on.")).toBeVisible();
  // One pass of the learner's coordinator (the host call its Temporal workflow makes).
  expect(await (await request.post("/test/cross-course-plan", { data: { learnerId: session.learnerId, workspaceId: session.workspaceId } })).json())
    .toMatchObject({ status: "planned", created: 3 });
  await chooseFromMenu(page, "Learning path");
  await chooseFromMenu(page, "My profile");
  const shown = panel.getByRole("article", { name: "You already showed “Find a minimum.” in Ordering values" });
  await expect(shown).toBeVisible();
  await expect(shown.getByText(/It does not count as passing here/)).toBeVisible();
  await expect(panel.getByRole("article", { name: "Pacing across your courses" })).toBeVisible();
  await accessible(page);
  await shown.getByRole("button", { name: /^Confirm/ }).click();
  await expect(panel.getByText("Thanks. This course was told.")).toBeVisible();
  await expect(shown.getByText("Confirmed")).toBeVisible();
  await panel.getByRole("article", { name: "Pacing across your courses" }).getByRole("button", { name: /^Dismiss/ }).click();
  await expect(panel.getByRole("article", { name: "Pacing across your courses" }).getByText("Dismissed")).toBeVisible();
  await accessible(page);

  // Turning sharing off removes everything shared through the pair.
  await toggle.uncheck();
  await expect(panel.getByText("Sharing with Ordering values is off. What was shared was removed.")).toBeVisible();
  await expect(panel.getByRole("article")).toHaveCount(0);
  await expect(toggle).not.toBeChecked();
  await accessible(page);
  expect(errors).toEqual([]);
});
