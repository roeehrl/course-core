import { test, expect, type Page } from "@playwright/test";
import { connectedSnapshot } from "../connectedFixtures";

/* The mouse wheel / trackpad scrolls the learner on wide screens, also with the
 * pointer over the side margins outside the centred content column.
 *
 * Expo's web template sets `body { overflow: hidden }`. The connected host's
 * wide layout scrolls the page itself, and a hidden body overflow propagates to
 * the viewport: the page was taller than the window but the wheel did nothing.
 * Programmatic scrolling (focus, scrollIntoView) still worked, so other specs
 * never noticed. This runs in the "desktop" (Chromium) and "webkit-wide"
 * projects. */

const VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
];

/** A course long enough to overflow a 2560x1440 window on every screen. */
function longCourse() {
  const snapshot = connectedSnapshot();
  const chapter = snapshot.course.chapters[0]!;
  const intro = chapter.episodes[0]!;
  const reading = intro.blocks[0] as { markdown: string };
  reading.markdown = [
    "# Observe",
    ...Array.from(
      { length: 40 },
      (_, i) =>
        `Paragraph ${i + 1}. Patterns change over time, and noticing how they change is the first step toward explaining them.`,
    ),
  ].join("\n\n");
  for (let i = 1; i <= 24; i++) {
    chapter.episodes.push({
      ...intro,
      id: `more-${i}`,
      title: `Another pattern ${i}`,
    });
    snapshot.lessons.push({
      ...snapshot.lessons[0]!,
      id: `more-${i}`,
      status: "locked",
    });
  }
  return snapshot;
}

async function connectedFixture(page: Page) {
  const snapshot = longCourse();
  await page.route("**/auth/session", (route) =>
    route.fulfill({
      json: { user: { id: "public-user", displayName: "Public learner" } },
    }),
  );
  await page.route("**/auth/passkeys", (route) =>
    route.fulfill({ json: { available: true, passkeys: [] } }),
  );
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/me/locale")
      return route.fulfill({
        json: { preference: null, locale: "en", source: "default" },
      });
    if (path === "/api/enrollments")
      return route.fulfill({
        json: [
          {
            id: snapshot.enrollmentId,
            title: snapshot.course.title,
            version: "1.0.0",
            status: "active",
          },
        ],
      });
    if (path === "/api/workspaces") return route.fulfill({ json: [] });
    if (path.endsWith("/companion"))
      return route.fulfill({ json: { messages: [] } });
    if (path === `/api/enrollments/${snapshot.enrollmentId}`)
      return route.fulfill({ json: snapshot });
    return route.fulfill({ status: 404, json: { error: "NOT_FOUND" } });
  });
}

/** How far the page or any scroll container under it has scrolled. */
const scrolled = (page: Page) =>
  page.evaluate(() =>
    Math.max(
      window.scrollY,
      ...Array.from(document.querySelectorAll("*"), (el) => el.scrollTop),
    ),
  );

/** Wheels at the content centre and over both side margins; each must scroll. */
async function expectWheelScrolls(
  page: Page,
  screen: string,
  column = ".connected-layout",
) {
  const { width, height } = page.viewportSize()!;
  const overflow = await page.evaluate(() => {
    const doc = document.scrollingElement!;
    const inner = Array.from(document.querySelectorAll("*"), (el) =>
      /(auto|scroll)/.test(getComputedStyle(el).overflowY)
        ? el.scrollHeight - el.clientHeight
        : 0,
    );
    return Math.max(doc.scrollHeight - doc.clientHeight, ...inner);
  });
  // Otherwise the check proves nothing: the content must need scrolling.
  expect(
    overflow,
    `${screen} at ${width}x${height} must be taller than the window`,
  ).toBeGreaterThan(100);
  if (column) {
    // The margins are outside the centred column, where wheel events are easily lost.
    const left = await page
      .locator(column)
      .first()
      .evaluate((el) => el.getBoundingClientRect().left);
    expect(
      left,
      "wide screens leave a margin beside the content column",
    ).toBeGreaterThan(40);
  }
  for (const [where, x] of [
    ["content", width / 2],
    ["left margin", 16],
    ["right margin", width - 16],
  ] as const) {
    await page.evaluate(() => {
      window.scrollTo(0, 0);
      for (const el of Array.from(document.querySelectorAll("*")))
        el.scrollTop = 0;
    });
    expect(await scrolled(page)).toBe(0);
    await page.mouse.move(x, height / 2);
    await page.mouse.wheel(0, 400);
    await expect
      .poll(() => scrolled(page), {
        message: `${screen}: wheel over the ${where} at ${width}x${height}`,
      })
      .toBeGreaterThan(50);
  }
}

for (const viewport of VIEWPORTS)
  test(`the wheel scrolls the roadmap, lesson and profile at ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await connectedFixture(page);
    await page.goto("/");
    await expect(page.locator(".connected-host")).not.toHaveClass(/is-compact/);
    await page
      .getByRole("button", { name: /^(Start the course|Start lesson \d+|Continue lesson \d+|Continue learning) →$/ })
      .first()
      .click();
    await expect(
      page.getByRole("heading", { name: "Your learning path" }),
    ).toBeVisible();
    await expectWheelScrolls(page, "roadmap");

    await page
      .getByRole("button", { name: /^(Start the course|Start lesson \d+|Continue lesson \d+|Continue learning) →$/ })
      .first()
      .click();
    await expect(page.locator(".connected-lesson").first()).toBeVisible();
    await expectWheelScrolls(page, "lesson");

    await page.locator(".connected-menu-toggle").click();
    await page
      .locator(".connected-menu-panel")
      .getByRole("button", { name: "My profile", exact: true })
      .click();
    await expect(
      page.getByRole("heading", {
        name: "How should we address you?",
        exact: true,
      }),
    ).toBeVisible();
    await expectWheelScrolls(page, "profile");
  });

// The local demo scrolls a full-width React Native ScrollView instead of the
// page. Its lesson and profile fit these windows, so only its roadmap is checked
// here, lengthened to outgrow them.
for (const viewport of VIEWPORTS)
  test(`the wheel scrolls the demo roadmap at ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.goto("/demo");
    await expect(
      page.getByRole("heading", { name: "A little order." }),
    ).toBeVisible();
    // The roadmap folds its chapters, so the short demo course no longer outgrows the widest
    // windows: lengthen it, since what is checked is that the wheel reaches its scroll view.
    await page.getByTestId("course-roadmap").evaluate((roadmap) =>
      roadmap.append(Object.assign(document.createElement("div"), { style: "height:1600px;flex-shrink:0" })));
    await expectWheelScrolls(page, "demo roadmap", "");
  });
