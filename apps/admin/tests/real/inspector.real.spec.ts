import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const axeTags = ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"];
const accessible = async (page: Page) => {
  expect(
    (await new AxeBuilder({ page }).withTags(axeTags).analyze()).violations,
  ).toEqual([]);
  await expect(
    page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    ),
  ).resolves.toBeLessThanOrEqual(1);
};
async function signIn(page: Page, code: string, view: string) {
  await page.goto("/admin/");
  await page.getByLabel("One-time sign-in code").fill(code);
  await page.getByRole("button", { name: "Use code", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Course & releases", level: 1 }),
  ).toBeVisible();
  await page
    .getByRole("navigation", { name: "Workspace navigation" })
    .getByRole("button", { name: view })
    .click();
  await expect(
    page.getByRole("heading", { name: view, level: 1 }),
  ).toBeVisible();
}

test("an owner inspects a learner's lesson from the read-only view: visual state, the lesson's run, sandboxed replay and an audited payload reveal", async ({
  page,
  browser,
}, info) => {
  const fixture = await (
    await page.request.post("/test/inspector-fixture")
  ).json();
  await signIn(page, fixture.ownerCode, "Enrollments");
  await page
    .getByRole("button", { name: "Open read-only learner view" })
    .click();
  const dialog = page.getByRole("dialog", { name: /Avery Learner/ });
  await expect(dialog).toBeVisible();

  // The inspector opens from the learner's visual block: live scene, timeline, bindings and hashes.
  await dialog.getByRole("button", { name: "Inspect part 2" }).click();
  const pane = dialog.getByRole("complementary", { name: "Debug inspector" });
  await expect(
    pane.getByRole("heading", { name: "Part 2: Illustration" }),
  ).toBeFocused();
  const state = pane.getByRole("region", { name: "Visual state" });
  await expect(
    state.getByRole("table", { name: "Bindings: state the scene reads" }),
  ).toBeVisible();
  await expect(state.getByText(/^[0-9a-f]{64}$/)).toBeVisible();
  await accessible(page);
  await page.screenshot({
    path: info.outputPath("inspector-visual.png"),
    fullPage: false,
  });

  // The lesson's supervisor run, opened in the same pane.
  await pane.getByRole("button", { name: /supervisor run/ }).click();
  await pane.getByRole("button", { name: "Workflow graph" }).click();
  await expect(
    pane
      .getByRole("navigation", { name: "Workflow graph" })
      .getByText("Step 3: choose_support"),
  ).toBeVisible();
  await pane.getByRole("button", { name: "Replay" }).click();
  await pane.getByRole("button", { name: "Replay in sandbox" }).click();
  await expect(
    pane.getByText("Replay matches the recorded plan"),
  ).toBeVisible();
  await pane.getByRole("button", { name: "Payload" }).click();
  await pane.getByLabel("Reason for revealing").selectOption("quality_review");
  await pane
    .getByRole("button", { name: "Reveal payload with audit receipt" })
    .click();
  await expect(
    pane.getByText(/is on the learner's record and in the audit log/),
  ).toBeVisible();
  await expect(
    pane.getByText("Not revealed: the learner's private model."),
  ).toBeVisible();
  await expect(pane.getByText("LEARNER_MODEL_CANARY")).toHaveCount(0);
  await expect(pane.getByText(/Offer the number-line/)).toHaveCount(0);
  await expect(pane.getByLabel("supervised_plan content")).toContainText(
    '"withheld": "model_text"',
  );
  await accessible(page);
  await pane.getByRole("button", { name: "Close the debug inspector" }).click();
  await expect(
    dialog.getByRole("button", { name: "Inspect part 2" }),
  ).toBeFocused();
  await dialog.getByRole("button", { name: /Close/ }).first().click();

  // The run inspector shows policies, budgets and client/sync state; the audit log has both receipts.
  await page
    .getByRole("navigation", { name: "Workspace navigation" })
    .getByRole("button", { name: "Run inspector" })
    .click();
  await page.getByRole("button", { name: "Policies & budgets" }).click();
  await expect(
    page.getByRole("table", { name: "Reservations and usage per attempt" }),
  ).toContainText("300 micro-USD · 120 tokens");
  await page.getByRole("button", { name: "Client & sync" }).click();
  await expect(
    page.getByText(/web 1\.4\.2 · client sequence 17/),
  ).toBeVisible();
  await accessible(page);
  await page.screenshot({
    path: info.outputPath("run-sync.png"),
    fullPage: true,
  });
  await page
    .getByRole("navigation", { name: "Workspace navigation" })
    .getByRole("button", { name: "Audit log" })
    .click();
  await expect(page.getByText("run.payload_revealed").first()).toBeVisible();
  await expect(page.getByText("run.replayed").first()).toBeVisible();

  // An instructor inspects runs but cannot reveal a payload.
  const context = await browser.newContext({
    baseURL: info.project.use.baseURL,
    ...(info.project.use.viewport
      ? { viewport: info.project.use.viewport }
      : {}),
    ...(info.project.use.isMobile ? { isMobile: true, hasTouch: true } : {}),
  });
  const instructor = await context.newPage();
  await signIn(instructor, fixture.instructorCode, "Run inspector");
  await instructor.getByRole("button", { name: "Payload" }).click();
  await expect(
    instructor.getByText(/needs the run\.payload permission/),
  ).toBeVisible();
  await expect(
    instructor.getByRole("button", { name: /Reveal payload/ }),
  ).toHaveCount(0);
  await accessible(instructor);
  await context.close();
});
