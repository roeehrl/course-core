import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/** Organization limits, allowance pools, the cross-learner approval queue and group outage
 * adjustments against the real API and PostgreSQL (G02, G03, G05, G09, Q05). */
interface Fixture {
  code: string;
  catalogId: string;
  observerId: string;
  observerCode: string;
  enrollmentId: string;
  learnerCode: string;
}
async function signIn(page: Page, request: Page["request"]): Promise<Fixture> {
  const setup = await request.post("/test/admin-fixture");
  expect(setup.ok()).toBeTruthy();
  const fixture = (await setup.json()) as Fixture;
  await page.goto("/admin/");
  await page.getByLabel("One-time sign-in code").fill(fixture.code);
  await page.getByRole("button", { name: "Use code", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Course & releases", level: 1 }),
  ).toBeVisible();
  return fixture;
}
async function accessible(page: Page) {
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
}
async function csrf(page: Page) {
  const value = (await page.context().cookies()).find(
    (cookie) => cookie.name === "course_csrf",
  )?.value;
  expect(value).toBeTruthy();
  return decodeURIComponent(value!);
}

test("organization limits are checked against every course before saving", async ({
  page,
  request,
}, info) => {
  await signIn(page, request);
  await page.getByRole("button", { name: "Policy & extensions" }).click();
  const card = page.locator("section", {
    has: page.getByRole("heading", { name: "Organization limits" }),
  });
  await expect(card.getByText("No organization limits set")).toBeVisible();
  await card.getByLabel("Longest enrollment (calendar days)").fill("10");
  await card
    .getByRole("button", { name: "Check the effect on every course" })
    .click();
  // The fixture course runs 30 days, so the organization's 10 days will apply.
  await expect(
    card.getByText(
      "This course's own end date is later, so the organization's limit will apply to its learners.",
    ),
  ).toBeVisible();
  await card.getByLabel("Reason for this change").fill("Organization terms");
  await card.getByRole("button", { name: "Save organization limits" }).click();
  await expect(
    card.getByText(/New enrollments in every course start with these limits/),
  ).toBeVisible();
  await expect(card.getByText("Saved limits · revision 1")).toBeVisible();
  await accessible(page);
  await page.screenshot({
    path: info.outputPath("organization-limits.png"),
    fullPage: true,
  });
});

test("an allowance that can never be used is flagged in the settings preview", async ({
  page,
  request,
}) => {
  await signIn(page, request);
  await page.getByRole("button", { name: "Policy & extensions" }).click();
  const card = page.locator("section", {
    has: page.getByRole("heading", { name: "Course policy settings" }),
  });
  await card.getByRole("button", { name: "Add an allowance" }).click();
  await expect(card.getByText("Allowance “allowance-1”")).toBeVisible();
  await card
    .getByRole("button", { name: "Preview feasibility and daylight saving" })
    .click();
  // The fixture's chapters have no deadline of their own: a day allowance there cannot be used.
  await expect(
    card.getByText(/can never be used in \d+ of its \d+ places/),
  ).toBeVisible();
  await card.getByLabel("What it adds").selectOption("planned_minute");
  await card.getByLabel("Where it can be used").selectOption("course");
  await card
    .getByRole("button", { name: "Preview feasibility and daylight saving" })
    .click();
  await expect(card.getByText(/can never be used/)).toHaveCount(1);
  await accessible(page);
});

test("an accepted offer is approved from the cross-learner queue, then a group outage moves every deadline", async ({
  page,
  request,
  browser,
}, info) => {
  const fixture = await signIn(page, request);
  const origin = info.project.use.baseURL!,
    headers = { "x-csrf-token": await csrf(page), origin };
  const current = (await (
    await page.request.get(
      `/api/admin/courses/${fixture.catalogId}/policy-settings`,
    )
  ).json()) as { revision: number; settings: Record<string, unknown> };
  const saved = await page.request.put(
    `/api/admin/courses/${fixture.catalogId}/policy-settings`,
    {
      headers,
      data: {
        expectedRevision: current.revision,
        settings: {
          ...current.settings,
          extensions: {
            approval: "learner_and_admin",
            offerCooldownHours: 0,
            maxOutstandingOffersPerScope: 2,
            maxOffersPerScope: 5,
            ultimateDeadline: null,
          },
        },
        reason: "Approval required",
      },
    },
  );
  expect(saved.ok(), await saved.text()).toBeTruthy();
  const course = await (
    await page.request.get(`/api/admin/courses/${fixture.catalogId}`)
  ).json();
  const enrolled = await page.request.post(
    `/api/admin/courses/${fixture.catalogId}/enrollments`,
    {
      headers: {
        ...headers,
        "if-match": String(course.revision),
        "idempotency-key": crypto.randomUUID(),
      },
      data: {
        learnerRef: fixture.observerId,
        profile: { displayName: "Queue learner", goal: "", pace: "steady" },
      },
    },
  );
  expect(enrolled.ok(), await enrolled.text()).toBeTruthy();
  const id = (
    (await enrolled.json()) as {
      workspace: {
        enrollments: { id: string; profile: { displayName: string } }[];
      };
    }
  ).workspace.enrollments.find(
    (e) => e.profile.displayName === "Queue learner",
  )!.id;
  const started = await (
    await page.request.get(`/api/admin/enrollments/${id}/policy`)
  ).json();
  const proposed = await page.request.post(
    `/api/enrollments/${id}/extensions/propose`,
    {
      headers,
      data: {
        expectedRevision: started.revision,
        idempotencyKey: crypto.randomUUID(),
        scopeId: "course",
        days: 2,
        rationaleEventIds: [started.rationaleEvents[0].id],
        episodeIds: ["min"],
        planImpact: "Two more days for independent practice.",
        alternatives: ["Finish on the current date with a gap report."],
      },
    },
  );
  expect(proposed.ok(), await proposed.text()).toBeTruthy();
  const offer = (await proposed.json()).offer;
  const learner = await browser.newContext({ baseURL: origin });
  const redeemed = await learner.request.post("/auth/redeem", {
    headers: { origin },
    data: { token: fixture.observerCode },
  });
  expect(redeemed.ok()).toBeTruthy();
  const snapshot = await (
    await learner.request.get(`/api/enrollments/${id}`)
  ).json();
  const accepted = await learner.request.post(
    `/api/enrollments/${id}/extensions/accept`,
    {
      headers: { origin, "x-csrf-token": (await redeemed.json()).csrfToken },
      data: {
        expectedRevision: snapshot.revision,
        idempotencyKey: crypto.randomUUID(),
        offerId: offer.terms.offerId,
        termsDigest: offer.termsDigest,
        explicitConsent: true,
      },
    },
  );
  expect(accepted.ok(), await accepted.text()).toBeTruthy();
  await learner.close();

  await page.reload();
  await page
    .getByRole("button", { name: "Extensions & accommodations" })
    .click();
  const queue = page.locator("section", {
    has: page.getByRole("heading", { name: "Waiting for your approval" }),
  });
  await expect(queue.getByText("Queue learner")).toBeVisible();
  await expect(queue.getByText(/2 extra days for/)).toBeVisible();
  await accessible(page);
  await queue.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByText(/Approved for Queue learner/)).toBeVisible();
  await expect(queue.getByText("Nothing is waiting")).toBeVisible();
  await page.getByRole("button", { name: "Everything" }).click();
  await expect(page.getByText("Granted").first()).toBeVisible();

  const before = (await (
    await page.request.get(`/api/admin/enrollments/${id}/policy`)
  ).json()) as {
    constraints: { scopeId: string; effectiveDeadline: string }[];
  };
  await page
    .getByRole("button", { name: "Adjust for several learners" })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Adjust for several learners",
  });
  await dialog.getByLabel("Extra calendar days").fill("1");
  await dialog
    .getByRole("button", { name: "Show the effect on each learner" })
    .click();
  await expect(
    dialog.getByText(/learners? would change/).first(),
  ).toBeVisible();
  await accessible(page);
  await dialog
    .getByLabel("Reference for this decision")
    .fill("Incident 42: service unavailable");
  await dialog
    .getByRole("button", { name: /^Apply to \d+ learners?$/ })
    .click();
  await expect(
    page.getByText(/Adjustment applied to \d+ learners?\./),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Recent group adjustments" }),
  ).toBeVisible();
  const after = (await (
    await page.request.get(`/api/admin/enrollments/${id}/policy`)
  ).json()) as {
    constraints: { scopeId: string; effectiveDeadline: string }[];
  };
  const end = (p: typeof before) =>
    Date.parse(
      p.constraints.find((c) => c.scopeId === "course")!.effectiveDeadline,
    );
  expect(end(after) - end(before)).toBe(86_400_000);
  await accessible(page);
  await page.screenshot({
    path: info.outputPath("allowances.png"),
    fullPage: true,
  });
});
