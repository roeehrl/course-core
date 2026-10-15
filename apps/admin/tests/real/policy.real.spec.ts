import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

interface Fixture { code: string; catalogId: string; observerId: string; observerCode: string; enrollmentId: string; learnerCode: string }
async function signIn(page: Page, request: Page["request"]): Promise<Fixture> {
  const setup = await request.post("/test/admin-fixture");
  expect(setup.ok()).toBeTruthy();
  const fixture = (await setup.json()) as Fixture;
  await page.goto("/admin/");
  await page.getByLabel("One-time sign-in code").fill(fixture.code);
  await page.getByRole("button", { name: "Use code", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Course & releases", level: 1 })).toBeVisible();
  return fixture;
}
async function accessible(page: Page) {
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}
async function csrf(page: Page) {
  const value = (await page.context().cookies()).find((cookie) => cookie.name === "course_csrf")?.value;
  expect(value).toBeTruthy();
  return decodeURIComponent(value!);
}

test("course policy settings are previewed for feasibility before saving, at every viewport", async ({ page, request }, info) => {
  await signIn(page, request);
  await page.getByRole("button", { name: "Policy & extensions" }).click();
  const card = page.locator("section", { has: page.getByRole("heading", { name: "Course policy settings" }) });
  await expect(card.getByText("Documented defaults")).toBeVisible();
  await card.getByLabel("Deadline time zone (IANA)").fill("America/New_York");
  await card.getByLabel("Window daylight-saving resolution").selectOption("reject");
  await expect(card.getByLabel("Hard-deadline daylight-saving resolution")).toHaveValue("reject");
  await card.getByLabel("Extension approval").selectOption("learner_and_admin");
  await card.getByRole("button", { name: "Preview feasibility and daylight saving" }).click();
  await expect(card.getByText("The required core path and final assessment fit.")).toBeVisible();
  // The fixture's window is in UTC, which has no daylight-saving transitions to disclose.
  await expect(card.getByRole("table", { name: "Daylight-saving effects" })).toHaveCount(0);
  await card.getByLabel("Reason for this change").fill("Program review 2026-10");
  await card.getByRole("button", { name: "Save settings for new enrollments" }).click();
  await expect(card.getByText(/Policy settings saved\. They apply to new enrollments/)).toBeVisible();
  await expect(card.getByText("Revision 1")).toBeVisible();
  await accessible(page);
  await page.screenshot({ path: info.outputPath("policy-settings.png"), fullPage: true });
  // A declared pace that cannot fit the required path is disclosed before anything is saved.
  await card.getByLabel("Study minutes per day").fill("1");
  await card.getByLabel("Estimated minutes per required episode").fill("600");
  await card.getByRole("button", { name: "Preview feasibility and daylight saving" }).click();
  await expect(card.getByText("The required core path does not fit this envelope.", { exact: false })).toBeVisible();
  await expect(card.getByText(/Needs \d+ minutes; \d+ available\./).first()).toBeVisible();
  await accessible(page);
});

test("approve learner-accepted terms, then revoke, refund and make an exceptional grant", async ({ page, request, browser }, info) => {
  const fixture = await signIn(page, request);
  const headers = { "x-csrf-token": await csrf(page), origin: info.project.use.baseURL! };
  const current = (await (await page.request.get(`/api/admin/courses/${fixture.catalogId}/policy-settings`)).json()) as { revision: number; settings: Record<string, unknown> };
  const saved = await page.request.put(`/api/admin/courses/${fixture.catalogId}/policy-settings`, { headers, data: { expectedRevision: current.revision,
    settings: { ...current.settings, extensions: { approval: "learner_and_admin", offerCooldownHours: 0, maxOutstandingOffersPerScope: 2, maxOffersPerScope: 5 } }, reason: "Approval required" } });
  expect(saved.ok(), await saved.text()).toBeTruthy();
  const course = await (await page.request.get(`/api/admin/courses/${fixture.catalogId}`)).json();
  const enrolled = await page.request.post(`/api/admin/courses/${fixture.catalogId}/enrollments`, {
    headers: { ...headers, "if-match": String(course.revision), "idempotency-key": crypto.randomUUID() },
    data: { learnerRef: fixture.observerId, profile: { displayName: "Second learner", goal: "", pace: "steady" } } });
  expect(enrolled.ok(), await enrolled.text()).toBeTruthy();
  const body = (await enrolled.json()) as { workspace: { enrollments: { id: string; profile: { displayName: string } }[] } };
  const id = body.workspace.enrollments.find((e) => e.profile.displayName === "Second learner")!.id;
  const started = await (await page.request.get(`/api/admin/enrollments/${id}/policy`)).json();
  const proposed = await page.request.post(`/api/enrollments/${id}/extensions/propose`, { headers, data: {
    expectedRevision: started.revision, idempotencyKey: crypto.randomUUID(), scopeId: "course", days: 2, rationaleEventIds: [started.rationaleEvents[0].id],
    episodeIds: ["min"], planImpact: "Two more days for independent practice.", alternatives: ["Finish on the current date with a gap report."] } });
  expect(proposed.ok(), await proposed.text()).toBeTruthy();
  const offer = (await proposed.json()).offer;
  // The learner accepts the exact terms in their own session.
  const learner = await browser.newContext({ baseURL: info.project.use.baseURL });
  const redeemed = await learner.request.post("/auth/redeem", { headers: { origin: info.project.use.baseURL! }, data: { token: fixture.observerCode } });
  expect(redeemed.ok()).toBeTruthy();
  const learnerCsrf = (await redeemed.json()).csrfToken;
  const snapshot = await (await learner.request.get(`/api/enrollments/${id}`)).json();
  const accepted = await learner.request.post(`/api/enrollments/${id}/extensions/accept`, { headers: { "x-csrf-token": learnerCsrf, origin: info.project.use.baseURL! },
    data: { expectedRevision: snapshot.revision, idempotencyKey: crypto.randomUUID(), offerId: offer.terms.offerId, termsDigest: offer.termsDigest, explicitConsent: true } });
  expect(accepted.ok(), await accepted.text()).toBeTruthy();
  expect((await accepted.json()).offer.state).toBe("accepted_pending_admin");
  await learner.close();

  await page.reload();
  await page.getByRole("button", { name: "Policy & extensions" }).click();
  await page.getByLabel("Policy enrollment").selectOption(id);
  await expect(page.getByText("The learner accepted these exact terms. They also need an administrator’s approval.")).toBeVisible();
  await accessible(page);
  await page.getByRole("button", { name: "Approve learner-accepted terms" }).click();
  await expect(page.getByText(/Approved\. The learner's accepted terms were granted and the allowance was debited once\./)).toBeVisible();
  await page.screenshot({ path: info.outputPath("policy-approved.png"), fullPage: true });

  await page.getByRole("button", { name: "Revoke grant" }).click();
  const revoke = page.getByRole("dialog", { name: "Revoke grant" });
  await revoke.getByRole("button", { name: "Preview the effect" }).click();
  await expect(revoke.getByText("This shortens promised time for the learner.")).toBeVisible();
  await accessible(page);
  await revoke.getByLabel("Reason").fill("Granted in error, ticket 42");
  await revoke.getByRole("button", { name: "Apply: revoke grant" }).click();
  await expect(page.getByText(/Grant revoked\. Its usage and history remain in the ledger/)).toBeVisible();
  await expect(page.getByText(/Revoked .*; usage kept/)).toBeVisible();

  await page.getByRole("button", { name: "Refund allowance" }).click();
  const refund = page.getByRole("dialog", { name: "Refund allowance" });
  await refund.getByRole("button", { name: "Preview the effect" }).click();
  await expect(refund.getByText("Balance 0 → 2 (course:calendar)")).toBeVisible();
  await refund.getByLabel("Reason").fill("Outage credit");
  await refund.getByRole("button", { name: "Apply: refund allowance" }).click();
  await expect(page.getByText(/Allowance refunded to the pool/)).toBeVisible();
  await expect(page.getByText("2 units returned to course:calendar")).toBeVisible();

  await page.getByRole("button", { name: "Exceptional grant for this scope" }).click();
  const exception = page.getByRole("dialog", { name: "Exceptional grant" });
  await exception.getByRole("button", { name: "Preview the effect" }).click();
  await expect(exception.getByText("No allowance pool is debited.")).toBeVisible();
  await exception.getByLabel("Reason").fill("Committee decision 7");
  await exception.getByRole("button", { name: "Apply: exceptional grant" }).click();
  await expect(page.getByText(/Exceptional grant applied to this learner only/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Exceptional grants" })).toBeVisible();
  await accessible(page);
  await page.screenshot({ path: info.outputPath("policy-ledger.png"), fullPage: true });
});

test("a cohort-wide deadline change names the grant it shortens and applies only once acknowledged", async ({ page, request, browser }, info) => {
  const fixture = await signIn(page, request);
  const origin = info.project.use.baseURL!, headers = { "x-csrf-token": await csrf(page), origin };
  const started = await (await page.request.get(`/api/admin/enrollments/${fixture.enrollmentId}/policy`)).json();
  const proposed = await page.request.post(`/api/enrollments/${fixture.enrollmentId}/extensions/propose`, { headers, data: {
    expectedRevision: started.revision, idempotencyKey: crypto.randomUUID(), scopeId: "course", days: 2, rationaleEventIds: [started.rationaleEvents[0].id],
    episodeIds: ["min"], planImpact: "Two more days for independent practice.", alternatives: ["Finish on the current date with a gap report."] } });
  expect(proposed.ok(), await proposed.text()).toBeTruthy();
  const offer = (await proposed.json()).offer;
  const learner = await browser.newContext({ baseURL: origin });
  const redeemed = await learner.request.post("/auth/redeem", { headers: { origin }, data: { token: fixture.learnerCode } });
  const snapshot = await (await learner.request.get(`/api/enrollments/${fixture.enrollmentId}`)).json();
  const granted = await learner.request.post(`/api/enrollments/${fixture.enrollmentId}/extensions/accept`, { headers: { origin, "x-csrf-token": (await redeemed.json()).csrfToken },
    data: { expectedRevision: snapshot.revision, idempotencyKey: crypto.randomUUID(), offerId: offer.terms.offerId, termsDigest: offer.termsDigest, explicitConsent: true } });
  expect(granted.ok(), await granted.text()).toBeTruthy();
  await learner.close();

  await page.reload();
  await page.getByRole("button", { name: "Policy & extensions" }).click();
  await page.getByRole("button", { name: "Change a deadline for all learners" }).click();
  const dialog = page.getByRole("dialog", { name: "Change a deadline for all learners" });
  const earlier = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 16);
  await dialog.getByLabel("New absolute deadline (UTC)").fill(earlier);
  await dialog.getByRole("button", { name: "Preview every enrollment" }).click();
  await expect(dialog.getByText("Impact on 1 active enrollment")).toBeVisible();
  await dialog.getByLabel("Reason for this change").fill("Program ends early");
  const apply = dialog.getByRole("button", { name: "Apply to all previewed learners" });
  await expect(apply).toBeDisabled();
  await accessible(page);
  await dialog.getByRole("checkbox", { name: /Public learner's extension ends/ }).check();
  await apply.click();
  await expect(page.getByText(/Reviewed policy change applied to 1 enrollment\./)).toBeVisible();
  const after = await (await page.request.get(`/api/admin/enrollments/${fixture.enrollmentId}/policy`)).json();
  expect(after.scopes[0].hardDeadline.at.slice(0, 16)).toBe(earlier);
  expect(after.grants).toHaveLength(1);
  await accessible(page);
});
