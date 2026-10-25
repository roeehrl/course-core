import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { workspaceNav } from "../workspaceNav";

// AI services / Spending on the real API: the live companion re-test's held call (finding B-2:
// sent, no reply, $0.031410 held) is shown to the owner with what happened, and settled at $0
// through an explicit decision with a note, after which it is no longer held and the decision is
// listed. The fixture builds the row through the real bridge and ledger; no provider is contacted.
test("an owner sees a call whose cost stayed unknown and settles it at $0 with a note", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const fixture = await (
    await page.request.post("/test/uncertain-call-fixture")
  ).json();
  await page.goto("/admin/");
  await page.getByLabel("One-time sign-in code").fill(fixture.code);
  await page.getByRole("button", { name: "Use code", exact: true }).click();
  await (
    await workspaceNav(page)
  )
    .getByRole("button", { name: "AI services" })
    .click();
  const panel = page.getByRole("region", {
    name: "Calls with an unknown cost",
  });
  await expect(panel).toBeVisible();
  await expect(panel).toContainText(
    "One AI call was sent but never reported what it used",
  );
  await expect(panel).toContainText("($0.03141 in all)");
  const call = panel
    .getByRole("list", { name: "Calls to decide" })
    .getByRole("listitem");
  await expect(call).toHaveCount(1);
  await expect(call).toContainText(
    "Sent, but the AI service sent nothing back in time.",
  );
  await expect(call).toContainText("Counted now: $0.03141");
  await call
    .getByRole("button", { name: "Decide what counts", exact: true })
    .click();
  // A decision needs a choice and a note.
  await call
    .getByRole("button", { name: "Save decision", exact: true })
    .click();
  await expect(call).toContainText("Choose what counts for this call");
  await expect(call).toContainText("Say what you checked");
  await call
    .getByRole("radio", { name: /^\$0\.00: the usage page shows no charge/ })
    .check();
  await call
    .getByRole("textbox", { name: "What did you check?" })
    .fill("The usage page shows no request at that time.");
  // The panel itself, checked with the page at its top so the phone and tablet app bar (which
  // stays on top while scrolling) is not measured against the controls it happens to cover.
  await page.evaluate(() => window.scrollTo(0, 0));
  expect(
    (
      await new AxeBuilder({ page })
        .include(".ai-unknown")
        .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    ),
  ).toBeLessThanOrEqual(1);
  await call.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("uncertain-call-decide.png") });
  await call
    .getByRole("button", { name: "Save decision", exact: true })
    .click();
  await expect(panel.getByRole("status")).toContainText(
    "Counted as $0.00. $0.03141 went back to the limits.",
  );
  await expect(
    panel.getByRole("list", { name: "Calls to decide" }),
  ).toHaveCount(0);
  await panel.getByText("Decided recently").click();
  await expect(panel).toContainText(
    "counted as $0.00 instead of $0.03141 · Spending owner:",
  );
  await expect(panel).toContainText(
    "The usage page shows no request at that time.",
  );
  expect(errors).toEqual([]);
});
