import { test, expect } from "@playwright/test";
import { ADMIN_APP_VERSION } from "../../src/client/eventEnvelope";

test("a staff decision made in the admin app records the client facts on its event, through the real API", async ({
  page,
}) => {
  const fixture = await (
    await page.request.post("/test/gate-review-fixture")
  ).json();
  await page.goto("/admin/");
  await page.getByLabel("One-time sign-in code").fill(fixture.reviewerCode);
  await page.getByRole("button", { name: "Use code", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Workspace navigation" })
    .getByRole("button", { name: "Answer reviews" })
    .click();
  const card = page
    .locator("section.card")
    .filter({ hasText: "Avery Learner · min-gate" });
  await card
    .getByLabel("Message to the learner")
    .fill("The transfer task is still required; try the prediction item next.");
  const sent = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      request.url().includes("/api/admin/gate-reviews/"),
  );
  const started = Date.now();
  await card.getByRole("button", { name: "Uphold decision" }).click();
  const headers = (await sent).headers();
  expect(headers).toMatchObject({
    "x-course-platform": "web",
    "x-course-app-version": ADMIN_APP_VERSION,
  });
  expect(headers["x-course-client-sequence"]).toMatch(/^[1-9][0-9]*$/);
  await expect(
    page.getByText("Decision upheld for Avery Learner on min-gate."),
  ).toBeVisible();
  // The API kept them on the staff event (GET reads sent none and recorded nothing).
  const event = await (
    await page.request.get("/test/event-envelope?type=gate.review_decided")
  ).json();
  expect(event).toMatchObject({
    actorKind: "staff",
    platform: "web",
    appVersion: ADMIN_APP_VERSION,
    clientSequence: Number(headers["x-course-client-sequence"]),
  });
  expect(Math.abs(Date.parse(event.occurredAt) - started)).toBeLessThan(60_000);
});
