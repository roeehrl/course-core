// Real API, PostgreSQL and learner export: an SDK 0.5 declarative activity judged by a registered
// evaluator, and a sandboxed web activity whose frame has no same-origin access, no network and
// only the capabilities it was granted. Desktop, phone and tablet.
import { expect, test, type Page } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";

async function noHorizontalScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
}

test("activities: declarative controls judged by an evaluator, and a sandboxed frame that is denied everything undeclared", async ({ page, request }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const fixture = await (await request.post("/test/activity-session")).json();
  await page.goto(`/#signin=${fixture.token}`);
  await page.getByRole("button", { name: "Open course", exact: true }).click();
  await page.getByRole("button", { name: "Start course", exact: true }).click();
  await page.getByRole("region", { name: "Already know some of this?" }).getByRole("button", { name: "Start from the beginning" }).click();
  await expect(page.locator("section.connected-placement")).toHaveCount(0);
  await page.getByRole("button", { name: "Continue learning →", exact: true }).first().click();

  // Declarative: Core's own controls; the server re-checks values and only the evaluator decides.
  const declarative = page.getByRole("region", { name: "Explore the minimum" });
  await expect(declarative.getByText("Set the field to the smaller of 4 and 9, then submit.")).toBeVisible();
  await expect(declarative.getByText("Not done yet")).toBeVisible();
  const value = declarative.getByRole("textbox", { name: "Smaller value (0 to 10)" });
  await value.fill("9");
  await declarative.getByRole("checkbox", { name: "I checked both values" }).check();
  await declarative.getByRole("button", { name: "Submit my value" }).click();
  await expect(declarative.getByText(/^Checked: not yet\. Compare both values again\./)).toBeVisible();
  await expect(declarative.getByText("Not done yet")).toBeVisible();
  await value.fill("4");
  await declarative.getByRole("button", { name: "Submit my value" }).click();
  await expect(declarative.getByText("Checked: done. 4 is the smaller value.")).toBeVisible();
  await expect(declarative.getByText("Done", { exact: true })).toBeVisible();
  await noHorizontalScroll(page);

  // Sandboxed: the frame is scripts-only and talks to the app only through its port.
  const sandboxed = page.getByRole("region", { name: "Sandbox probe" });
  const element = sandboxed.locator("iframe");
  await expect(element).toHaveAttribute("sandbox", "allow-scripts");
  const frame = page.frameLocator('iframe[title="Sandbox probe (interactive activity)"]');
  await expect(frame.getByRole("status")).toHaveText("Ready");
  await frame.getByRole("button", { name: "Report the sandbox" }).click();
  await expect(frame.getByRole("status")).toHaveText("Reported: not_evaluated");
  await expect(sandboxed.getByText("Done", { exact: true })).toBeVisible();
  await noHorizontalScroll(page);

  // What the frame could do, as it reported through the broker (the learner's own export).
  const enrollmentId = await page.evaluate(async () => (await (await fetch("/api/enrollments", { credentials: "same-origin" })).json())[0].id as string);
  const exported = await page.evaluate(async (id) => (await fetch(`/api/enrollments/${id}/export`, { credentials: "same-origin" })).json(), enrollmentId);
  const probe = exported.activities.observations.items.find((o: { observation: { kind: string } }) => o.observation.kind === "probe").observation;
  expect(probe.probes).toMatchObject({ cookieReadable: false, parentDom: false, storage: false, origin: "null" });
  expect(probe.results).toMatchObject({ granted: ["state.read", "observation.emit"], fetch: "blocked",
    "network.fetch": "CAPABILITY_DENIED", "evidence.write": "CAPABILITY_DENIED", "learner.profile.read": "CAPABILITY_DENIED" });
  // Nothing an activity reported became assessment evidence.
  expect(exported.evidence.items).toHaveLength(0);
  expect(exported.activities.evidence.items.map((e: { result: { passed: boolean } }) => e.result.passed)).toEqual([false, true]);

  const axe = await new AxeBuilder({ page }).include(".connected-activities").analyze();
  expect(axe.violations).toEqual([]);
  expect(errors).toEqual([]);
});
