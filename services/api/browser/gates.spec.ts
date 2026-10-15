// Real API, PostgreSQL and learner export: the server's versioned gate decision, "I don't know",
// optional confidence and the new item inputs on desktop, phone and tablet.
import { expect, test, type Locator, type Page } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";

async function fill(box: Locator, value: string) {
  await box.fill(value);
  if ((await box.inputValue()) !== value) await box.fill(value);
  await expect(box).toHaveValue(value);
}
const panel = (page: Page) => page.getByTestId("gate-decision");
async function nextCheck(page: Page) {
  await page.getByRole("button", { name: "Start the next check →", exact: true }).click();
  await expect(page.getByRole("button", { name: /I don't know yet/ })).toBeVisible();
}
async function noHorizontalScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
}

test("versioned gate: decision status and next steps, abstention, confidence, prediction and trace inputs", async ({ page, request }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const fixture = await (await request.post("/test/gates-session")).json();
  await page.goto(`/#signin=${fixture.token}`);
  await page.getByRole("button", { name: "Open course", exact: true }).click();
  await page.getByRole("button", { name: "Start course", exact: true }).click();
  await page.getByRole("region", { name: "Already know some of this?" }).getByRole("button", { name: "Start from the beginning" }).click();
  // Wait for the decline to be confirmed (the offer and its roadmap card leave the
  // page) before pressing a button the re-layout would otherwise move.
  await expect(page.locator("section.connected-placement")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Explore placement ↗" })).toHaveCount(0);
  await page.getByRole("button", { name: "Continue learning →", exact: true }).first().click();
  await page.getByRole("button", { name: "Mark this part read", exact: true }).click();

  // The server's decision, with concrete next steps.
  await expect(panel(page).getByRole("heading", { name: "More evidence needed" })).toBeVisible();
  await expect(panel(page).getByRole("button", { name: "Answer a fresh independent check on “Find a minimum” (0 of 2 item families so far)" })).toBeVisible();
  await expect(panel(page).getByRole("button", { name: /^Solve a new transfer task: “Predict the running minimum/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Complete episode →", exact: true })).toBeDisabled();
  await noHorizontalScroll(page);
  if (info.project.name === "phone") {
    // Compact layout: next steps stack at full panel width.
    const [box, button] = await Promise.all([panel(page).boundingBox(), panel(page).getByRole("button").first().boundingBox()]);
    expect(button!.width).toBeGreaterThan(box!.width - 48);
  }

  // "I don't know yet" records nothing against the learner.
  await nextCheck(page);
  await expect(page.getByText("Which is smaller?")).toBeVisible();
  await page.getByRole("button", { name: "I don't know yet: record no answer and get help" }).click();
  await expect(page.getByText(/Noted\. Nothing was recorded against you, and it does not count as evidence\./)).toBeVisible();

  // A second unsuccessful attempt: the decision puts help first.
  await nextCheck(page);
  await fill(page.getByRole("textbox", { name: "Your numeric answer" }), "9");
  await page.getByRole("button", { name: "Check answer", exact: true }).click();
  await expect(panel(page).getByRole("heading", { name: "Let's get you some help" })).toBeVisible();
  await expect(panel(page).getByRole("button").first()).toHaveText(/^Ask for help: your last 2 attempts on this checkpoint did not succeed/);

  // Prediction with its unit and optional confidence (which never changes the result).
  await nextCheck(page);
  await expect(page.getByText("Commit to a number before you see the result.", { exact: false })).toBeVisible();
  await page.getByRole("radiogroup", { name: "Confidence" }).getByRole("radio", { name: "2", exact: true }).click();
  await fill(page.getByRole("textbox", { name: "Your prediction (cm)" }), "12.6");
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  await noHorizontalScroll(page);
  await page.getByRole("button", { name: "Check answer", exact: true }).click();
  await expect(page.getByText(/^Correct\./)).toBeVisible();
  await expect(panel(page).getByRole("heading", { name: "More evidence needed" })).toBeVisible();

  // Trace: one answer per step.
  await nextCheck(page);
  await fill(page.getByRole("textbox", { name: "After 6" }), "6");
  await fill(page.getByRole("textbox", { name: "After 4" }), "4");
  await fill(page.getByRole("textbox", { name: "After 9" }), "4");
  await page.getByRole("button", { name: "Check answer", exact: true }).click();
  await expect(page.getByText(/^Correct\./)).toBeVisible();

  // Two families plus a production transfer task: the server says ready and offers to continue.
  await expect(panel(page).getByRole("heading", { name: "Ready to continue" })).toBeVisible();
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  await panel(page).getByRole("button", { name: "Continue to “Maximum”" }).click();
  await expect(page.getByText("Your progress is saved. Continue along your learning path.")).toBeVisible();
  const enrollment = (await (await page.request.get("/api/enrollments")).json())[0];
  const snapshot = await (await page.request.get(`/api/enrollments/${enrollment.id}`)).json();
  expect(snapshot.lessons[0]).toMatchObject({ id: "min", status: "completed", gate: { status: "ready" } });
  expect(errors).toEqual([]);
});

test("gate review: a learner asks for a review, staff uphold it, then authorize an exception after an extension", async ({ page, request }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const fixture = await (await request.post("/test/gates-session")).json();
  await page.goto(`/#signin=${fixture.token}`);
  await page.getByRole("button", { name: "Open course", exact: true }).click();
  await page.getByRole("button", { name: "Start course", exact: true }).click();
  await page.getByRole("region", { name: "Already know some of this?" }).getByRole("button", { name: "Start from the beginning" }).click();
  // Wait for the decline to be confirmed (the offer and its roadmap card leave the
  // page) before pressing a button the re-layout would otherwise move.
  await expect(page.locator("section.connected-placement")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Explore placement ↗" })).toHaveCount(0);
  await page.getByRole("button", { name: "Continue learning →", exact: true }).first().click();
  await page.getByRole("button", { name: "Mark this part read", exact: true }).click();
  await expect(panel(page).getByRole("heading", { name: "More evidence needed" })).toBeVisible();
  const enrollment = (await (await page.request.get("/api/enrollments")).json())[0].id as string;
  // Reload to read what staff changed, then return to the lesson once the course has loaded.
  const reopen = async () => {
    await page.reload();
    await expect(async () => {
      await page.getByRole("button", { name: "Continue learning →", exact: true }).first().click({ timeout: 2000 });
      await expect(panel(page)).toBeVisible({ timeout: 2000 });
    }).toPass({ timeout: 15000 });
  };
  const ask = async (reason: string) => {
    await panel(page).getByRole("button", { name: /^Request a staff review of this decision within 14 days$/ }).click();
    const box = panel(page).getByRole("textbox", { name: "Why should a staff member look at this decision again?" });
    await fill(box, reason);
    await panel(page).getByRole("button", { name: "Send review request", exact: true }).click();
    await expect(page.getByText(/Your review request was sent\./)).toBeVisible();
    await expect(panel(page).getByText("Review requested", { exact: true })).toBeVisible();
  };

  // The course deadline passes: the checkpoint closes with gaps and offers a staff review.
  expect((await request.post("/test/gates-deadline", { data: { enrollmentId: enrollment, reached: true } })).ok()).toBe(true);
  await reopen();
  await expect(panel(page).getByRole("heading", { name: "Closed with gaps" })).toBeVisible();
  await panel(page).getByRole("button", { name: /^Request a staff review/ }).click();
  const send = panel(page).getByRole("button", { name: "Send review request", exact: true });
  await expect(send).toBeDisabled();
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  await noHorizontalScroll(page);
  if (info.project.name === "phone") {
    const [box, field] = await Promise.all([panel(page).boundingBox(), panel(page).getByRole("textbox").boundingBox()]);
    expect(field!.width).toBeGreaterThan(box!.width - 48);
  }
  await panel(page).getByRole("button", { name: "Cancel", exact: true }).click();
  await ask("I was in hospital during the last week of the course.");
  await expect(panel(page).getByRole("button", { name: /^Request a staff review/ })).toHaveCount(0);

  // A staff member (the course owner) upholds it through the real API; the learner reads why.
  const staff = { headers: fixture.reviewer };
  const catalog = (await (await request.get("/api/admin/session", staff)).json()).courses[0].id;
  const queue = async () => (await (await request.get(`/api/admin/courses/${catalog}/gate-reviews`, staff)).json()).reviews;
  const [first] = await queue();
  expect(first).toMatchObject({ enrollmentId: enrollment, reason: "I was in hospital during the last week of the course.", decision: { status: "closed_with_gaps" } });
  const upheld = await request.post(`/api/admin/gate-reviews/${first.requestId}`, { ...staff, data: { outcome: "upheld", note: "An extension is the right route; ask for one first.", idempotencyKey: "browser-upheld-" + info.project.name } });
  expect(upheld.status(), await upheld.text()).toBe(200);
  await reopen();
  await expect(panel(page).getByText("Review completed: the decision stands")).toBeVisible();
  await expect(panel(page).getByText("“An extension is the right route; ask for one first.”")).toBeVisible();
  await expect(page.getByRole("button", { name: "Complete episode →", exact: true })).toBeDisabled();

  // The learner asks again; the deadline is extended and staff authorize an exception.
  await ask("The extension was granted; I would like to continue to the next lesson.");
  expect((await request.post("/test/gates-deadline", { data: { enrollmentId: enrollment, reached: false } })).ok()).toBe(true);
  const [second] = await queue();
  const granted = await request.post(`/api/admin/gate-reviews/${second.requestId}`, { ...staff, data: { outcome: "exception", note: "Documented absence; the transfer task stays open.", idempotencyKey: "browser-exception-" + info.project.name } });
  expect(granted.status(), await granted.text()).toBe(200);
  await reopen();
  // The decision stays honest; the exception is shown beside it.
  await expect(panel(page).getByRole("heading", { name: "More evidence needed" })).toBeVisible();
  await expect(panel(page).getByText("Staff exception granted")).toBeVisible();
  await expect(panel(page).getByText(/This is not a pass/)).toBeVisible();
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  await noHorizontalScroll(page);
  await panel(page).getByRole("button", { name: "Continue under the exception", exact: true }).click();
  await expect(page.getByText("Your progress is saved. Continue along your learning path.")).toBeVisible();
  const snapshot = await (await page.request.get(`/api/enrollments/${enrollment}`)).json();
  expect(snapshot.lessons[0]).toMatchObject({ id: "min", status: "completed", exception: true, gate: { status: "needs_evidence", passed: false } });
  expect(snapshot.lessons[1]).toMatchObject({ id: "max", status: "available" });
  expect(errors).toEqual([]);
});
