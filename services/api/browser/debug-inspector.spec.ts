import { expect, test, type Page } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";

// The authorized debug inspector reachable from the learner app's activity (U01, I04): a side
// panel on desktop, a pane on tablet and a full-screen dialog on phone, for an owner who is also
// enrolled; never shown to a learner, whom the server refuses as well.

/** Opens the course from the course list, then its current lesson (each press retried until the page changed). */
async function openCurrentLesson(page: Page) {
  const resume = page.getByRole("button", { name: "Continue learning →", exact: true });
  const roadmap = page.getByRole("heading", { name: "Your learning path", exact: true });
  await expect(async () => {
    if (!(await roadmap.count())) await resume.click({ timeout: 2_000 });
    await expect(roadmap).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
  await expect(async () => {
    if (await resume.count()) await resume.click({ timeout: 2_000 });
    await expect(roadmap).toHaveCount(0, { timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
}
const placements = { desktop: "is-side", tablet: "is-pane", phone: "is-full" } as const;

test("an owner who is also enrolled opens the inspector beside the lesson, with the live visual state, and each open is recorded", async ({ page, request }, testInfo) => {
  const session = await (await request.post("/test/inspector-session", { data: { role: "owner" } })).json();
  const access = page.waitForResponse((r) => r.url().endsWith(`/api/enrollments/${session.enrollmentId}/debug-inspector`));
  await page.goto(`/#signin=${session.token}`);
  await openCurrentLesson(page);
  expect((await (await access).json()).available).toBe(true);
  const trigger = page.getByRole("button", { name: "Debug inspector", exact: true });
  await expect(trigger).toBeVisible();
  await trigger.click();
  const project = testInfo.project.name as keyof typeof placements;
  const panel = page.locator("#connected-debug-inspector");
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute("data-placement", placements[project]);
  await expect(panel).toHaveAttribute("role", project === "phone" ? "dialog" : "complementary");
  const box = (await panel.boundingBox())!, viewport = page.viewportSize()!;
  if (project === "desktop") {
    // Beside the lesson: the right side of the window, the lesson heading still in view.
    expect(box.x).toBeGreaterThan(viewport.width / 2);
    await expect(page.getByRole("heading", { level: 1 })).toBeInViewport();
  } else if (project === "tablet") {
    expect(box.y).toBeGreaterThan(viewport.height * 0.3);
    expect(Math.round(box.width)).toBe(viewport.width);
  } else expect([Math.round(box.width), Math.round(box.height)]).toEqual([viewport.width, viewport.height]);
  // The admin inspector, framed: the part the learner is on, with the learner app's own runtime.
  const frame = page.frameLocator('iframe[title="Debug inspector for this lesson"]');
  await expect(frame.getByRole("heading", { name: "Part 1: Illustration" })).toBeVisible({ timeout: 15_000 });
  await expect(frame.getByRole("region", { name: "Visual state" })).toBeVisible();
  await expect(frame.getByRole("table", { name: "Bindings: state the scene reads" })).toBeVisible();
  await expect(frame.getByText(/This open is recorded and the learner can see it/)).toBeVisible();
  // The same receipt as the staff learner view, visible in the learner's own list.
  const views = await page.request.get(`/api/enrollments/${session.enrollmentId}/staff-views`);
  expect((await views.json()).views).toEqual([expect.objectContaining({ viewerName: "Inspector owner", viewerRole: "owner" })]);
  const scan = await new AxeBuilder({ page }).include("#connected-debug-inspector").analyze();
  expect(scan.violations).toEqual([]);
  // Closing resumes the lesson where it was; opening again is a new, recorded open.
  await page.getByRole("button", { name: "Close the debug inspector" }).click();
  await expect(panel).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await trigger.click();
  await expect(frame.getByRole("heading", { name: "Part 1: Illustration" })).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => (await (await page.request.get(`/api/enrollments/${session.enrollmentId}/staff-views`)).json()).views.length).toBe(2);
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
});

test("a learner never sees the inspector entry, and the inspector page and its reads refuse them without a record", async ({ page, request }) => {
  const session = await (await request.post("/test/inspector-session", { data: { role: "learner" } })).json();
  const access = page.waitForResponse((r) => r.url().endsWith(`/api/enrollments/${session.enrollmentId}/debug-inspector`));
  await page.goto(`/#signin=${session.token}`);
  await openCurrentLesson(page);
  expect(await (await access).json()).toEqual({ available: false, permissions: [] });
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: "Debug inspector", exact: true })).toHaveCount(0);
  await expect(page.locator("#connected-debug-inspector, iframe[title='Debug inspector for this lesson']")).toHaveCount(0);
  // Typing the address is not a way in: the page asks the server, which refuses.
  await page.goto(`/admin/inspector?enrollment=${session.enrollmentId}&episode=min`);
  await expect(page.getByText(/needs owner or admin access to this enrollment/)).toBeVisible();
  expect((await page.request.get(`/api/admin/enrollments/${session.enrollmentId}/learner-view`)).status()).toBe(403);
  expect((await page.request.get(`/api/admin/enrollments/${session.otherEnrollmentId}/learner-view`)).status()).toBe(403);
  expect((await (await page.request.get(`/api/enrollments/${session.enrollmentId}/staff-views`)).json()).views).toEqual([]);
});
