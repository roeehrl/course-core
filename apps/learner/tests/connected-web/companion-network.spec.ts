import { expect, test, type Page } from "./health";

/* With the companion open beside the lesson, the conversation is read when something happens
 * (an event on the enrollment's stream, a new course revision, the panel opening), not on a
 * timer, and one event stream serves the whole visit. The window size is set here, so the
 * test runs once per engine (@desktop-window). */

function watchCompanion(page: Page) {
  const seen = { streams: 0, reads: 0 };
  page.on("request", (request) => {
    if (request.method() !== "GET") return;
    const path = new URL(request.url()).pathname;
    if (/^\/api\/enrollments\/[^/]+\/events\/stream$/.test(path)) seen.streams++;
    if (/^\/api\/enrollments\/[^/]+\/companion$/.test(path)) seen.reads++;
  });
  return seen;
}

test("the open companion pane reads on events, keeps one stream across revisions, and does not poll", {
  tag: "@desktop-window",
}, async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 960 });
  const seen = watchCompanion(page);
  const token = (await (await page.request.post("/test/session")).json()).token;
  await page.goto(`/#signin=${token}`);
  await page
    .getByRole("article")
    .filter({ has: page.getByRole("heading", { name: "Ordering values", exact: true }) })
    .getByRole("button", { name: "Open course", exact: true })
    .click();
  await page.getByRole("button", { name: "Start course", exact: true }).click();
  await page.getByRole("button", { name: "Continue learning →", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Minimum", exact: true })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "Your companion" })).toBeVisible();
  await expect.poll(() => seen.streams).toBe(1);

  // Idle with the pane open: no reads at all (the pane used to read every 3 s).
  const idle = seen.reads;
  await page.waitForTimeout(7000);
  expect(seen.reads - idle).toBe(0);

  // New course revisions (reading a part, starting a check) re-read the conversation over the
  // same stream: a read or two per revision, and never a second stream.
  const beforeRevisions = seen.reads;
  await page.getByRole("button", { name: "Mark this part read", exact: true }).click();
  await page.getByRole("button", { name: "Start the next check →", exact: true }).click();
  await expect(page.getByRole("radio", { name: "2", exact: true })).toBeVisible();
  await page.waitForTimeout(1500);
  expect(seen.reads - beforeRevisions).toBeLessThanOrEqual(4);

  // A question waiting for its answer: the stream reports the answer, so the page still waits
  // quietly (at most one slow safety read in this window).
  await page.getByRole("radio", { name: "2", exact: true }).click();
  await page.getByRole("textbox", { name: "Message to your companion", exact: true }).fill("Why is 2 the smallest?");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await page.getByRole("button", { name: "Switch to practice & send" }).click();
  await expect(page.getByText("Why is 2 the smallest?", { exact: true })).toBeVisible();
  await page.waitForTimeout(1500);
  const waiting = seen.reads;
  await page.waitForTimeout(7000);
  expect(seen.reads - waiting).toBeLessThanOrEqual(1);
  expect(seen.streams).toBe(1);
  expect(errors).toEqual([]);
});
