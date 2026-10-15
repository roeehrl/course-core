import { test, expect } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";

// A workspace with no runtime models configured shows one capability slot per agent
// role to read-only staff, including the reviewer role that drafts written-answer
// reviews. Runs on the desktop, phone and tablet projects.
const roles = ["supervisor", "companion", "research", "media", "reviewer"];

test("read-only staff see every agent role's capability slot without a configured runtime", async ({ page }, info) => {
  const setup = await page.request.post("/test/admin-fixture");
  expect(setup.ok()).toBeTruthy();
  const { observerCode, catalogId } = await setup.json();
  await page.context().clearCookies();
  await page.goto("/admin/");
  await page.getByLabel("One-time sign-in code").fill(observerCode);
  await page.getByRole("button", { name: "Use code", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Course & releases", level: 1 })).toBeVisible();

  // The course read model lists exactly the five roles, each with its runtime status.
  const course = await (await page.request.get(`/api/admin/courses/${catalogId}`)).json();
  expect(course.permissions).toEqual(["course.read"]);
  expect(course.providers.map((p: { id: string }) => p.id).sort()).toEqual([...roles].sort());
  for (const provider of course.providers)
    expect(provider.detail).toBe("Runtime status: configuration_missing. No live verification is claimed.");

  await page.getByRole("button", { name: "Providers", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Capabilities, with clear boundaries." })).toBeVisible();
  // Without provider.configure the secure setup panel is not offered.
  await expect(page.getByText("supervisor configuration", { exact: true })).toHaveCount(0);
  for (const role of roles) {
    const slot = page.locator("section.card").filter({ has: page.getByRole("heading", { name: `${role} provider`, exact: true }) });
    await expect(slot).toHaveCount(1);
    await slot.scrollIntoViewIfNeeded();
    await expect(slot.getByText(role, { exact: true })).toBeVisible();
    await expect(slot.getByText("Runtime status: configuration_missing. No live verification is claimed.")).toBeVisible();
    await expect(slot.getByRole("button", { name: "Request configuration" })).toBeDisabled();
  }
  await expect(page.getByText("Not verified", { exact: true })).toHaveCount(roles.length);
  // No horizontal overflow at any viewport.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  // The server, not the disabled button, refuses a request from read-only staff.
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === "course_csrf")?.value;
  expect(csrf).toBeTruthy();
  const refused = await page.request.post(`/api/admin/courses/${catalogId}/providers/reviewer/configuration-requests`, {
    headers: { "x-csrf-token": decodeURIComponent(csrf!), "if-match": course.revision, "idempotency-key": crypto.randomUUID() },
    data: { connectionLabel: "Reviewer drafts", environment: "staging" },
  });
  expect(refused.status()).toBe(403);
  expect(
    (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations,
  ).toEqual([]);
  await page.screenshot({ path: info.outputPath("provider-slots.png"), fullPage: true });
});
