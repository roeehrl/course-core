import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { connectedSnapshot } from "../connectedFixtures";
import { authorPolicy, policyFixture } from "../policyFixtures";
async function policyHost(page: Page, approval = false, closed = false) {
  const snapshot = connectedSnapshot();
  snapshot.course.policy = authorPolicy;
  const policy = policyFixture();
  if (approval) policy.offers[0]!.terms.requiredApprovals = ["reviewer"];
  if (closed) {
    snapshot.complete = true;
    snapshot.closureReport = {
      closedAt: "2026-10-12T00:00:00Z",
      reason: "cap",
      coverage: "partial",
      mastery: "gaps",
      uncoveredObjectiveIds: ["observe"],
      unprovenConceptIds: ["observe"],
      requiredExpansion: "stopped",
      continuation: "explicit_opt_in_separate_track",
    };
    policy.offers = [];
  }
  let enrolled = closed,
    enrollmentWrites = 0;
  const decisions: { path: string; body: Record<string, unknown> }[] = [];
  await page.route("**/auth/session", (route) =>
    route.fulfill({
      json: { user: { id: "policy-learner", displayName: "Learner" } },
    }),
  );
  await page.route("**/api/**", async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname;
    if (path === "/api/workspaces")
      return route.fulfill({ json: [{ id: "workspace" }] });
    if (path === "/api/workspaces/workspace/courses")
      return route.fulfill({
        json: [
          {
            id: "release-one",
            title: snapshot.course.title,
            version: "1.0.0",
            status: "published",
            summary: "Observe patterns in small steps.",
            policy: authorPolicy,
          },
        ],
      });
    if (path === "/api/enrollments") {
      if (req.method() === "POST") {
        enrollmentWrites++;
        enrolled = true;
        return route.fulfill({ json: { id: snapshot.enrollmentId } });
      }
      return route.fulfill({
        json: enrolled
          ? [
              {
                id: snapshot.enrollmentId,
                releaseId: "release-one",
                title: snapshot.course.title,
                version: "1.0.0",
                status: "active",
              },
            ]
          : [],
      });
    }
    if (path.endsWith("/companion"))
      return route.fulfill({ json: { messages: [] } });
    if (path.endsWith("/policy")) return route.fulfill({ json: policy });
    if (
      path.endsWith("/extensions/accept") ||
      path.endsWith("/extensions/decline")
    ) {
      decisions.push({ path, body: req.postDataJSON() });
      snapshot.revision++;
      policy.revision = snapshot.revision;
      if (path.endsWith("/decline")) policy.offers[0]!.state = "declined";
      else if (approval) policy.offers[0]!.state = "accepted_pending_admin";
      else {
        policy.offers[0]!.state = "granted";
        policy.policyRevision++;
        policy.constraints[0]!.effectiveDeadline =
          policy.offers[0]!.terms.proposedEffectiveDeadline;
        policy.balances = policy.offers[0]!.terms.balanceAfter;
        policy.grants = [
          {
            grantId: "grant",
            offerId: policy.offers[0]!.terms.offerId,
            grantedAt: "2026-10-12T00:00:00Z",
            adjustment: { scopeId: "course" },
          },
        ];
      }
      return route.fulfill({
        json: {
          revision: snapshot.revision,
          offer: policy.offers[0],
          balances: policy.balances,
        },
      });
    }
    if (path === `/api/enrollments/${snapshot.enrollmentId}`)
      return route.fulfill({ json: snapshot });
    return route.fulfill({ status: 404, json: { error: "NOT_FOUND" } });
  });
  await page.goto("/");
  return { writes: () => enrollmentWrites, decisions };
}
test("opening the policy preview starts no clock; explicit Start enrolls once and existing resume never enrolls again", async ({
  page,
}, info) => {
  const state = await policyHost(page);
  await page.getByRole("button", { name: "Open course", exact: true }).click();
  await expect(
    page.getByText("90 calendar days from starting this course."),
  ).toBeVisible();
  await expect(page.getByText(/Times shown in Asia\/Jerusalem/)).toBeVisible();
  await expect(
    page.getByText(/7 calendar days total, across up to 2 extensions/),
  ).toBeVisible();
  expect(state.writes()).toBe(0);
  await page.getByRole("button", { name: "← Back to courses" }).click();
  expect(state.writes()).toBe(0);
  await page.getByRole("button", { name: "Open course", exact: true }).click();
  await page.screenshot({
    path: info.outputPath("before-start.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Start course", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Continue learning →", exact: true }),
  ).toBeVisible();
  expect(state.writes()).toBe(1);
  await expect(page.locator(".connected-policy-dates")).toContainText(
    "Mar 1, 2030",
  );
  const before = await page.locator(".connected-policy-dates").textContent();
  await page
    .getByRole("button", { name: "← All courses", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Resume course", exact: true })
    .click();
  await expect(page.locator(".connected-policy-dates")).toHaveText(before!);
  expect(state.writes()).toBe(1);
  await page
    .getByRole("button", { name: "Continue learning →", exact: true })
    .click();
  await expect(page.locator(".connected-policy-dates")).toContainText("Begin:");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
test("extension terms need explicit consent and pending approval never changes displayed due dates", async ({
  page,
}, info) => {
  const state = await policyHost(page, true);
  await page.getByRole("button", { name: "Open course", exact: true }).click();
  await page.getByRole("button", { name: "Start course", exact: true }).click();
  await expect(page.locator(".connected-policy-dates")).toContainText(
    "Mar 1, 2030",
  );
  const before = await page.locator(".connected-policy-dates").textContent();
  await page
    .getByText("Study dates & optional extensions", { exact: true })
    .click();
  const offer = page.getByRole("article", {
    name: "Extension offer for Course",
  });
  await expect(
    offer.getByRole("button", { name: "Accept this extension" }),
  ).toBeDisabled();
  await expect(
    offer.getByRole("region", { name: "Before extension" }),
  ).toContainText("7 calendar days");
  await expect(
    offer.getByRole("region", { name: "After extension" }),
  ).toContainText("4 calendar days");
  expect(state.decisions).toHaveLength(0);
  await offer.getByRole("checkbox").check();
  await offer.getByRole("button", { name: "Accept this extension" }).click();
  await expect(
    page.getByText("Accepted · waiting for approval", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".connected-policy-dates")).toHaveText(before!);
  expect(state.decisions[0]!.body).toMatchObject({
    offerId: "11111111-1111-4111-8111-111111111111",
    termsDigest: "a".repeat(64),
    explicitConsent: true,
    expectedRevision: 1,
  });
  expect(state.decisions).toHaveLength(1);
  const scan = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(scan.violations).toEqual([]);
  await page.screenshot({
    path: info.outputPath("extension-offer.png"),
    fullPage: true,
  });
});
test("closure distinguishes coverage and unproven understanding from professional certification", async ({
  page,
}) => {
  await policyHost(page, false, true);
  await page
    .getByRole("button", { name: "Continue learning →", exact: true })
    .first()
    .click();
  await expect(
    page.getByText("Learning window closed", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Material coverage: Some required material remains.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText(/Further independent checks are needed/),
  ).toBeVisible();
  await expect(
    page.getByText(/not professional certification or qualification/),
  ).toBeVisible();
});
