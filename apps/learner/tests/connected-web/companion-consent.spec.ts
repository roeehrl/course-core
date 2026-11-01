import { test, expect } from "./health";
import AxeBuilder from "@axe-core/playwright";
import { closeCompanion, composerBox, openCompanion } from "./companion-helpers";

// A message while a counted question is open asks first: nothing is sent until the learner
// chooses, "Keep it counted" sends nothing, and "Send as practice" sends with explicit consent
// and turns the question into practice. Split from companion.spec.ts.
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
  await openCompanion(page);
  const draft = composerBox(page);
  await draft.fill("Explain how to compare these values.");
  const requests: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().endsWith("/companion"))
      requests.push(r.postData()!);
  });
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Send as practice" }),
  ).toBeVisible();
  expect(requests).toHaveLength(0);
  await page.getByRole("button", { name: "Keep it counted" }).click();
  expect(requests).toHaveLength(0);
  await closeCompanion(page);
  await expect(
    page.getByRole("radio", { name: "2", exact: true }),
  ).toBeChecked();
  await openCompanion(page);
  await expect(draft).toHaveValue("Explain how to compare these values.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const sent = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/companion"),
  );
  await page.getByRole("button", { name: "Send as practice" }).click();
  expect((await sent).status()).toBe(200);
  await expect(draft).toHaveValue("");
  await expect(
    page.getByText("Explain how to compare these values.", { exact: true }),
  ).toBeVisible();
  expect(JSON.parse(requests[0]!).allowAssessmentAssistance).toBe(true);
  await expect(page.getByText(/^From: Minimum/)).toBeVisible();
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
  expect(errors).toEqual([]);
});
