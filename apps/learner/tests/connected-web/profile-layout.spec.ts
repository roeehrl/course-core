import { expect, test, type Locator, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { chooseFromMenu } from "./learner-menu";

// "My profile" stacks panels that each read their own data after the view
// mounts. A panel that grows when its read finishes moves everything below it,
// and a press that starts on a control and ends after the move releases over
// whatever slid under the pointer (CI caught this on "Dispute suggestion").
// These journeys hold a read with page.route, measure a heading below the panel
// while it is pending, release the read, and require the heading to stay put.

const MAX_SHIFT = 3;

/** Distance from the top of the document, independent of scrolling. */
const documentTop = (target: Locator) =>
  target.evaluate((el) => el.getBoundingClientRect().top + window.scrollY);

/** Holds GET requests for one profile panel's read until released. */
async function hold(page: Page, path: RegExp, failWith?: number) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let seen = 0;
  await page.route(
    (url) => path.test(url.pathname),
    async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      seen++;
      await gate;
      if (failWith)
        await route.fulfill({
          status: failWith,
          contentType: "application/json",
          body: JSON.stringify({ error: "UNAVAILABLE" }),
        });
      else await route.fallback();
    },
  );
  return { release, seen: () => seen };
}

const headings = (page: Page) => ({
  memory: page.getByRole("heading", {
    name: "A profile you can shape.",
    exact: true,
  }),
  ideas: page.getByRole("heading", {
    name: "Ideas about what may help you",
    exact: true,
  }),
  changes: page.getByRole("heading", {
    name: "Your personal changes",
    exact: true,
  }),
});

async function openCourse(page: Page, request: Page["request"]) {
  const signIn = await request.post("/test/session");
  await page.goto(`/#signin=${(await signIn.json()).token}`);
  await page
    .getByRole("article")
    .filter({
      has: page.getByRole("heading", { name: "Ordering values", exact: true }),
    })
    .getByRole("button", { name: "Open course", exact: true })
    .click();
  await page.getByRole("button", { name: "Start course", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Ordering values", exact: true }),
  ).toBeVisible();
}

async function noHorizontalOverflow(page: Page) {
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
}

const supervisionRead = /^\/api\/enrollments\/[^/]+\/supervision$/;

test("the personal lesson support panel keeps its height while its permission loads", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await openCourse(page, page.request);
  const read = await hold(page, supervisionRead);
  await chooseFromMenu(page, "My profile");
  const below = headings(page).memory;
  const loadingStatus = page.getByLabel("Loading supervisor information", {
    exact: true,
  });
  await expect(loadingStatus).toHaveCount(1);
  await expect(below).toBeVisible();
  // Let the other panels settle so only the held read can move the heading.
  for (const label of ["Loading learning memory", "Loading teaching ideas"])
    await expect(page.getByLabel(label, { exact: true })).toHaveCount(0);
  expect(read.seen()).toBe(1);
  // While pending: one announced status, and the reserved button is not an
  // unlabelled or duplicate control.
  await expect(
    page.getByRole("button", { name: /personal support/ }),
  ).toHaveCount(0);
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await noHorizontalOverflow(page);
  const before = await documentTop(below);

  read.release();
  await expect(
    page.getByRole("button", { name: "Enable personal support", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Off", { exact: true })).toBeVisible();
  await expect(loadingStatus).toHaveCount(0);
  const after = await documentTop(below);
  expect(Math.abs(after - before)).toBeLessThanOrEqual(MAX_SHIFT);
  await noHorizontalOverflow(page);

  // Turning support on and refreshing the panel reads again: the badge and
  // button are replaced by the placeholder and back, still without movement.
  // The saved change raises the course revision, which reads the panel again;
  // let that read finish before holding the next one.
  const reread = page.waitForResponse(
    (r) =>
      r.request().method() === "GET" &&
      supervisionRead.test(new URL(r.url()).pathname),
  );
  await page
    .getByRole("button", { name: "Enable personal support", exact: true })
    .click();
  await reread;
  await expect(page.getByText("Enabled", { exact: true })).toBeVisible();
  await expect(loadingStatus).toHaveCount(0);
  const refresh = page.getByRole("button", {
    name: "Refresh supervisor information",
    exact: true,
  });
  await expect(refresh).toBeEnabled();
  const settled = await documentTop(below);
  const again = await hold(page, supervisionRead);
  await refresh.click();
  await expect(loadingStatus).toHaveCount(1);
  expect(Math.abs((await documentTop(below)) - settled)).toBeLessThanOrEqual(
    MAX_SHIFT,
  );
  again.release();
  await expect(
    page.getByRole("button", { name: "Turn off personal support", exact: true }),
  ).toBeVisible();
  expect(Math.abs((await documentTop(below)) - settled)).toBeLessThanOrEqual(
    MAX_SHIFT,
  );
  expect(errors).toEqual([]);
});

test("a failed permission read shows its notice in the reserved space", async ({
  page,
}) => {
  await openCourse(page, page.request);
  const read = await hold(page, supervisionRead, 503);
  await chooseFromMenu(page, "My profile");
  const below = headings(page).memory;
  await expect(
    page.getByLabel("Loading supervisor information", { exact: true }),
  ).toHaveCount(1);
  for (const label of ["Loading learning memory", "Loading teaching ideas"])
    await expect(page.getByLabel(label, { exact: true })).toHaveCount(0);
  const before = await documentTop(below);
  read.release();
  await expect(
    page.getByText(
      "Supervisor information is unavailable. Refresh to try again.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /personal support/ }),
  ).toHaveCount(0);
  expect(Math.abs((await documentTop(below)) - before)).toBeLessThanOrEqual(
    MAX_SHIFT,
  );
  await noHorizontalOverflow(page);
});

test("reopened learning memory and teaching ideas keep their height while they reload", async ({
  page,
}) => {
  await openCourse(page, page.request);
  await chooseFromMenu(page, "My profile");
  const { changes } = headings(page);
  for (const label of [
    "Loading supervisor information",
    "Loading learning memory",
    "Loading teaching ideas",
  ])
    await expect(page.getByLabel(label, { exact: true })).toHaveCount(0);
  const settled = await documentTop(changes);
  await page
    .getByRole("button", { name: "← Back to learning", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Ordering values", exact: true }),
  ).toBeVisible();

  const memory = await hold(page, /^\/api\/enrollments\/[^/]+\/learner-model$/);
  const ideas = await hold(
    page,
    /^\/api\/enrollments\/[^/]+\/learner-model\/hypotheses$/,
  );
  await chooseFromMenu(page, "My profile");
  await expect(
    page.getByLabel("Loading learning memory", { exact: true }),
  ).toHaveCount(1);
  await expect(
    page.getByLabel("Loading teaching ideas", { exact: true }),
  ).toHaveCount(1);
  await expect(
    page.getByLabel("Loading supervisor information", { exact: true }),
  ).toHaveCount(0);
  const pending = await documentTop(changes);
  expect(Math.abs(pending - settled)).toBeLessThanOrEqual(MAX_SHIFT);
  await noHorizontalOverflow(page);

  memory.release();
  ideas.release();
  for (const label of ["Loading learning memory", "Loading teaching ideas"])
    await expect(page.getByLabel(label, { exact: true })).toHaveCount(0);
  await expect(headings(page).memory).toBeVisible();
  expect(Math.abs((await documentTop(changes)) - pending)).toBeLessThanOrEqual(
    MAX_SHIFT,
  );
});

/** Opens the profile with one lower panel's read held, after the panels above
 * have settled, and returns the read's release and a heading below the panel. */
async function holdLowerPanel(page: Page, path: RegExp, below: string) {
  const read = await hold(page, path);
  await chooseFromMenu(page, "My profile");
  for (const label of [
    "Loading supervisor information",
    "Loading learning memory",
    "Loading teaching ideas",
  ])
    await expect(page.getByLabel(label, { exact: true })).toHaveCount(0);
  const heading = page.getByRole("heading", { name: below, exact: true });
  await expect(heading).toBeAttached();
  // A course-revision refresh can read again; every such read is held.
  expect(read.seen()).toBeGreaterThanOrEqual(1);
  return { read, heading };
}

test("your personal changes keeps its height while its list loads", async ({
  page,
}) => {
  await openCourse(page, page.request);
  const { read, heading } = await holdLowerPanel(
    page,
    /^\/api\/enrollments\/[^/]+\/personal-changes$/,
    "Your data",
  );
  const changes = page.getByRole("region", { name: "Your personal changes" });
  await expect(changes).toHaveAttribute("aria-busy", "true");
  await expect(changes.getByText("Checking…", { exact: true })).toBeVisible();
  // The reserved copy is invisible and not exposed.
  await expect(
    changes.getByText("Your course has no personal changes yet.", {
      exact: true,
    }),
  ).toBeHidden();
  await noHorizontalOverflow(page);
  const before = await documentTop(heading);
  read.release();
  await expect(
    changes.getByText("Your course has no personal changes yet.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(changes).toHaveAttribute("aria-busy", "false");
  expect(Math.abs((await documentTop(heading)) - before)).toBeLessThanOrEqual(
    MAX_SHIFT,
  );
});

test("staff access to your record keeps its height while it loads", async ({
  page,
}) => {
  await openCourse(page, page.request);
  const { read, heading } = await holdLowerPanel(
    page,
    /^\/api\/enrollments\/[^/]+\/staff-views$/,
    "Connected agents",
  );
  const access = page.getByRole("region", {
    name: "Staff access to your record",
  });
  await expect(access.getByText("Checking…", { exact: true })).toBeVisible();
  await noHorizontalOverflow(page);
  const before = await documentTop(heading);
  read.release();
  await expect(
    access.getByText(
      "No one on the course staff has viewed or downloaded your record.",
      { exact: true },
    ),
  ).toBeVisible();
  expect(Math.abs((await documentTop(heading)) - before)).toBeLessThanOrEqual(
    MAX_SHIFT,
  );
});

test("the review-assist choice keeps its space, inert and hidden, while it loads", async ({
  page,
  request,
}) => {
  // A course with written answers, where the choice applies.
  const fixture = await (await request.post("/test/rubric-session")).json();
  await page.goto(`/#signin=${fixture.token}`);
  await page.getByRole("button", { name: "Open course", exact: true }).click();
  await page.getByRole("button", { name: "Start course", exact: true }).click();
  await page
    .getByRole("region", { name: "Already know some of this?" })
    .getByRole("button", { name: "Start from the beginning" })
    .click();
  await expect(page.locator("section.connected-placement")).toHaveCount(0);
  const { read, heading } = await holdLowerPanel(
    page,
    /^\/api\/enrollments\/[^/]+\/review-assist$/,
    "Your data",
  );
  const choice = page.getByRole("checkbox", {
    name: "Let an AI draft notes for my reviewer",
  });
  // Laid out but not shown, announced or focusable before the saved choice is known.
  await expect(
    page.getByRole("heading", { name: "Reviews of your written answers" }),
  ).toHaveCount(0);
  await expect(choice).toHaveCount(0);
  await noHorizontalOverflow(page);
  const before = await documentTop(heading);
  read.release();
  await expect(choice).toBeVisible();
  await expect(choice).not.toBeChecked();
  await expect(choice).toBeEnabled();
  expect(Math.abs((await documentTop(heading)) - before)).toBeLessThanOrEqual(
    MAX_SHIFT,
  );
});
