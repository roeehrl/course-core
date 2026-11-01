import { expect, test } from "@playwright/test";
import { recordRendererHealth, watchRenderer } from "./renderer-health.js";
import { enterNextLesson } from "./learner-helpers.js";

// Split from learner.spec.ts ("the companion shows the context an answer used, takes a lesson
// selection, and lets the learner correct its context"): nothing selected is attached until the
// learner presses "Ask companion" (final design §3.9); then the selection goes with the next
// question, the server accepts it against this course version, and the chip clears.
test.beforeEach(async ({ page }) => watchRenderer(page));
test.afterEach(async ({ page }, testInfo) => recordRendererHealth(page, testInfo));

test("the companion takes a lesson selection with the next question", async ({ page, request }) => {
  const session = await request.post("/test/companion-context-session");
  expect(session.ok()).toBe(true);
  await page.goto(`/#signin=${(await session.json()).token}`);
  await page.getByRole("button", { name: /^(Start the course|Start lesson \d+|Continue lesson \d+|Continue learning) →$/ }).click();
  await enterNextLesson(page);
  await expect(page.getByRole("heading", { name: "Minimum", exact: true })).toBeVisible();
  // Select part of the lesson text: nothing is attached yet.
  await page.evaluate(() => {
    const walker = document.createTreeWalker(document.querySelector(".connected-lesson")!, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.textContent!.indexOf("any other member");
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at); range.setEnd(node, at + "any other member".length);
      document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range);
      return;
    }
    throw new Error("lesson text not found");
  });
  const companion = page.locator("#connected-companion");
  await expect(companion.getByText("Selected: “any other member”", { exact: true })).toHaveCount(0);
  // Pressing "Ask companion" attaches it and opens the companion.
  await page.getByRole("button", { name: "Ask companion", exact: true }).click();
  await expect(companion).toBeVisible();
  await expect(companion.getByText("Selected: “any other member”", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Ask companion", exact: true })).toHaveCount(0);
  await expect(page.getByText("Because the minimum may be equal to another member, not only smaller.", { exact: true })).toBeVisible();
  const log = page.getByRole("log", { name: "Saved companion messages" });
  // A new question carries the selection; the server accepts it against this course version.
  await companion.getByRole("textbox", { name: "Message to your companion", exact: true }).fill("And what about this part?");
  const sent = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname.endsWith("/companion"));
  await companion.getByRole("button", { name: "Send", exact: true }).click();
  const response = await sent;
  expect(response.status()).toBe(200);
  expect(response.request().postDataJSON()).toMatchObject({ selection: { kind: "text", excerpt: "any other member" }, uiRevision: expect.any(Number) });
  expect(await response.json()).toMatchObject({ selectedAnchor: { kind: "text" } });
  await expect(companion.getByText("Selected: “any other member”", { exact: true })).toHaveCount(0);
  await expect(log.getByText("And what about this part?", { exact: true })).toBeVisible();
});
