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

test("configure a host-folder update source, check for updates and update to a published release", async ({
  page,
}, info) => {
  const fixture = await (
    await page.request.post("/test/course-update-fixture")
  ).json();
  await page.goto("/admin/");
  await page.getByLabel("One-time sign-in code").fill(fixture.code);
  await page.getByRole("button", { name: "Use code", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Course & releases", level: 1 }),
  ).toBeVisible();

  await page.getByRole("radio", { name: "Host folder" }).check();
  await page.getByLabel("Folder or file inside it").fill("../outside");
  await page.getByRole("button", { name: "Save update source" }).click();
  await expect(
    page.getByText(
      "Use a relative folder path inside the chosen package directory.",
    ),
  ).toBeVisible();
  await page.getByLabel("Folder or file inside it").fill(fixture.subpath);
  await page.getByRole("button", { name: "Save update source" }).click();
  await expect(
    page.getByText(
      "Update source saved. Automatic updates are off until you choose a level.",
      { exact: true },
    ),
  ).toBeVisible();

  await page.getByRole("button", { name: "Check for updates" }).click();
  const update = page.getByRole("region", { name: "Update to version 1.1.0" });
  await expect(
    update.getByText("Changes from the live release (1.0.0)"),
  ).toBeVisible();
  await expect(
    update.getByText(/assessments: 0 added, 1 changed, 0 removed/),
  ).toBeVisible();
  await accessible(page);
  await page.screenshot({
    path: info.outputPath("update-available.png"),
    fullPage: true,
  });

  await update.getByRole("button", { name: "Update to 1.1.0" }).click();
  const dialog = page.getByRole("dialog", { name: "Update to 1.1.0" });
  await expect(
    dialog.getByRole("heading", { name: "Ordering values · version 1.1.0" }),
  ).toBeFocused();
  await expect(
    dialog.getByText(/Host folder .*ordering-1\.1\.0\.course\.tgz/),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Install draft" }).click();
  await dialog.getByRole("button", { name: "Approve review" }).click();
  await dialog
    .getByRole("checkbox", { name: "I confirm publication of version 1.1.0." })
    .check();
  await dialog.getByRole("button", { name: "Confirm publication" }).click();
  await expect(dialog.getByText("Available to new learners")).toBeVisible();
  await accessible(page);
  await dialog.getByRole("button", { name: "Done — open this course" }).click();
  await expect(
    page.getByRole("button", { name: /^Version 1\.1\.0/ }),
  ).toContainText("Available to new learners");

  // Checking again finds nothing newer.
  await page.getByRole("button", { name: "Check for updates" }).click();
  await expect(
    page.getByText("Up to date: the newest version at the source is 1.1.0.", {
      exact: true,
    }),
  ).toBeVisible();

  // Automatic publication needs the explicit acknowledgement.
  await page.getByLabel("Automatic level").selectOption("publish");
  await expect(
    page.getByRole("button", { name: "Save automatic updates" }),
  ).toBeDisabled();
  await page
    .getByRole("checkbox", {
      name: /I authorize automatic review approval and publication/,
    })
    .check();
  await page.getByRole("button", { name: "Save automatic updates" }).click();
  await expect(
    page.getByText("Automatic publication authorized by Update owner."),
  ).toBeVisible();
  await accessible(page);
});
