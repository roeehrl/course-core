import { expect, test } from "./health";

/* A CI run once lost the press on "Continue learning": the placement offer arrived and
 * was inserted above the button between the mouse going down and coming up, so the
 * click ended on another element and nothing happened. The course page now appears
 * only after its panels have read their state, so nothing moves under the pointer. */
test("the course page appears only after its panels load, so a late card cannot move Continue learning", async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/enrollments/*/placement", async (route) => {
    await held;
    await route.continue();
  });
  const token = (await (await page.request.post("/test/session")).json()).token;
  await page.goto(`/#signin=${token}`);
  await page
    .getByRole("article")
    .filter({ has: page.getByRole("heading", { name: "Ordering values", exact: true }) })
    .getByRole("button", { name: "Open course", exact: true })
    .click();
  await page.getByRole("button", { name: "Start course", exact: true }).click();
  // While placement is still loading the page says it is loading and offers no action.
  await expect(page.getByRole("progressbar", { name: "Loading your saved learning space" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^(Start the course|Start lesson \d+|Continue lesson \d+|Continue learning) →$/ })).toHaveCount(0);
  const before = await page.getByRole("heading", { name: "Already know some of this?" }).count();
  expect(before).toBe(0);
  release();
  const offer = page.getByRole("heading", { name: "Already know some of this?" });
  const resume = page.getByRole("button", { name: /^(Start the course|Start lesson \d+|Continue lesson \d+|Continue learning) →$/ });
  await expect(offer).toBeVisible();
  await expect(resume).toBeVisible();
  // Both arrived together: the button does not move after it first appears.
  const first = await resume.boundingBox();
  await page.waitForTimeout(300);
  expect(await resume.boundingBox()).toEqual(first);
  await resume.click();
  await expect(page.getByRole("button", { name: "Mark this part read", exact: true })).toBeVisible();
});
