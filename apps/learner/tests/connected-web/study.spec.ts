import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { chooseFromMenu } from "./learner-menu";

const accessible = async (page: Page) => {
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
};
const companion = (page: Page) => page.locator('[aria-label="Your companion"]').or(page.getByRole("button", { name: "Companion", exact: true }));

test("a learner reads the study explanation, joins explicitly, gets the fixed path without the companion, and leaves", async ({ page, request }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const signIn = await request.post("/test/study-session");
  await page.goto(`/#signin=${(await signIn.json()).token}`);
  await page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Study ordering", exact: true }) })
    .getByRole("button", { name: "Open course", exact: true }).click();
  await page.getByRole("button", { name: "Start course", exact: true }).click();
  const prompt = page.getByRole("region", { name: "Join a research study? Ordering study" });
  await expect(prompt).toBeVisible();
  await expect(prompt.getByText(/A fair, random draw places you/)).toBeVisible();
  await expect(prompt.getByText(/conversations with the AI companion/)).toBeVisible();
  // Before joining, the course is the standard one.
  await expect(companion(page).first()).toBeAttached();
  await expect(prompt.getByRole("button", { name: "Join the study" })).toBeDisabled();
  await accessible(page);
  await page.screenshot({ path: info.outputPath("study-prompt.png"), fullPage: true });
  await prompt.getByRole("checkbox", { name: "I have read this and agree to take part" }).check();
  await prompt.getByRole("button", { name: "Join the study" }).click();
  await expect(prompt).toHaveCount(0);
  // The fixed path: the companion is not offered.
  await expect(companion(page)).toHaveCount(0);

  await chooseFromMenu(page, "My profile");
  const settings = page.getByRole("region", { name: "Research study: Ordering study" });
  await expect(settings.getByText(/Your study code is P[0-9A-F]{10}/)).toBeVisible();
  await expect(settings.getByText(/Your version: The fixed lesson path/)).toBeVisible();
  await expect(page.getByText(/has no personal support\. Leave the study to turn it on\./)).toBeVisible();
  await accessible(page);
  await settings.getByRole("button", { name: "Leave the study" }).click();
  const confirm = settings.getByRole("group", { name: "Confirm leaving the study" });
  await expect(confirm).toContainText("your data is left out of the study");
  await accessible(page);
  await confirm.getByRole("button", { name: "Leave the study" }).click();
  await expect(settings.getByText(/You left this study/)).toBeVisible();
  await expect(companion(page).first()).toBeAttached();
  await page.reload();
  await page.getByRole("button", { name: "Continue learning →", exact: true }).click();
  await chooseFromMenu(page, "My profile");
  await expect(page.getByRole("region", { name: "Research study: Ordering study" }).getByText(/You left this study/)).toBeVisible();
  await accessible(page);
  expect(errors).toEqual([]);
});
