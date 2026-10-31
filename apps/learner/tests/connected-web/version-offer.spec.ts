import { expect, test, type Page } from "./health";
import AxeBuilder from "@axe-core/playwright";

const accessible = async (page: Page) => {
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
};

// Real API and PostgreSQL: the course team moved everyone to version 2.0.0, but this learner has a
// personal change, so they were offered the move instead. They accept; the move drops (archives)
// their personal change and the app says what happened.
test("a learner with personal changes is offered the new version, sees what it drops, and moves when they accept", async ({ page, request }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const signIn = await request.post("/test/version-offer-session");
  expect(signIn.ok(), await signIn.text()).toBe(true);
  await page.goto(`/#signin=${(await signIn.json()).token}`);
  // Home: the course is listed once, on a card that says a newer version is waiting for a choice.
  const card = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Version offer ordering", exact: true }) });
  await expect(card).toHaveCount(1);
  await expect(card).toContainText("New version");
  await expect(card).toContainText("Version 1.0.0 · active");
  await expect(card).toContainText("Version 2.0.0 of this course is available");
  await expect(card).toContainText("Your course team invited you to move to it.");
  await expect(card.getByRole("button", { name: /from the beginning/ })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Available in your workspace" })).toHaveCount(0);
  await accessible(page);
  await page.screenshot({ path: info.outputPath("version-offer-home.png") });
  await card.getByRole("button", { name: /^(Start the course|Start lesson \d+|Continue lesson \d+|Continue learning) →$/ }).click();
  const offer = page.getByRole("region", { name: "Your course has a new version" });
  await expect(offer).toBeVisible();
  await expect(offer).toContainText("Version 2.0.0 of your course is available (you are on 1.0.0).");
  await expect(offer).toContainText("drops your personal changes: Minimum. Move now?");
  await expect(offer).toContainText("archived, not deleted");
  await accessible(page);
  await page.screenshot({ path: info.outputPath("version-offer.png"), fullPage: true });
  await offer.getByRole("button", { name: "Move now" }).click();
  await expect(page.getByText("Done: you are on the new version now.")).toBeVisible();
  await expect(offer).toHaveCount(0);
  const notice = page.getByRole("status", { name: "Your course was updated" });
  await expect(notice).toContainText("moved from version 1.0.0 to version 2.0.0");
  await expect(notice).toContainText("As you chose, your personal changes were set aside for the new version.");
  await accessible(page);
  expect(errors).toEqual([]);
});
