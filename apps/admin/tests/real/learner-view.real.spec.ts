import { test, expect, type Page, type Request } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

async function signIn(page: Page, code: string) {
  await page.goto("/admin/");
  await page.getByLabel("One-time sign-in code").fill(code);
  await page.getByRole("button", { name: "Use code", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Course & releases", level: 1 }),
  ).toBeVisible();
  await page
    .getByRole("navigation", { name: "Workspace navigation" })
    .getByRole("button", { name: "Enrollments" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Enrollments", level: 1 }),
  ).toBeVisible();
}
const noHorizontalScroll = (page: Page) =>
  expect(
    page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    ),
  ).resolves.toBeLessThanOrEqual(1);

test("an owner opens a read-only, audited view of what one learner sees; the learner can see it happened", async ({
  page,
  browser,
}, info) => {
  const fixture = await (
    await page.request.post("/test/learner-view-fixture")
  ).json();
  await signIn(page, fixture.ownerCode);
  const before = (await page.context().cookies())
    .map((c) => `${c.name}=${c.value}`)
    .sort();
  const writes: string[] = [];
  const watch = (request: Request) => {
    if (request.method() !== "GET")
      writes.push(`${request.method()} ${new URL(request.url()).pathname}`);
  };
  page.on("request", watch);

  const card = page
    .locator("section.card")
    .filter({ has: page.getByRole("heading", { name: "View as learner" }) });
  await expect(card).toContainText("Each opening is recorded");
  await card
    .getByRole("button", { name: "Open read-only learner view" })
    .click();
  const dialog = page.getByRole("dialog", { name: /Avery Learner/ });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByText("Read-only view of Avery Learner's learning space"),
  ).toBeVisible();
  await expect(
    dialog.getByText(/Opened .* by Viewing owner \(owner\)/),
  ).toBeVisible();
  // Private parts are named, never shown.
  const withheld = dialog
    .getByRole("status")
    .filter({ hasText: "Not shown to staff" });
  await expect(withheld).toContainText("Companion conversation");
  await expect(
    dialog.getByText("A private question for my companion only."),
  ).toHaveCount(0);

  // Roadmap and progress as the learner app computes them.
  const path = dialog.getByRole("navigation", {
    name: "Learner's learning path",
  });
  await expect(
    path.getByRole("button", { name: /Minimum.*Available · next/ }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    path.getByRole("button", { name: /Maximum.*Locked/ }),
  ).toBeVisible();
  await expect(dialog.getByText("0 of 2", { exact: true })).toBeVisible();

  // Current episode content, including the visual, rendered without any learner action.
  const lesson = dialog.getByRole("article", { name: "Minimum" });
  await expect(lesson.getByText("1 of 2 parts read")).toBeVisible();
  await expect(
    lesson.getByRole("region", { name: "Part 1: Reading" }),
  ).toContainText("The minimum is no greater than any other member.");
  await expect(
    lesson
      .getByRole("region", { name: "Part 1: Reading" })
      .getByText("read", { exact: true }),
  ).toBeVisible();
  const visual = lesson.getByRole("region", { name: "Part 2: Illustration" });
  await expect(visual.locator("svg").first()).toBeVisible();
  // Gate evidence and the open check, with no way to answer it.
  await expect(
    lesson.getByText("1 of 2 independent item families"),
  ).toBeVisible();
  const check = lesson
    .locator("section.card")
    .filter({ has: page.getByRole("heading", { name: "Open check" }) });
  await expect(check).toContainText("Which is smaller?");
  await expect(check.getByRole("radio")).toHaveCount(2);
  for (const radio of await check.getByRole("radio").all())
    await expect(radio).toBeDisabled();
  // Pending review and personal changes as the learner sees them.
  const reviews = dialog
    .locator("section.card")
    .filter({
      has: page.getByRole("heading", { name: "Written answers and reviews" }),
    });
  await expect(reviews).toContainText("pending review");
  await expect(
    dialog.getByText("The learner follows the course as published."),
  ).toBeVisible();
  // No learner command is offered anywhere in the view.
  for (const name of [
    /mark .* read/i,
    /submit/i,
    /answer/i,
    /complete/i,
    /send/i,
    /hide/i,
    /start/i,
  ])
    await expect(dialog.getByRole("button", { name })).toHaveCount(0);
  // The only live controls are the illustration's own playback controls, exactly as
  // the learner has them; they change local playback, never learner state.
  const controls = dialog.locator("input:not([disabled]), textarea, select");
  await expect(controls).toHaveCount(
    await visual.locator("input:not([disabled]), textarea, select").count(),
  );
  await visual.getByRole("checkbox", { name: "Position guides" }).click();

  await path.getByRole("button", { name: /Maximum/ }).click();
  await expect(dialog.getByRole("article", { name: "Maximum" })).toContainText(
    "The maximum is no less than any other member.",
  );
  expect(
    (
      await new AxeBuilder({ page })
        .include("dialog")
        .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await expect(
    dialog.evaluate((node) => node.scrollWidth - node.clientWidth),
  ).resolves.toBeLessThanOrEqual(1);
  await noHorizontalScroll(page);
  await page.screenshot({ path: info.outputPath("learner-view.png") });
  await dialog.getByRole("button", { name: /^Close / }).click();
  await expect(dialog).toHaveCount(0);

  // Only reads went out, and no learner session or cookie was created.
  page.off("request", watch);
  expect(writes).toEqual([]);
  expect(
    (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).sort(),
  ).toEqual(before);

  // The learner sees that this owner viewed their record, and it is in their export.
  const learnerContext = await browser.newContext({
    baseURL: info.project.use.baseURL,
  });
  const learner = learnerContext.request;
  expect(
    (
      await learner.post("/auth/redeem", {
        headers: { origin: info.project.use.baseURL! },
        data: { token: fixture.learnerCode },
      })
    ).ok(),
  ).toBeTruthy();
  const views = (
    await (
      await learner.get(`/api/enrollments/${fixture.enrollmentId}/staff-views`)
    ).json()
  ).views;
  expect(views).toEqual([
    expect.objectContaining({
      viewerName: "Viewing owner",
      viewerRole: "owner",
    }),
  ]);
  const exported = await (
    await learner.get(`/api/enrollments/${fixture.enrollmentId}/export`)
  ).json();
  expect(exported.staffViews).toEqual([
    expect.objectContaining({ id: views[0].id, viewerName: "Viewing owner" }),
  ]);
  await learnerContext.close();
});

test("an instructor gets no learner view, in the interface or from the API", async ({
  page,
}) => {
  const fixture = await (
    await page.request.post("/test/learner-view-fixture")
  ).json();
  await signIn(page, fixture.instructorCode);
  await expect(
    page.getByRole("heading", { name: "Evidence & decisions" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "View as learner" }),
  ).toHaveCount(0);
  const refused = await page.request.get(
    `/api/admin/enrollments/${fixture.enrollmentId}/learner-view`,
  );
  expect(refused.status()).toBe(403);
  await noHorizontalScroll(page);
});

test("an owner sees the course-made media attached for the learner, read-only, playable only under the recorded view", async ({
  page,
  browser,
}, info) => {
  const fixture = await (
    await page.request.post("/test/learner-view-media-fixture")
  ).json();
  await signIn(page, fixture.ownerCode);
  const writes: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "GET")
      writes.push(`${request.method()} ${new URL(request.url()).pathname}`);
  });
  const opened = page.waitForResponse((response) =>
    new URL(response.url()).pathname.endsWith(
      `/enrollments/${fixture.enrollmentId}/learner-view`,
    ),
  );
  await page
    .locator("section.card")
    .filter({ has: page.getByRole("heading", { name: "View as learner" }) })
    .getByRole("button", { name: "Open read-only learner view" })
    .click();
  const view = await (await opened).json();
  const dialog = page.getByRole("dialog", { name: /Avery Learner/ });
  const lesson = dialog.getByRole("article", { name: "Minimum" });
  const help = lesson
    .locator("section.card")
    .filter({ has: page.getByRole("heading", { name: "Optional help" }) });
  await expect(help).toBeVisible();
  // Only the clip the learner is shown; the revoked one is absent.
  await expect(
    help.getByRole("heading", { name: "Running minimum in motion" }),
  ).toBeVisible();
  await expect(help.getByText("Superseded minimum clip")).toHaveCount(0);
  await expect(help.getByText("shown to learner")).toBeVisible();
  await expect(help.getByText("English captions")).toBeVisible();
  await expect(
    help.getByText(
      "The running minimum keeps the smaller value after each comparison in the list.",
    ),
  ).toBeVisible();
  await expect(
    help.getByText(/A list of five boxes; a highlight moves/),
  ).toBeVisible();
  // A player with the learner's captions, or a placeholder where this browser cannot play
  // the format. The synthetic clip is not decodable, so loading it ends at the placeholder.
  const player = help.locator("video");
  const placeholder = help.getByText("Video not playable here.");
  if (await player.count()) {
    await expect(player).toHaveAttribute("preload", "none");
    await expect(help.locator("source")).toHaveAttribute(
      "src",
      view.generatedMedia[0].assetUrl,
    );
    await expect(help.locator("track")).toHaveAttribute(
      "src",
      view.generatedMedia[0].captionsUrl,
    );
    await player.evaluate((node: HTMLVideoElement) => node.load());
  }
  await expect(placeholder).toBeVisible();
  // The links serve the clip and captions under this view only.
  expect(view.generatedMedia[0].assetUrl).toContain(
    `/learner-view/${view.view.id}/media/${fixture.attachmentId}/asset`,
  );
  const asset = await page.request.get(view.generatedMedia[0].assetUrl);
  expect(asset.status()).toBe(200);
  expect(asset.headers()["content-type"]).toBe("video/mp4");
  const captions = await page.request.get(view.generatedMedia[0].captionsUrl);
  expect(await captions.text()).toContain("WEBVTT");
  const forged = view.generatedMedia[0].assetUrl.replace(
    view.view.id,
    fixture.enrollmentId,
  );
  expect((await page.request.get(forged)).status()).toBe(403);
  // No learner command or credit control; only reads went out.
  await expect(help.getByRole("button")).toHaveCount(0);
  expect(writes).toEqual([]);
  expect(
    (
      await new AxeBuilder({ page })
        .include("dialog")
        .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await expect(
    dialog.evaluate((node) => node.scrollWidth - node.clientWidth),
  ).resolves.toBeLessThanOrEqual(1);
  await noHorizontalScroll(page);
  await help.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("learner-view-media.png") });

  // The learner sees this view among staff access to their record.
  const learnerContext = await browser.newContext({
    baseURL: info.project.use.baseURL,
  });
  expect(
    (
      await learnerContext.request.post("/auth/redeem", {
        headers: { origin: info.project.use.baseURL! },
        data: { token: fixture.learnerCode },
      })
    ).ok(),
  ).toBeTruthy();
  const views = (
    await (
      await learnerContext.request.get(
        `/api/enrollments/${fixture.enrollmentId}/staff-views`,
      )
    ).json()
  ).views;
  expect(views).toEqual([
    expect.objectContaining({ id: view.view.id, viewerRole: "owner" }),
  ]);
  await learnerContext.close();
});
