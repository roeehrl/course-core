import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const axeTags = ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"];
async function signIn(page: Page, code: string) {
  await page.goto("/admin/");
  await page.getByLabel("One-time sign-in code").fill(code);
  await page.getByRole("button", { name: "Use code", exact: true }).click();
}
const card = (page: Page, learner: string) =>
  page.locator("section.card").filter({ hasText: `${learner} · minimum` });

test("a reviewer resolves learners' evidence disputes without seeing their reasons, through the real API", async ({
  page,
}, info) => {
  const fixture = await (
    await page.request.post("/test/evidence-dispute-fixture")
  ).json();

  await signIn(page, fixture.reviewerCode);
  await page
    .getByRole("navigation", { name: "Workspace navigation" })
    .getByRole("button", { name: "Answer reviews" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Disputed evidence" }),
  ).toBeVisible();
  const casey = card(page, "Casey Learner"),
    devon = card(page, "Devon Learner");
  await expect(casey).toContainText("opened today");
  await expect(
    casey.getByRole("region", { name: "Disputed evidence for Casey Learner" }),
  ).toContainText("passed, independent");
  // The learner's own words never reach the staff page.
  await expect(page.getByText(fixture.reason)).toHaveCount(0);
  expect(await page.content()).not.toContain(fixture.reason);
  // A failed answer can only be invalidated.
  await expect(
    devon.getByRole("radio", { name: /Uphold the result/ }),
  ).toBeDisabled();
  await expect(
    devon.getByRole("radio", { name: /Invalidate this evidence/ }),
  ).toBeChecked();

  const uphold = casey.getByRole("button", { name: "Uphold result" });
  await expect(uphold).toBeDisabled();
  await casey
    .getByLabel("Review note")
    .fill("Checked against the answer key; the result stands.");
  expect(
    (await new AxeBuilder({ page }).withTags(axeTags).analyze()).violations,
  ).toEqual([]);
  await expect(
    page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    ),
  ).resolves.toBeLessThanOrEqual(1);
  await page.screenshot({
    path: info.outputPath("evidence-disputes.png"),
    fullPage: true,
  });
  await uphold.click();
  await expect(
    page.getByText(
      "Result upheld for Casey Learner on minimum. The dispute is closed.",
    ),
  ).toBeVisible();
  await expect(card(page, "Casey Learner")).toHaveCount(0);

  await devon
    .getByLabel("Review note")
    .fill("The answer does not meet the item; invalidated.");
  await devon.getByRole("button", { name: "Invalidate evidence" }).click();
  await expect(
    page.getByText(
      "Evidence invalidated for Devon Learner on minimum. The dispute is closed.",
    ),
  ).toBeVisible();
  await expect(page.getByText("No disputed evidence")).toBeVisible();
  expect(
    (await new AxeBuilder({ page }).withTags(axeTags).analyze()).violations,
  ).toEqual([]);

  // Without evidence.review on the course, the server refuses the queue whatever the page shows.
  const courseId = (await (await page.request.get("/api/admin/session")).json())
    .courses[0].id as string;
  await page.context().clearCookies();
  await signIn(page, fixture.observerCode);
  await expect(
    page.getByRole("navigation", { name: "Workspace navigation" }),
  ).toBeVisible();
  expect(
    (
      await page.request.get(`/api/admin/courses/${courseId}/evidence-disputes`)
    ).status(),
  ).toBe(403);
});
