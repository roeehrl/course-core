import { test, expect } from "./health";
import AxeBuilder from "@axe-core/playwright";
import { closeCompanion, companionPanel, composerBox, openCompanion } from "./companion-helpers";

// A message while a counted question is open asks first, in one inline row under the message box
// (final design §3.11): nothing is sent until the learner chooses; focus starts on "Keep it
// counted", which Esc also takes; keeping sends nothing, keeps the draft and returns to the message
// box; "Send as practice" sends with explicit consent and the check then says why it is practice.
// Split from companion.spec.ts.
test("a message while a counted question is open asks first and sends only with explicit consent", async ({
  page,
  request,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const token = (await (await request.post("/test/session")).json()).token;
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
    .getByRole("button", { name: /^(Start the course|Start lesson \d+|Continue lesson \d+|Continue learning) →$/ })
    .click();
  await page
    .getByRole("button", { name: "Mark this part read", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Start the next check →", exact: true })
    .click();
  await page.getByRole("radio", { name: "2", exact: true }).click();
  const panel = await openCompanion(page);
  const draft = composerBox(page);
  await draft.fill("Explain how to compare these values.");
  const requests: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().endsWith("/companion"))
      requests.push(r.postData()!);
  });
  const sendButton = panel.getByRole("button", { name: "Send", exact: true });
  await sendButton.click();
  const row = panel.getByRole("group", { name: "Asking now makes question 1 practice. It won't count toward finishing the lesson." });
  await expect(row).toBeVisible();
  await expect(row.getByRole("button", { name: "Send as practice" })).toBeVisible();
  await expect(row.getByRole("button", { name: "Save for after the question" })).toBeVisible();
  // The safe choice has focus; no card, no heading.
  await expect(row.getByRole("button", { name: "Keep it counted" })).toBeFocused();
  await expect(panel.getByRole("heading", { name: /independent/ })).toHaveCount(0);
  expect(requests).toHaveLength(0);
  // Esc keeps it counted: nothing sent, the draft stays, and the companion stays open with focus
  // back in the message box.
  await page.keyboard.press("Escape");
  await expect(row).toBeHidden();
  await expect(panel).toBeVisible();
  await expect(draft).toBeFocused();
  await expect(draft).toHaveValue("Explain how to compare these values.");
  expect(requests).toHaveLength(0);
  // "Keep it counted" keeps the draft and returns focus to the message box.
  await sendButton.click();
  await row.getByRole("button", { name: "Keep it counted" }).click();
  await expect(row).toBeHidden();
  await expect(draft).toBeFocused();
  await expect(draft).toHaveValue("Explain how to compare these values.");
  expect(requests).toHaveLength(0);
  await closeCompanion(page);
  await expect(
    page.getByRole("radio", { name: "2", exact: true }),
  ).toBeChecked();
  await expect(page.getByTestId("question-kind")).toHaveText("Counts toward this lesson. Answer on your own.");
  await openCompanion(page);
  await expect(draft).toHaveValue("Explain how to compare these values.");
  await sendButton.click();
  const sent = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/companion"),
  );
  await row.getByRole("button", { name: "Send as practice" }).click();
  expect((await sent).status()).toBe(200);
  await expect(draft).toHaveValue("");
  await expect(
    page.getByText("Explain how to compare these values.", { exact: true }),
  ).toBeVisible();
  expect(JSON.parse(requests[0]!).allowAssessmentAssistance).toBe(true);
  // The conversation names the lesson once, in a divider (conversation §3.4), not on each message.
  await expect(page.locator("#connected-companion .cc-chat-divider").filter({ hasText: /^Minimum$/ })).toBeVisible();
  const a11y = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(a11y.violations).toEqual([]);
  await page.screenshot({
    path: info.outputPath("companion-drawer.png"),
    fullPage: true,
  });
  await closeCompanion(page);
  await expect(page.getByTestId("question-kind")).toHaveText(
    "Practice. This question does not count toward finishing the lesson.",
  );
  await expect(page.locator(".connected-check").getByText("You asked your companion for help.", { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
