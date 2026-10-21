import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { writeFileSync } from "node:fs";

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
async function signIn(page: Page) {
  const fixture = await (
    await page.request.post("/test/course-package-fixture")
  ).json();
  await page.goto("/admin/");
  await page.getByLabel("One-time sign-in code").fill(fixture.code);
  await page.getByRole("button", { name: "Use code", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Course & releases", level: 1 }),
  ).toBeVisible();
  return fixture as { update: string; newCourse: string; older: string };
}

test("install a synthetic course package by upload, then review and publish it on the same screen", async ({
  page,
}, info) => {
  const fixture = await signIn(page);
  const file = info.outputPath("ordering-1.1.0.course.tgz");
  writeFileSync(file, Buffer.from(fixture.update, "base64"));

  await page.getByRole("button", { name: "Install course" }).click();
  const dialog = page.getByRole("dialog", { name: "Install course" });
  await expect(
    dialog.getByRole("radio", { name: "Upload package file" }),
  ).toBeChecked();
  await dialog.getByLabel("Course package file").setInputFiles(file);
  await dialog.getByRole("button", { name: "Inspect package" }).click();
  const heading = dialog.getByRole("heading", {
    name: "Ordering values · version 1.1.0",
  });
  await expect(heading).toBeFocused();
  await expect(
    dialog.getByText(
      "A new version of a course this workspace has. Newest installed: 1.0.0.",
    ),
  ).toBeVisible();
  await expect(
    dialog.getByText("This host can run the course as declared."),
  ).toBeVisible();
  await expect(
    dialog.getByText("None. The package needs no host-configured files."),
  ).toBeVisible();
  await accessible(page);
  await page.screenshot({
    path: info.outputPath("package-preview.png"),
    fullPage: true,
  });

  await dialog.getByRole("button", { name: "Install draft" }).click();
  await expect(
    dialog.getByRole("heading", { name: "Release 1.1.0 installed" }),
  ).toBeFocused();
  await expect(
    dialog.getByText("pending review", { exact: true }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Approve review" }).click();
  const confirm = dialog.getByRole("button", { name: "Confirm publication" });
  await expect(confirm).toBeDisabled();
  await dialog
    .getByRole("checkbox", { name: "I confirm publication of version 1.1.0." })
    .check();
  await confirm.click();
  await expect(dialog.getByText("Available to new learners")).toBeVisible();
  await accessible(page);
  await page.screenshot({
    path: info.outputPath("package-published.png"),
    fullPage: true,
  });
  await dialog.getByRole("button", { name: "Done — open this course" }).click();
  await expect(dialog).toHaveCount(0);

  // The course page shows the published release, with the package recorded in its notes.
  const row = page.getByRole("button", { name: /^Version 1\.1\.0/ });
  await expect(row).toContainText("Available to new learners");
  await expect(row).toContainText(
    /Installed from course package [a-f0-9]{12} \(uploaded file\)\./,
  );
  // The manual draft path is still offered.
  await expect(page.getByRole("button", { name: "New draft" })).toBeEnabled();
});

test("install a new course with approve-and-publish in one confirmed step, then open it", async ({
  page,
}, info) => {
  const fixture = await signIn(page);
  const file = info.outputPath("ordering-companion-1.0.0.course.tgz");
  writeFileSync(file, Buffer.from(fixture.newCourse, "base64"));
  await page.getByRole("button", { name: "Install course" }).click();
  const dialog = page.getByRole("dialog", { name: "Install course" });
  await dialog.getByLabel("Course package file").setInputFiles(file);
  await dialog.getByRole("button", { name: "Inspect package" }).click();
  await expect(
    dialog.getByText("A new course for this workspace."),
  ).toBeVisible();
  await dialog
    .getByRole("checkbox", {
      name: "Also approve the review and publish this version now",
    })
    .check();
  const submit = dialog.getByRole("button", {
    name: "Install, approve and publish",
  });
  await expect(submit).toBeDisabled();
  await dialog.getByLabel("Type 1.0.0 to confirm publication").fill("1.0.0");
  await submit.click();
  await expect(
    dialog.getByRole("heading", { name: "Release 1.0.0 installed" }),
  ).toBeFocused();
  await expect(dialog.getByText("Available to new learners")).toBeVisible();
  await dialog.getByRole("button", { name: "Done — open this course" }).click();
  // Administration switches to the newly installed course.
  await expect(
    page.getByRole("button", { name: /^Version 1\.0\.0/ }),
  ).toContainText("Available to new learners");
  await expect(
    page.getByLabel("Course", { exact: true }).locator("option:checked"),
  ).toHaveText("Ordering companion");
  await accessible(page);
});

test("installing and publishing an older version than the published one needs an explicit choice", async ({
  page,
}, info) => {
  const fixture = await signIn(page);
  const file = info.outputPath("ordering-0.9.0.course.tgz");
  writeFileSync(file, Buffer.from(fixture.older, "base64"));
  await page.getByRole("button", { name: "Install course" }).click();
  const dialog = page.getByRole("dialog", { name: "Install course" });
  await dialog.getByLabel("Course package file").setInputFiles(file);
  await dialog.getByRole("button", { name: "Inspect package" }).click();
  await expect(dialog.getByText("This is an older version")).toBeVisible();
  await expect(
    dialog.getByText(
      /Version 1\.0\.0 of this course is already installed here, and this package is version 0\.9\.0\./,
    ),
  ).toBeVisible();
  const install = dialog.getByRole("button", { name: "Install draft" });
  await expect(install).toBeDisabled();
  await accessible(page);
  await dialog
    .getByRole("checkbox", {
      name: "I want to install the older version 0.9.0",
    })
    .check();
  await dialog
    .getByRole("checkbox", {
      name: "Also approve the review and publish this version now",
    })
    .check();
  await dialog.getByLabel("Type 0.9.0 to confirm publication").fill("0.9.0");
  await dialog
    .getByRole("button", { name: "Install, approve and publish" })
    .click();
  await expect(
    dialog.getByRole("heading", { name: "Release 0.9.0 installed" }),
  ).toBeFocused();
  await expect(dialog.getByText("Available to new learners")).toBeVisible();
  await page.screenshot({
    path: info.outputPath("package-older-version.png"),
    fullPage: true,
  });
});

test("a GitHub link is refused clearly when it is not a GitHub release link", async ({
  page,
}) => {
  await signIn(page);
  await page.getByRole("button", { name: "Install course" }).click();
  const dialog = page.getByRole("dialog", { name: "Install course" });
  await dialog.getByRole("radio", { name: "From GitHub" }).check();
  await dialog
    .getByLabel("GitHub link")
    .fill("https://example.org/course.course.tgz");
  await dialog.getByRole("button", { name: "Inspect package" }).click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Use a github.com repository, release or release-asset link.",
  );
  await accessible(page);
});

test("a slow, interrupted upload and an unconfirmed install recover without installing twice (I06)", async ({
  page,
}, info) => {
  test.skip(
    !info.project.name.endsWith("desktop"),
    "One viewport covers the network handling.",
  );
  const fixture = await signIn(page);
  const file = info.outputPath("ordering-1.1.0.course.tgz");
  writeFileSync(file, Buffer.from(fixture.update, "base64"));
  await page.getByRole("button", { name: "Install course" }).click();
  const dialog = page.getByRole("dialog", { name: "Install course" });
  await dialog.getByLabel("Course package file").setInputFiles(file);

  // A slow connection that then drops mid-upload: the request never reaches the server.
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(
    "**/course-packages/inspect*",
    async (route) => {
      await held;
      await route.abort("connectionreset");
    },
    { times: 1 },
  );
  await dialog.getByRole("button", { name: "Inspect package" }).click();
  await expect(dialog.getByText(/^Still working\./)).toBeVisible({
    timeout: 15000,
  });
  release();
  await expect(
    dialog.getByText(
      /The upload stopped before the server received the whole file/,
    ),
  ).toBeVisible();
  await expect(dialog.getByText(/^Still working\./)).toHaveCount(0);
  // The file is still selected; inspecting again sends it.
  await dialog.getByRole("button", { name: "Inspect package" }).click();
  await expect(
    dialog.getByRole("heading", { name: "Ordering values · version 1.1.0" }),
  ).toBeFocused();

  // The server installs the draft, but the answer never reaches the browser.
  let installs = 0;
  await page.route(
    "**/course-packages/*/install",
    async (route) => {
      installs++;
      await route.fetch();
      await route.abort("connectionreset");
    },
    { times: 1 },
  );
  await dialog.getByRole("button", { name: "Install draft" }).click();
  await expect(
    dialog.getByText(
      /The connection dropped before the server confirmed the install/,
    ),
  ).toBeVisible();
  await accessible(page);
  await dialog.getByRole("button", { name: "Install draft" }).click();
  await expect(
    dialog.getByRole("heading", { name: "Release 1.1.0 installed" }),
  ).toBeFocused();
  await expect(dialog.locator('[aria-live="polite"]').first()).toContainText(
    "This package was already installed.",
  );
  expect(installs).toBe(1);
});
