import { expect, test } from "@playwright/test";
import { chooseFromMenu } from "./learner-menu";
import AxeBuilder from "@axe-core/playwright";

test("learner controls persist across reload without changing required learning and are accessible at every viewport", async ({
  page,
  request,
}, testInfo) => {
  const signIn = await request.post("/test/session");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`/#signin=${(await signIn.json()).token}`);
  await page
    .getByRole("article")
    .filter({
      has: page.getByRole("heading", { name: "Ordering values", exact: true }),
    })
    .getByRole("button", { name: "Open course", exact: true })
    .click();
  await page.getByRole("button", { name: "Start course", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Ordering values", exact: true }),
  ).toBeVisible();
  await chooseFromMenu(page, "My profile");
  await expect(
    page.getByRole("button", { name: "Enable personal support", exact: true }),
  ).toBeVisible();
  const writes: Array<Record<string, unknown>> = [];
  page.on("request", (r) => {
    if (
      r.method() === "POST" &&
      new URL(r.url()).pathname.endsWith("/supervision")
    )
      writes.push(r.postDataJSON());
  });
  await page
    .getByRole("button", { name: "Enable personal support", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Turn off personal support",
      exact: true,
    }),
  ).toBeVisible();
  await page.reload();
  await page
    .getByRole("button", { name: "Continue learning →", exact: true })
    .click();
  await chooseFromMenu(page, "My profile");
  await expect(
    page.getByRole("button", {
      name: "Turn off personal support",
      exact: true,
    }),
  ).toBeVisible();
  expect(writes).toHaveLength(1);
  await page
    .getByRole("button", { name: "Turn off personal support", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Enable personal support", exact: true }),
  ).toBeVisible();
  expect(writes).toHaveLength(2);
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("supervisor-permission.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "← Back to learning", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Continue learning →", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Minimum", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Complete episode →", exact: true }),
  ).toBeDisabled();
  expect(errors).toEqual([]);
});
