import { test, expect } from "./health";
import { companionPanel, openCompanion } from "./companion-helpers";
import enHost from "../../src/i18n/messages/en/connectedHost.json";
import enEarlier from "../../src/i18n/messages/en/earlierMessages.json";

/*
 * A conversation longer than one read (final design §3.4, §3.8 item 7, Q7): 130 messages, of which
 * the companion reads the newest 100. "Show earlier messages" reads the 30 before them, only when
 * asked, and puts them above without moving the message the learner is looking at (MSG-15).
 * Session: /test/actions-session with 63 earlier questions and answers.
 */
test("“Show earlier messages” prepends the older page without moving the visible message", async ({ page }, info) => {
  const earlierReads: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() === "GET" && /^\/api\/enrollments\/[^/]+\/companion$/.test(url.pathname) && url.searchParams.has("before")) earlierReads.push(url.search);
  });
  const { token } = (await (await page.request.post("/test/actions-session", { data: { earlier: 63 } })).json()) as { token: string };
  await page.goto(`/#signin=${token}`);
  const resume = page.getByRole("button", { name: enHost["library.continue"], exact: true }).or(page.getByTestId("next-step").getByRole("button"));
  await expect(async () => {
    if (await resume.count()) await resume.first().click({ timeout: 2_000 });
    await expect(page.locator(".connected-check")).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  const panel = await openCompanion(page);
  const messages = panel.locator("[data-message-id]");
  await expect(messages).toHaveCount(100);
  await expect(panel.getByText("Earlier question 1", { exact: true })).toHaveCount(0);
  // Nothing older is read until the learner asks.
  expect(earlierReads).toEqual([]);
  const show = panel.getByRole("button", { name: enEarlier.show, exact: true });
  await show.scrollIntoViewIfNeeded();
  await expect(show).toBeInViewport();
  // The first message in view, and where it is on the screen.
  const visible = await page.evaluate(() => {
    const top = (node: Element) => node.getBoundingClientRect().top;
    const nodes = Array.from(document.querySelectorAll("#connected-companion [data-message-id]"));
    const first = nodes.find((node) => node.getBoundingClientRect().bottom > 0 && top(node) >= 0) ?? nodes[0]!;
    return { id: first.getAttribute("data-message-id")!, top: top(first) };
  });
  await page.screenshot({ path: info.outputPath("earlier-before.png") });
  await show.click();
  await expect(messages).toHaveCount(130);
  await expect(panel.getByText("Earlier question 1", { exact: true })).toBeAttached();
  // All read: the button goes.
  await expect(show).toHaveCount(0);
  expect(earlierReads).toHaveLength(1);
  const after = await page.locator(`#connected-companion [data-message-id="${visible.id}"]`).evaluate((node) => node.getBoundingClientRect().top);
  expect(Math.abs(after - visible.top)).toBeLessThanOrEqual(2);
  // The earlier messages are in order, above the ones that were there.
  const order = await messages.evaluateAll((nodes) => nodes.map((node) => node.textContent ?? ""));
  const first = order.findIndex((value) => value.includes("Earlier question 1")), last = order.findIndex((value) => value.includes("Earlier question 63"));
  expect(first).toBeGreaterThanOrEqual(0);
  expect(first).toBeLessThan(last);
  await page.screenshot({ path: info.outputPath("earlier-after.png") });
});
