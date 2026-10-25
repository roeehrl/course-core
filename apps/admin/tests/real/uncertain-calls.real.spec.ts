import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
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
    /The Learner tutor call of .+ \(ref\. [0-9a-f]{8}\) now counts as \$0\.00\. \$0\.03141 went back to the limits\./,
  );
  await expect(
    panel.getByRole("list", { name: "Calls to decide" }),
  ).toHaveCount(0);
  await panel.getByText("Decided recently").click();
  await expect(panel).toContainText(
    "Counted as $0.00 instead of $0.03141 · decided by Spending owner,",
  );
  await expect(panel).toContainText(
    "The usage page shows no request at that time.",
  );
  expect(errors).toEqual([]);
});

async function shot(page: Page, name: string) {
  await page.screenshot({ path: test.info().outputPath(`${name}.png`) });
  const dir = process.env.SHOTS_DIR;
  if (dir) {
    mkdirSync(dir, { recursive: true });
    await page.screenshot({
      path: join(dir, `admin-${test.info().project.name}-${name}.png`),
    });
  }
}

// Two calls sent in the same minute (a question and its automatic retry, say) are told apart by
// the second they were sent and a short reference; the message after a decision names the call;
// and in Hebrew, dates and an English note keep their own order (the date used to read
// "UTC באוק׳ 2026, 07:45 · 25", and the note's quotation marks landed mid-sentence).
for (const locale of ["en", "he"] as const)
  test(`${locale}: calls sent in the same minute are told apart, a decision names its call, and mixed-direction text keeps its order @webkit`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const he = locale === "he";
    const fixture = await (
      await page.request.post("/test/uncertain-call-fixture", {
        data: { calls: 2 },
      })
    ).json();
    await page.goto(`/admin/?locale=${locale}`);
    await page
      .getByLabel(he ? "קוד כניסה חד-פעמי" : "One-time sign-in code")
      .fill(fixture.code);
    await page
      .getByRole("button", {
        name: he ? "שימוש בקוד" : "Use code",
        exact: true,
      })
      .click();
    await (
      await workspaceNav(page)
    )
      .getByRole("button", { name: he ? "שירותי AI" : "AI services" })
      .click();
    const panel = page.getByRole("region", {
      name: he ? "קריאות שהעלות שלהן לא ידועה" : "Calls with an unknown cost",
    });
    await expect(panel).toBeVisible();
    const calls = panel
      .getByRole("list", { name: he ? "קריאות להחלטה" : "Calls to decide" })
      .getByRole("listitem");
    await expect(calls).toHaveCount(2);
    const heads = await calls.evaluateAll((items) =>
      items.map((item) => ({
        text: item.querySelector(".ai-unknown-head")!.textContent!,
        time: item.querySelector(".ai-unknown-when")!.textContent!,
        dir: getComputedStyle(item.querySelector(".ai-unknown-when")!)
          .direction,
        bidi: getComputedStyle(item.querySelector(".ai-unknown-when")!)
          .unicodeBidi,
      })),
    );
    // Same minute, different seconds and references.
    expect(heads[0]!.time.replace(/:\d\d(?=\D*$)/, "")).not.toBe(
      heads[0]!.time,
    );
    expect(new Set(heads.map((h) => h.text)).size).toBe(2);
    for (const head of heads) {
      expect(head.time).toMatch(/\d{1,2}:\d{2}:\d{2}/);
      expect(head.text).toMatch(
        he ? /מזהה \u2068?[0-9a-f]{8}/ : /ref\. [0-9a-f]{8}/,
      );
      expect(head.bidi).toBe("isolate");
      // A Hebrew date runs right to left; it is no longer forced left to right.
      expect(head.dir).toBe(he ? "rtl" : "ltr");
    }
    await calls.first().scrollIntoViewIfNeeded();
    await shot(page, `${locale}-unknown-list`);
    const first = calls.first();
    const ref = /[0-9a-f]{8}/.exec(heads[0]!.text)![0];
    await first
      .getByRole("button", {
        name: he ? "החלטה מה נספר" : "Decide what counts",
        exact: true,
      })
      .click();
    await first.getByRole("radio").first().check();
    await first
      .getByRole("textbox")
      .fill("Checked the provider usage page: no request at that time.");
    await first
      .getByRole("button", {
        name: he ? "שמירת ההחלטה" : "Save decision",
        exact: true,
      })
      .click();
    // The message names the call: its job, the time to the second and its reference.
    const saved = panel.getByRole("status");
    await expect(saved).toContainText(heads[0]!.time);
    await expect(saved).toContainText(ref);
    await expect(saved).toContainText(he ? "מנחה הלומדים" : "Learner tutor");
    await expect(calls).toHaveCount(1);
    await shot(page, `${locale}-unknown-saved`);
    await panel.getByText(he ? "החלטות אחרונות" : "Decided recently").click();
    const decided = panel.locator(".ai-unknown-recent li").first();
    await expect(decided).toContainText(heads[0]!.time);
    await expect(decided).toContainText(ref);
    const note = decided.locator("q");
    await expect(note).toHaveAttribute("dir", "auto");
    // The English note on a Hebrew page is set left to right, on its own line.
    expect(await note.evaluate((q) => getComputedStyle(q).direction)).toBe(
      "ltr",
    );
    await decided.scrollIntoViewIfNeeded();
    await shot(page, `${locale}-unknown-recent`);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      ),
    ).toBeLessThanOrEqual(1);
    expect(errors).toEqual([]);
  });
