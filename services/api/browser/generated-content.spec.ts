import { expect, test, type Page } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import { openProfile } from "./learner-menu.js";

/** Supervisor-generated simulations in the learner's lesson (E01, E03, E06), on desktop, tablet
 * and phone. The supervisor's output is scripted (browser/start.ts); the pipeline is real. */

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
async function accessible(page: Page) {
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
}
/** A learner command through the page's own signed-in session. */
async function command(page: Page, path: string, body: Record<string, unknown>) {
  const id = (await (await page.request.get("/api/enrollments")).json())[0].id as string;
  const snapshot = await (await page.request.get(`/api/enrollments/${id}`)).json();
  const csrf = (await page.context().cookies()).find((c) => c.name === "course_csrf")!.value;
  return page.request.post(`/api/enrollments/${id}/${path}`, {
    headers: { origin: new URL(page.url()).origin, "x-csrf-token": csrf },
    data: { expectedRevision: snapshot.revision, idempotencyKey: `${path.replaceAll("/", "-")}-${Date.now()}`, ...body },
  });
}

test("a generated simulation joins the lesson labelled as unverified and the learner can undo it", async ({ page, request }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const session = await request.post("/test/model-session", { data: { content: true } });
  expect(session.ok()).toBe(true);
  await page.goto(`/#signin=${(await session.json()).token}`);
  await openCurrentLesson(page);
  for (const part of [1, 2]) {
    await expect(page.getByRole("article", { name: `Reading part ${part}` })).toBeVisible();
    await page.getByRole("button", { name: "Mark this part read", exact: true }).click();
  }
  const generated = page.getByRole("article", { name: "Reading part 3" });
  await expect(generated).toBeVisible();
  // The supervisor's scene, drawn by the installed renderer, with its text alternative and label.
  await expect(generated.getByText("A straight line", { exact: false }).first()).toBeVisible();
  const badge = generated.locator("summary", { hasText: "Unverified" });
  await expect(badge).toHaveAttribute("aria-label", "Unverified: this part was written by AI and has not been reviewed by a person");
  await badge.click();
  await expect(generated.getByText(/written by AI for you and checked automatically/)).toBeVisible();
  await accessible(page);
  await page.screenshot({ path: info.outputPath("generated-simulation.png"), fullPage: true });
  await openProfile(page);
  const changes = page.getByRole("region", { name: "Your personal changes" });
  await expect(changes.getByText("Added an interactive simulation", { exact: false })).toBeVisible();
  // What was checked before it was added, in plain words.
  await expect(changes.getByText(/Checked automatically before it was added: .*picture, formula and table agree/)).toBeVisible();
  await changes.getByRole("button", { name: /^Undo: / }).click();
  await changes.getByRole("button", { name: "Yes, undo", exact: true }).click();
  await expect(changes.getByText("Undone", { exact: false })).toBeVisible();
  expect(errors).toEqual([]);
});

test("a simulation made while the learner answers waits for them, then is added at the end of the lesson", async ({ page, request }, info) => {
  const session = await request.post("/test/model-session", { data: { content: true, midAttempt: true } });
  expect(session.ok()).toBe(true);
  await page.goto(`/#signin=${(await session.json()).token}`);
  await openCurrentLesson(page);
  const notice = page.getByRole("region", { name: "New material is ready for this lesson" });
  await expect(notice).toBeVisible();
  await expect(notice.getByText(/waits until you finish the question you are working on/)).toBeVisible();
  await expect(notice.getByRole("button", { name: "Add it to this lesson" })).toBeDisabled();
  await expect(page.getByRole("article", { name: "Reading part 3" })).toHaveCount(0);
  await accessible(page);
  await page.screenshot({ path: info.outputPath("pending-simulation.png"), fullPage: true });
  // The learner finishes the open question; the addition can now be added.
  const id = (await (await page.request.get("/api/enrollments")).json())[0].id as string;
  const challengeId = (await (await page.request.get(`/api/enrollments/${id}`)).json()).activeChallenges[0].challengeId;
  expect((await command(page, "answers", { challengeId, answer: "two" })).ok()).toBe(true);
  await page.reload();
  await openCurrentLesson(page);
  const ready = page.getByRole("region", { name: "New material is ready for this lesson" });
  await expect(ready.getByText("You can add it now.", { exact: false })).toBeVisible();
  await ready.getByRole("button", { name: "Add it to this lesson" }).click();
  await expect(page.getByText("Added to the end of this lesson.", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "New material is ready for this lesson" })).toHaveCount(0);
  for (const part of [1, 2]) {
    await expect(page.getByRole("article", { name: `Reading part ${part}` })).toBeVisible();
    await page.getByRole("button", { name: "Mark this part read", exact: true }).click();
  }
  await expect(page.getByRole("article", { name: "Reading part 3" }).locator("summary", { hasText: "Unverified" })).toBeVisible();
  await accessible(page);
});

test("a generated component runs in the sandboxed runner beside its text alternative", async ({ page, request }, info) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const session = await request.post("/test/model-session", { data: { content: true, component: true } });
  expect(session.ok()).toBe(true);
  await page.goto(`/#signin=${(await session.json()).token}`);
  await openCurrentLesson(page);
  for (const part of [1, 2]) {
    await expect(page.getByRole("article", { name: `Reading part ${part}` })).toBeVisible();
    await page.getByRole("button", { name: "Mark this part read", exact: true }).click();
  }
  const part = page.getByRole("article", { name: "Reading part 3" });
  // The text alternative the host wrote, then the component itself.
  await expect(part.getByText("Slope: -5 – 5 (2)", { exact: false })).toBeVisible();
  const panel = part.getByRole("region", { name: "Line explorer" });
  await expect(panel.getByText("Run the model to see this.")).toBeVisible();
  await panel.getByLabel("Slope").fill("5");
  await panel.getByRole("button", { name: "Run the model" }).click();
  // 5 × 3 + 1, computed by Python in the sandboxed runner frame, never in this page.
  await expect(panel.getByText("16", { exact: true })).toBeVisible({ timeout: 90_000 });
  await expect(panel.getByText("Results updated.")).toBeVisible();
  const frames = page.locator("iframe[sandbox]");
  expect(await frames.count()).toBeGreaterThan(0);
  for (const sandbox of await frames.evaluateAll((all) => all.map((frame) => frame.getAttribute("sandbox")))) expect(sandbox).toBe("allow-scripts");
  await accessible(page);
  await page.screenshot({ path: info.outputPath("generated-component.png"), fullPage: true });
  expect(errors).toEqual([]);
});
