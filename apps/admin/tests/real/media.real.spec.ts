import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { workspaceNav } from "../workspaceNav";

async function openMedia(page: Page) {
  const fixture = await (await page.request.post("/test/media-fixture")).json();
  await page.goto("/admin/");
  await page.getByLabel("One-time sign-in code").fill(fixture.code);
  await page.getByRole("button", { name: "Use code", exact: true }).click();
  await (
    await workspaceNav(page)
  )
    .getByRole("button", { name: "Generated media" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Generated media", level: 1 }),
  ).toBeVisible();
  return fixture as { code: string; learnerCode: string; enrollmentId: string };
}
const noHorizontalScroll = (page: Page) =>
  expect(
    page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    ),
  ).resolves.toBeLessThanOrEqual(1);

test("staff review, attach and revoke a generated clip; cost, charge and provider operation are visible", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await openMedia(page);
  const jobs = page
    .getByRole("list", { name: "Media jobs" })
    .getByRole("listitem");
  await expect(jobs).toHaveCount(2);
  const first = jobs.filter({ hasText: "Running minimum in motion" });
  await expect(first).toContainText("pending review");
  await expect(first).toContainText("$0.20");
  await expect(first).toContainText("$0.25");
  await expect(first).toContainText(/scripted\/operations\/op-\d+/);
  await expect(page.getByText("Live generation not verified")).toBeVisible();
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await noHorizontalScroll(page);
  await page.screenshot({
    path: info.outputPath("media-list.png"),
    fullPage: true,
  });

  await page
    .getByRole("button", { name: "Open Running minimum in motion" })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Running minimum in motion",
  });
  await expect(dialog.getByText("hidden from learners")).toBeVisible();
  await expect(dialog.locator("video")).toHaveAttribute(
    "src",
    /\/api\/admin\/media-jobs\/[0-9a-f-]+\/asset$/,
  );
  // Approval is impossible until every check and the text alternative are present.
  const save = dialog.getByRole("button", { name: "Save review" });
  await expect(save).toBeDisabled();
  for (const label of [
    /Facts match/,
    /Labels, values/,
    /Captions match/,
    /Motion does not/,
  ])
    await dialog.getByLabel(label).check();
  await dialog
    .getByLabel("Captions (WebVTT)")
    .fill(
      "WEBVTT\n\n00:00.000 --> 00:04.000\nThe smaller value stays highlighted.\n",
    );
  await dialog
    .getByLabel("Transcript")
    .fill("The running minimum keeps the smaller value after each comparison.");
  await dialog
    .getByLabel("What the video shows")
    .fill(
      "A highlight moves along five boxes and stays on the smallest so far.",
    );
  await dialog
    .getByLabel("Rationale")
    .fill(
      "Matches the reference trace for this episode; captions follow the narration.",
    );
  expect(
    (
      await new AxeBuilder({ page })
        .include("dialog")
        .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await page.screenshot({
    path: info.outputPath("media-review.png"),
    fullPage: true,
  });
  await save.click();
  await expect(
    dialog.getByText("Approved. It is still hidden until attached."),
  ).toBeVisible();
  await expect(dialog.getByText("hidden from learners")).toBeVisible();
  await dialog.getByRole("button", { name: "Attach as optional help" }).click();
  await expect(
    dialog.getByText("Attached as optional help for this learner."),
  ).toBeVisible();
  await expect(dialog.getByText("visible to learner")).toBeVisible();
  await dialog.getByRole("button", { name: "Revoke" }).click();
  await dialog.getByLabel("Reason").fill("Superseded by a corrected clip.");
  await dialog.getByRole("button", { name: "Confirm revoke" }).click();
  await expect(
    dialog.getByText("Revoked. Learners no longer see it."),
  ).toBeVisible();
  await expect(dialog.getByText("hidden from learners")).toBeVisible();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();

  // The second clip is cancelled; its reserved allowance is kept, as the notice says.
  await page.getByRole("button", { name: "Open Comparing two values" }).click();
  const second = page.getByRole("dialog", { name: "Comparing two values" });
  await second.getByRole("button", { name: "Cancel job" }).click();
  await expect(
    second.getByText("Cancelled. The reserved allowance is not returned."),
  ).toBeVisible();
  await second.getByRole("button", { name: "Close", exact: true }).click();
  await expect(jobs.filter({ hasText: "Comparing two values" })).toContainText(
    "cancelled",
  );
  await noHorizontalScroll(page);
  expect(errors).toEqual([]);
});

test("a request shows its cost check before it is admitted against the allowance", async ({
  page,
}) => {
  await openMedia(page);
  await page.getByRole("button", { name: "Request a clip" }).click();
  const dialog = page.getByRole("dialog", { name: "Request a generated clip" });
  await dialog.getByRole("button", { name: "Check cost" }).click();
  await expect(
    dialog.getByText(/Estimate \$0\.20; \$0\.25 is reserved at admission/),
  ).toBeVisible();
  await expect(dialog.getByText("Would be admitted.")).toBeVisible();
  await dialog.getByLabel("Title").fill("Third clip");
  await dialog
    .getByLabel("Teaching purpose")
    .fill("Show the minimum after an empty-list check.");
  await dialog
    .getByLabel("Reviewed script")
    .fill(
      "A list appears; the first value is highlighted, then each smaller one.",
    );
  await dialog.getByRole("button", { name: "Request clip" }).click();
  await expect(page.getByText(/Request recorded/)).toBeVisible();
  await expect(
    page
      .getByRole("list", { name: "Media jobs" })
      .getByRole("listitem")
      .filter({ hasText: "Third clip" }),
  ).toContainText("admitted");
  await noHorizontalScroll(page);
});
