import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test.beforeEach(async ({ page }) => {
  await page.goto("/demo");
  await expect(
    page.getByRole("heading", { name: "A little order." }),
  ).toBeVisible();
});

test("real learning flow: wrong answer, restoration, optional skip, next gate", async ({
  page,
}, testInfo) => {
  await page.getByRole("button", { name: "Continue learning →" }).click();
  await page.screenshot({ path: testInfo.outputPath("lesson.png") });
  await expect(
    page.getByRole("button", { name: "Predict, required step" }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Mark read & continue →" }).click();
  await page.getByRole("radio", { name: "2 and 7" }).click();
  await page.getByRole("button", { name: "Check answer", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Not quite");
  await page.getByRole("radio", { name: "7 and 4" }).click();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Which pair breaks the order?" }),
  ).toBeVisible();
  await expect(page.getByRole("radio", { name: "7 and 4" })).toBeChecked();
  await page.getByRole("button", { name: "Check answer", exact: true }).click();
  await page.getByRole("button", { name: "Continue →", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "What if two numbers are equal?" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Skip for now →" }).click();
  const reflection = page.getByRole("textbox", {
    name: "How would you check whether a sequence is in ascending order?",
  });
  await reflection.fill("Compare every neighboring pair from left to right.");
  await page.reload();
  await expect(reflection).toHaveValue(
    "Compare every neighboring pair from left to right.",
  );
  await page.getByRole("button", { name: "Save reflection" }).click();
  await expect(page.getByText(/Its meaning has not been graded/)).toBeVisible();
  await page.getByRole("button", { name: "Return to roadmap →" }).click();
  await expect(page.getByText("1 completed / 3")).toBeVisible();
  await page.getByRole("button", { name: "Continue learning →" }).click();
  await expect(
    page.getByRole("heading", { name: "Trade places. Keep the numbers." }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Mark read & continue →" }).click();
  await page.getByRole("radio", { name: "3, 5, 8" }).click();
  await page.getByRole("button", { name: "Check answer", exact: true }).click();
  await page.getByRole("button", { name: "Return to roadmap →" }).click();
  await page.getByRole("button", { name: "Continue learning →" }).click();
  await page.getByRole("button", { name: "Mark read & continue →" }).click();
  await page
    .getByRole("radio", {
      name: "Another pass: 3 and 2 are still out of order.",
    })
    .click();
  await page.getByRole("button", { name: "Check answer", exact: true }).click();
  await page.getByRole("button", { name: "Return to roadmap →" }).click();
  await expect(page.getByText("3 completed / 3")).toBeVisible();
  await expect(page.getByText("You reached the end.")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Continue learning →" }),
  ).toHaveCount(0);
});

test("optional placement and editable profile persist", async ({ page }) => {
  await page.getByRole("button", { name: "Explore placement ↗" }).click();
  await expect(page.getByRole("dialog", { name: "placement" })).toBeVisible();
  await page.getByRole("radio", { name: "9, 7, 4, 2" }).click();
  await page.getByRole("button", { name: "Check placement" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Nothing has been skipped",
  );
  await page.getByRole("radio", { name: "2, 4, 7, 9" }).click();
  await page.getByRole("button", { name: "Check placement" }).click();
  await page.getByRole("button", { name: "Return to my path →" }).click();
  await expect(page.getByText("0 completed · 1 placed out / 3")).toBeVisible();
  await page.getByRole("button", { name: "Profile", exact: true }).click();
  await page.getByRole("textbox", { name: "Display name" }).fill("Jordan");
  await page
    .getByRole("textbox", { name: "My learning goal (optional)" })
    .fill("Understand the little steps.");
  await page.getByRole("radio", { name: "Gentle · one small step" }).click();
  await page.getByRole("button", { name: "Save profile" }).click();
  await expect(page.getByText("Profile saved on this device.")).toBeVisible();
  await page.getByRole("button", { name: "Close profile" }).click();
  await page.reload();
  await page.getByRole("button", { name: "Profile", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Display name" })).toHaveValue(
    "Jordan",
  );
  await expect(
    page.getByRole("radio", { name: "Gentle · one small step" }),
  ).toBeChecked();
});

test("effective-window adaptation preserves drafts and companion notes", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByTestId("companion-pane")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("roadmap-desktop.png") });
  await page
    .getByRole("textbox", { name: "Notes to yourself" })
    .fill("Look for neighbors.");
  await page.setViewportSize({ width: 768, height: 1024 });
  await expect(page.getByTestId("companion-pane")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("roadmap-tablet.png") });
  await page.getByRole("button", { name: "Companion", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Notes to yourself" }),
  ).toHaveValue("Look for neighbors.");
  await page.getByRole("button", { name: "Close companion" }).click();
  await page.setViewportSize({ width: 320, height: 568 });
  await page.screenshot({ path: testInfo.outputPath("roadmap-phone.png") });
  const size = await page.evaluate(() => ({
    viewport: innerWidth,
    body: document.documentElement.scrollWidth,
  }));
  expect(size.body).toBeLessThanOrEqual(size.viewport);
  for (const button of await page.getByRole("button").all()) {
    const rect = await button.boundingBox();
    if (rect) {
      expect(rect.height).toBeGreaterThanOrEqual(44);
      expect(rect.width).toBeGreaterThanOrEqual(44);
    }
  }
});

test("keyboard focus, dialog dismissal, accessible roadmap and lesson", async ({
  page,
}) => {
  const issues = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(issues.violations).toEqual([]);
  await page.getByRole("button", { name: "Profile", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "profile" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(
    page.getByRole("button", { name: "Save profile" }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("button", { name: "Close profile" }),
  ).toBeFocused();
  const profileIssues = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(profileIssues.violations).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Profile", exact: true }),
  ).toBeFocused();
  await page.getByRole("button", { name: "Continue learning →" }).click();
  await expect(
    page.getByRole("heading", { name: "Every number has a neighbor." }),
  ).toBeFocused();
  const lessonIssues = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(lessonIssues.violations).toEqual([]);
});

test("blocked device storage is explicit and learning still works", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Storage.prototype.setItem = () => {
      throw new Error("Storage blocked");
    };
    Storage.prototype.getItem = () => {
      throw new Error("Storage blocked");
    };
  });
  await page.reload();
  await expect(page.getByRole("alert")).toContainText(
    "Device storage is unavailable",
  );
  await page.getByRole("button", { name: "Continue learning →" }).click();
  await page.getByRole("button", { name: "Mark read & continue →" }).click();
  await expect(
    page.getByRole("heading", { name: "Which pair breaks the order?" }),
  ).toBeVisible();
});
