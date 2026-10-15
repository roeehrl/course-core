import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { chooseFromMenu } from "./learner-menu";

/* Offline and interrupted submissions against the real API and database. The
 * server is the only authority: a submission counts once, however many times
 * the browser has to send it. */

async function openCheck(page: Page) {
  const token = (await (await page.request.post("/test/session")).json()).token;
  await page.goto(`/#signin=${token}`);
  await page
    .getByRole("article")
    .filter({
      has: page.getByRole("heading", { name: "Ordering values", exact: true }),
    })
    .getByRole("button", { name: "Open course", exact: true })
    .click();
  await page.getByRole("button", { name: "Start course", exact: true }).click();
  await page
    .getByRole("button", { name: "Continue learning →", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Mark this part read", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Start the next check →", exact: true })
    .click();
  await page.getByRole("radio", { name: "2", exact: true }).click();
}

const answerPosts = (page: Page) => {
  const keys: string[] = [];
  const confirmed: number[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().endsWith("/answers"))
      keys.push(r.postDataJSON().idempotencyKey);
  });
  page.on("response", (r) => {
    if (r.request().method() === "POST" && r.url().endsWith("/answers"))
      confirmed.push(r.status());
  });
  return { keys, confirmed };
};

async function answeredChecks(page: Page) {
  await chooseFromMenu(page, "Learning record");
  await expect(
    page.getByRole("heading", { name: "Your learning record" }),
  ).toBeVisible();
  return page.getByText("Check answered", { exact: true }).count();
}

test("offline: the answer waits on this device, is sent once on reconnect and records exactly one receipt", async ({
  page,
  context,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await openCheck(page);
  const posts = answerPosts(page);
  await context.setOffline(true);
  const status = page
    .getByRole("status")
    .filter({ hasText: "You’re offline." });
  await expect(status).toBeVisible();
  await page.getByRole("button", { name: "Check answer", exact: true }).click();
  await expect(
    page.getByText(/You’re offline\. Nothing was recorded yet/),
  ).toBeVisible();
  const waiting = page
    .getByRole("status")
    .filter({ hasText: "Not recorded yet: your answer" });
  await expect(waiting).toBeVisible();
  // The answer itself is kept on the device.
  await expect(
    page.getByRole("radio", { name: "2", exact: true }),
  ).toBeChecked();
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await page.screenshot({ path: info.outputPath("offline-waiting.png") });
  expect(posts.confirmed).toEqual([]);

  await context.setOffline(false);
  await expect(page.getByText(/^Recovered submission\./)).toBeVisible();
  await expect(status).toHaveCount(0);
  await expect(waiting).toHaveCount(0);
  // Every send used the same idempotency key, and the server confirmed it once.
  expect(posts.keys.length).toBeGreaterThanOrEqual(1);
  expect(new Set(posts.keys).size).toBe(1);
  expect(posts.confirmed).toEqual([200]);
  expect(await answeredChecks(page)).toBe(1);
  expect(errors).toEqual([]);
});

test("a tab closed before the server's reply resumes in a new tab with the same key and exactly one receipt", async ({
  page,
  context,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await openCheck(page);
  const firstKeys: string[] = [];
  // The server receives and records the answer, but its reply never arrives.
  await page.route("**/answers", async (route) => {
    firstKeys.push(route.request().postDataJSON().idempotencyKey);
    await route.fetch();
    await route.abort("connectionreset");
  });
  await page.getByRole("button", { name: "Check answer", exact: true }).click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Not recorded yet: your answer" }),
  ).toBeVisible();
  expect(firstKeys).toHaveLength(1);
  await page.close();

  const reopened = await context.newPage();
  reopened.on("pageerror", (e) => errors.push(e.message));
  const posts = answerPosts(reopened);
  await reopened.goto("/");
  await reopened
    .getByRole("button", { name: "Continue learning →", exact: true })
    .first()
    .click();
  await expect(reopened.getByText(/^Recovered submission\./)).toBeVisible();
  expect(posts.keys).toEqual(firstKeys);
  expect(posts.confirmed).toEqual([200]);
  await expect(
    reopened.getByRole("status").filter({ hasText: "Not recorded yet" }),
  ).toHaveCount(0);
  expect(await answeredChecks(reopened)).toBe(1);
  expect(errors).toEqual([]);
});

test("an answer draft survives closing the tab", async ({ page, context }) => {
  await openCheck(page);
  await page.close();
  const reopened = await context.newPage();
  await reopened.goto("/");
  await reopened
    .getByRole("button", { name: "Continue learning →", exact: true })
    .first()
    .click();
  await reopened
    .getByRole("button", { name: "Continue learning →", exact: true })
    .click();
  await expect(
    reopened.getByRole("radio", { name: "2", exact: true }),
  ).toBeChecked();
});
