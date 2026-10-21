import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

async function signIn(page: Page) {
  const setup = await page.request.post("/test/admin-fixture");
  expect(setup.ok()).toBeTruthy();
  const data = await setup.json();
  await page.goto("/admin/");
  await page.getByLabel("One-time sign-in code").fill(data.code);
  await page.getByRole("button", { name: "Use code", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Course & releases", level: 1 }),
  ).toBeVisible();
  return data as { enrollmentId: string; learnerCode: string };
}
async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
}

test("staff add, inspect, review with exact evidence, attach and revoke a research source", async ({
  page,
  browser,
}, info) => {
  const fixture = await signIn(page);
  await page
    .getByRole("navigation", { name: "Workspace navigation" })
    .getByRole("button", { name: "Research sources" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Research sources", level: 1 }),
  ).toBeVisible();
  await expect(page.getByText("Untrusted until reviewed")).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "Public explanation of finding the minimum of a list",
    }),
  ).toBeVisible();

  // An off-domain address is refused by the server and nothing is stored.
  await page.getByRole("button", { name: "Add source" }).click();
  await page
    .getByLabel("Public HTTPS address")
    .fill("https://evil.example/minimum");
  await page
    .getByRole("button", { name: "Add source", exact: true })
    .last()
    .click();
  await expect(
    page.getByText(
      "This topic only allows sources from its author-approved domains.",
    ),
  ).toBeVisible();
  await page
    .getByLabel("Public HTTPS address")
    .fill("https://docs.python.org/3/library/functions.html");
  await page
    .getByRole("button", { name: "Add source", exact: true })
    .last()
    .click();
  await expect(
    page.getByText(
      "Source approved for inspection. Its content is not reviewed yet.",
    ),
  ).toBeVisible();
  await expect(page.getByText("not inspected")).toBeVisible();

  await page.getByRole("button", { name: "Inspect now" }).click();
  await expect(
    page.getByText("Inspection saved as unreviewed content."),
  ).toBeVisible();
  await expect(page.getByText("inspected unreviewed")).toBeVisible();

  await page.getByRole("button", { name: "Review content" }).click();
  const dialog = page.getByRole("dialog", { name: "Review inspected content" });
  await expect(
    dialog.getByRole("region", { name: "Text under review" }),
  ).toContainText("Each comparison keeps the smaller value");
  await dialog
    .getByLabel("Why this decision")
    .fill("Explains the running-minimum invariant with a concrete loop.");
  await dialog
    .getByLabel("Exact quote 1")
    .fill("The minimum is always the first element of the list");
  await expect(dialog.getByText(/does not appear exactly/)).toBeVisible();
  await dialog
    .getByLabel("Exact quote 1")
    .fill("Each comparison keeps the smaller value");
  await expect(dialog.getByText(/does not appear exactly/)).toHaveCount(0);
  await dialog
    .getByLabel("Why quote 1 matters")
    .fill("States the invariant learners must explain in this episode.");
  // Approval without all suitability checks is refused server-side.
  await dialog.getByRole("button", { name: "Record review" }).click();
  await expect(
    page.getByText(/Approval needs at least one exact quote/),
  ).toBeVisible();
  for (const name of [
    /Relevant to the approved topic/,
    /Accurate enough to use/,
    /Safe and appropriate/,
  ])
    await dialog.getByRole("checkbox", { name }).check();
  await expect(
    new AxeBuilder({ page })
      .include("dialog")
      .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
      .analyze(),
  ).resolves.toMatchObject({ violations: [] });
  await dialog.getByRole("button", { name: "Record review" }).click();
  await expect(page.getByText("Review recorded: approved.")).toBeVisible();

  await page.getByRole("button", { name: "Attach to episode" }).click();
  await page.getByRole("button", { name: "Attach resource" }).click();
  await expect(
    page.getByText("Resource attached as optional help for that episode."),
  ).toBeVisible();
  const delivered = page.getByRole("table");
  await expect(delivered.getByText("active")).toBeVisible();
  await noHorizontalOverflow(page);
  await page.screenshot({
    path: info.outputPath("research-attached.png"),
    fullPage: true,
  });
  const scan = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(scan.violations).toEqual([]);

  // The learner receives exactly the reviewed display, labelled optional and without credit.
  const learner = await browser.newContext({
    baseURL: info.project.use.baseURL,
  });
  const redeemed = await learner.request.post("/auth/redeem", {
    headers: { origin: info.project.use.baseURL! },
    data: { token: fixture.learnerCode },
  });
  expect(redeemed.ok()).toBeTruthy();
  const resources = await (
    await learner.request.get(
      `/api/enrollments/${fixture.enrollmentId}/resources?episodeId=min`,
    )
  ).json();
  expect(resources).toMatchObject({ optional: true, grantsCredit: false });
  expect(resources.resources).toHaveLength(1);
  expect(resources.resources[0]).toMatchObject({
    title: "Finding a minimum",
    url: "https://docs.python.org/3/library/functions.html",
    rightsUse: "link_only",
  });

  await delivered.getByRole("button", { name: "Revoke" }).click();
  await page
    .getByLabel("Reason")
    .fill("The source page changed its explanation.");
  await page
    .getByRole("button", { name: "Revoke", exact: true })
    .last()
    .click();
  await expect(
    page.getByText("Attachment revoked. Learners no longer see it."),
  ).toBeVisible();
  await expect(delivered.getByText("revoked")).toBeVisible();
  const after = await (
    await learner.request.get(
      `/api/enrollments/${fixture.enrollmentId}/resources?episodeId=min`,
    )
  ).json();
  expect(after.resources).toEqual([]);
  await learner.close();
});

test("staff search YouTube with the workspace key, add a result and review only the watched segment", async ({
  page,
}, info) => {
  await signIn(page);
  const sent: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("youtube-search")) sent.push(r.postData() ?? "");
  });
  const nav = page.getByRole("navigation", { name: "Workspace navigation" });
  await nav.getByRole("button", { name: "Research sources" }).click();
  // Without an admin-entered key, search is unavailable and says where the key goes.
  await page.getByRole("button", { name: "Search YouTube" }).click();
  await expect(
    page.getByText(/AI services, under Advanced \(for developers\)/),
  ).toBeVisible();

  const key = ["synthetic", "browser", "youtube", "key"].join("-");
  await page.getByRole("button", { name: "AI services", exact: true }).click();
  await page.locator("#ai-advanced summary").click();
  await page.getByLabel("YouTube search key").fill(key);
  await page.getByRole("button", { name: "Save key", exact: true }).click();
  await expect(page.getByText("Key saved.", { exact: true })).toBeVisible();

  await nav.getByRole("button", { name: "Research sources" }).click();
  const bodies: string[] = [];
  page.on("response", (r) => {
    if (r.url().includes("/research"))
      void r
        .text()
        .then((b) => bodies.push(b))
        .catch(() => {});
  });
  await page.getByRole("button", { name: "Search YouTube" }).click();
  await expect(
    page.getByText(/YouTube results saved as unreviewed leads/),
  ).toBeVisible();
  // The browser sends only a result count; the server sends the topic's approved query.
  expect(sent.every((body) => body === '{"maxResults":5}')).toBe(true);
  // Today's quota is shown, and the key can be checked with one unit before relying on it.
  await expect(
    page.getByText(/Today: 1 of 100 searches and 2 of 10,000 quota units used/),
  ).toBeVisible();
  await page.getByRole("button", { name: "Check the YouTube key" }).click();
  await expect(
    page.getByText("The key works and the YouTube Data API is enabled."),
  ).toBeVisible();
  await expect(
    page.getByText(/Today: 1 of 100 searches and 3 of 10,000 quota units used/),
  ).toBeVisible();
  await page.getByText(/2 YouTube results · metadata only, unreviewed/).click();
  await expect(page.getByText("Running minimum, step by step")).toBeVisible();
  await expect(page.getByText(/embedding not allowed/)).toBeVisible();
  await expect(
    page.getByText(/“Public explanation of finding the minimum of a list”/),
  ).toBeVisible();
  await page.getByRole("button", { name: "Use as source" }).first().click();
  const add = page.getByRole("dialog", { name: "Add a source to inspect" });
  await expect(add.getByRole("radio", { name: "YouTube video" })).toBeChecked();
  await add
    .getByLabel("Written alternative")
    .fill(
      "The video keeps the smaller value after each comparison until the list ends.",
    );
  await add.getByRole("button", { name: "Add source", exact: true }).click();
  await expect(
    page.getByText(
      "Source approved for inspection. Its content is not reviewed yet.",
    ),
  ).toBeVisible();
  await expect(page.getByText(/4:13 · captions ·/)).toBeVisible();
  await page.getByRole("button", { name: "Inspect now" }).click();
  await expect(
    page.getByText("Inspection saved as unreviewed content."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Review content" }).click();
  const dialog = page.getByRole("dialog", { name: "Review inspected content" });
  await dialog
    .getByLabel("Why this decision")
    .fill("Walks through the running-minimum loop with a worked trace.");
  await dialog
    .getByLabel("Exact quote 1")
    .fill("keeps the smaller value after each comparison");
  await dialog
    .getByLabel("Why quote 1 matters")
    .fill("States the invariant learners explain in this episode.");
  for (const name of [
    /Relevant to the approved topic/,
    /Accurate enough to use/,
    /Safe and appropriate/,
  ])
    await dialog.getByRole("checkbox", { name }).check();
  await dialog.getByLabel("Start (seconds)").fill("30");
  await dialog.getByLabel("End (seconds)").fill("400");
  await dialog.getByRole("button", { name: "Record review" }).click();
  await expect(
    page.getByText("The reviewed segment ends after the video does."),
  ).toBeVisible();
  await dialog.getByLabel("End (seconds)").fill("200");
  await expect(
    new AxeBuilder({ page })
      .include("dialog")
      .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
      .analyze(),
  ).resolves.toMatchObject({ violations: [] });
  await dialog.getByRole("button", { name: "Record review" }).click();
  await expect(page.getByText("Review recorded: approved.")).toBeVisible();
  await expect(page.getByText(/Reviewed part: 0:30–3:20\./)).toBeVisible();
  for (const body of bodies) expect(body).not.toContain(key);
  await noHorizontalOverflow(page);
  await page.screenshot({
    path: info.outputPath("research-youtube.png"),
    fullPage: true,
  });
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
});
