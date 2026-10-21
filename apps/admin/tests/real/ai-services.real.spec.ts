import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { createTranslator } from "@course-core/i18n";
import enAi from "../../src/i18n/messages/en/aiServices.json" with { type: "json" };
import heAi from "../../src/i18n/messages/he/aiServices.json" with { type: "json" };
import enFirst from "../../src/i18n/messages/en/firstRun.json" with { type: "json" };
import heFirst from "../../src/i18n/messages/he/firstRun.json" with { type: "json" };
import enSignIn from "../../src/i18n/messages/en/signIn.json" with { type: "json" };
import heSignIn from "../../src/i18n/messages/he/signIn.json" with { type: "json" };

type Locale = "en" | "he";
type Args = Record<string, string | number>;
/** The page's own catalog, so the test reads exactly what the page shows in each locale. */
function text(locale: Locale) {
  const tr = createTranslator({
    locale,
    catalogs: {
      en: { aiServices: enAi, firstRun: enFirst, signIn: enSignIn },
      he: { aiServices: heAi, firstRun: heFirst, signIn: heSignIn },
    },
  });
  type Key = Parameters<typeof tr.t>[0];
  return {
    t: (key: string, args?: Args) => tr.t(`aiServices.${key}` as Key, args),
    f: (key: string, args?: Args) => tr.t(`firstRun.${key}` as Key, args),
    signIn: (key: string) => tr.t(`signIn.${key}` as Key),
    money: (usd: number) =>
      tr
        .currency(usd, "USD", {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })
        .replace(/[\u200e\u200f]/g, ""),
  };
}

// Real server and database. Google's model listing is a scripted stub in scripts/real-server.ts:
// no provider is contacted, nothing is generated and no real key exists. A brand-new owner goes
// from an empty workspace (no course) to "AI services are on" on one page, in English and Hebrew,
// at desktop, tablet and phone sizes.
const goodKey = ["SYNTHETIC", "AI", "SERVICES", "KEY", "7Q2c"].join("_"),
  revokedKey = "SYNTHETIC_REVOKED_KEY";
const FORBIDDEN =
  /[{}]|COURSE_PROVIDER_|digest|adapter|binding|metadata|revision/i;

async function accessible(page: Page) {
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await expect(
    page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    ),
  ).resolves.toBeLessThanOrEqual(1);
}
/** Visible text of the page outside "Advanced (for developers)". */
async function plainText(page: Page) {
  return page.evaluate(() => {
    const root = document
      .querySelector(".ai-page")!
      .cloneNode(true) as HTMLElement;
    root.querySelector("#ai-advanced")?.remove();
    document.body.append(root);
    const value = root.innerText;
    root.remove();
    return value;
  });
}
function record(page: Page) {
  const bodies: string[] = [],
    posts: string[] = [];
  page.on("request", (r) => {
    if (r.method() !== "GET") posts.push(new URL(r.url()).pathname);
  });
  page.on("response", (r) => {
    if (r.url().includes("/api/admin/"))
      void r
        .text()
        .then((body) => bodies.push(body))
        .catch(() => {});
  });
  return { bodies, posts };
}

for (const locale of ["en", "he"] as Locale[]) {
  test(`an owner of an empty workspace turns AI services on from one page (${locale})`, async ({
    page,
    request,
  }, info) => {
    const x = text(locale),
      { t, f, signIn } = x;
    const fixture = await (
      await request.post("/test/empty-workspace-fixture")
    ).json();
    const seen = record(page);
    await page.goto(`/admin/?locale=${locale}`);
    await page.getByLabel(signIn("code")).fill(fixture.ownerCode);
    await page
      .getByRole("button", { name: signIn("useCode"), exact: true })
      .click();

    // First run: no course yet, and AI services can still be set up.
    await expect(
      page.getByRole("heading", { name: f("title"), level: 1 }),
    ).toBeVisible();
    if (locale === "he")
      await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await accessible(page);
    await page.screenshot({
      path: info.outputPath(`01-first-run-${locale}.png`),
      fullPage: true,
    });
    await page.getByRole("button", { name: f("ai.button") }).click();
    await expect(
      page.getByRole("heading", { name: f("ai.title"), level: 1 }),
    ).toBeVisible();

    const status = page.locator(".ai-status-bar");
    await expect(status).toContainText(t("status.off"));
    await expect(
      status.getByRole("link", { name: t("issue.connect") }),
    ).toBeVisible();
    await expect(
      status.getByRole("link", { name: t("issue.spending") }),
    ).toBeVisible();
    await accessible(page);
    await page.screenshot({
      path: info.outputPath(`02-empty-${locale}.png`),
      fullPage: true,
    });

    // Connections: an empty key is refused in the browser, a rejected key is explained and kept.
    const service = t("service.google");
    const key = page.getByLabel(t("connect.keyLabel"), { exact: true });
    await page.getByRole("button", { name: t("connect.save") }).click();
    await expect(
      page
        .getByRole("alert")
        .filter({ hasText: t("connect.errEmpty", { service }) }),
    ).toBeVisible();
    expect(seen.posts.filter((p) => p.endsWith("/connections"))).toEqual([]);

    // A pasted key with look-alike characters names each one, where it is and what it should
    // be; nothing is tested or saved, and nothing is replaced until the owner asks.
    const lookalike = ["AQ", "Ab8SYNTHETIC\u00d7KEY\u2013real", "0000"].join(
      ".",
    );
    await key.fill(lookalike);
    await key.blur();
    await expect(
      page.getByText(t("keyChars.summary", { count: 2 })),
    ).toBeVisible();
    const chars = page.locator(".ai-key-chars");
    await expect(chars.locator("li")).toHaveText([
      t("keyChars.letter", {
        position: lookalike.indexOf("\u00d7") + 1,
        shown: "\u00d7",
        name: t("keyChars.name.multiplication"),
        plain: "x",
      }),
      t("keyChars.hyphen", {
        position: lookalike.indexOf("\u2013") + 1,
        shown: "\u2013",
        name: t("keyChars.name.enDash"),
        plain: "-",
      }),
    ]);
    // Isolated left to right (the translator also isolates arguments in Hebrew).
    await expect(chars.locator("bdi[dir=ltr]").first()).toHaveText(
      /^[\u2066-\u2069]*\u00d7[\u2066-\u2069]*$/,
    );
    await expect(chars).toContainText(t("keyChars.recopy.google"));
    await expect(
      page.getByRole("button", { name: t("connect.save") }),
    ).toBeDisabled();
    await expect(page.getByText(t("keyChars.saveBlocked"))).toBeVisible();
    await expect(key).toHaveValue(lookalike);
    await expect(chars).not.toContainText("SYNTHETIC");
    expect(seen.posts.filter((p) => p.endsWith("/test-key"))).toEqual([]);
    await accessible(page);
    await chars.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: info.outputPath(`03-key-characters-${locale}.png`),
    });
    // An invisible character is removed on request; the fixed key is then checked as usual.
    await key.fill(revokedKey.replace("_KEY", "\u200b_KEY"));
    await expect(chars.locator("li")).toHaveText([
      t("keyChars.hidden", {
        position: 18,
        name: t("keyChars.name.zeroWidthSpace"),
      }),
    ]);
    await page
      .getByRole("button", { name: t("keyChars.fix", { count: 1 }) })
      .click();
    await expect(key).toHaveValue(revokedKey);
    await expect(key).toBeFocused();
    await expect(
      page.getByText(t("keyChars.fixed", { count: 1 })),
    ).toBeVisible();
    await expect(
      page.getByText(t("connect.errRejected", { service })),
    ).toBeVisible();
    await expect(key).toHaveValue(revokedKey);
    expect(seen.posts.filter((p) => p.endsWith("/connections"))).toEqual([]);

    await key.fill(goodKey);
    await key.blur();
    await expect(
      page.getByText(t("connect.testOk", { service, count: 4 })),
    ).toBeVisible();
    await page.getByRole("button", { name: t("connect.save") }).click();
    await expect(
      page.getByText(t("connect.saved", { ending: "7Q2c" })),
    ).toBeVisible();
    await expect(
      page.getByLabel(t("connect.keyLabel"), { exact: true }),
    ).toHaveCount(0);
    const row = page.locator(".ai-connection");
    await expect(row.locator("bdi[dir=ltr]").first()).toHaveText("7Q2c");
    await expect(row).toContainText(t("row.working"));

    // Models: the suggestion for each needed job is prefilled; saving waits for a quality check
    // of both jobs (every agent role is gated on an evaluated revision, N07).
    const tutor = page.getByLabel(
      t("models.modelFor", { job: t("role.companion.name") }),
    );
    await expect(tutor.locator("option:checked")).toContainText(
      "gemini-9.0-flash",
    );
    await expect(
      page
        .getByLabel(t("models.modelFor", { job: t("role.supervisor.name") }))
        .locator("option:checked"),
    ).toContainText("gemini-9.0-flash");
    await page.getByRole("button", { name: t("models.save") }).click();
    await expect(
      page.getByText(t("models.savedWaiting", { count: 2 })),
    ).toBeVisible();
    await expect(
      status.getByRole("link", { name: t("issue.check", { count: 2 }) }),
    ).toBeVisible();
    await expect(
      status.getByRole("link", { name: t("issue.prices", { count: 1 }) }),
    ).toBeVisible();

    // Prices: one block for the model both jobs use; both prices or neither.
    const prices = page.locator("#ai-prices");
    await prices.getByLabel(t("prices.input"), { exact: true }).fill("0.30");
    await prices.getByRole("button", { name: t("prices.save") }).click();
    await expect(
      prices.getByRole("alert").filter({ hasText: t("prices.errBoth") }),
    ).toBeVisible();
    await prices.getByLabel(t("prices.output"), { exact: true }).fill("2.50");
    await prices.getByRole("button", { name: t("prices.save") }).click();
    await expect(prices.getByText(t("prices.saved"))).toBeVisible();

    // Spending: the button is the consent and names the amount ($25 total, $2 per learner).
    const spending = page.locator("#ai-spending");
    await expect(spending.getByLabel(t("spending.perLearner"))).toHaveValue(
      "2.00",
    );
    await spending
      .getByRole("button", {
        name: t("spending.allow", { amount: x.money(25) }),
      })
      .click();
    await expect(spending.getByText(t("spending.saved"))).toBeVisible();

    // Quality check: the owner runs it from the page. It shows the estimate first (11 practice
    // conversations at $0.30 / $2.50 per million tokens: nine tutor calls of 3000 input and 600
    // output tokens, $0.0024 each, and two supervisor tool-loop conversations of three rounds each
    // (two tool results, then the answer) whose input grows by 1000 tokens a round, 12000 input
    // and 1800 output tokens, $0.0081 each), runs on the server against the synthetic model,
    // passes, and the waiting model is turned on.
    const check = page.locator("#ai-check");
    await expect(check).toContainText(t("check.notChecked", { count: 2 }));
    await expect(check.locator("bdi[dir=ltr]").first()).toHaveText(
      "gemini-9.0-flash",
    );
    await expect(
      check.getByText(
        t("check.run.estimate", { count: 11, amount: x.money(0.0378) }),
      ),
    ).toBeVisible();
    // Approving without a check is still there, folded away as the secondary choice.
    await expect(check.locator("details.ai-approve > summary")).toHaveText(
      t("check.approveTitle"),
    );
    await expect(check.getByLabel(t("check.reasonLabel"))).toBeHidden();
    await accessible(page);
    await check.scrollIntoViewIfNeeded();
    await check.screenshot({
      path: info.outputPath(`03-check-ready-${locale}.png`),
    });
    await check.getByRole("button", { name: t("check.run.button") }).click();
    await expect(check.getByText(t("check.run.passedTurnOn"))).toBeVisible({
      timeout: 30000,
    });
    expect(seen.posts.filter((p) => p.endsWith("/quality-check"))).toHaveLength(
      1,
    );
    await accessible(page);
    await check.screenshot({
      path: info.outputPath(`04-check-passed-${locale}.png`),
    });
    await check.getByRole("button", { name: t("models.turnOn") }).click();

    await expect(status).toContainText(t("status.on"));
    for (const id of ["connections", "models", "prices", "spending", "check"])
      await expect(
        page.locator(`#ai-${id} .ai-section-heading .ai-pill.ok`),
      ).toBeVisible();
    // No JSON or internal plumbing outside Advanced; ids and money are isolated left to right.
    expect(await plainText(page)).not.toMatch(FORBIDDEN);
    if (locale === "he") {
      await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
      await expect(page.locator("html")).toHaveAttribute("lang", "he");
    }
    await accessible(page);
    await page.screenshot({
      path: info.outputPath(`05-on-${locale}.png`),
      fullPage: true,
    });

    // Advanced stays closed until asked for; it explains the internal names.
    const advanced = page.locator("#ai-advanced");
    await expect(advanced).not.toHaveAttribute("open", "");
    await advanced.locator("summary").click();
    await expect(advanced.locator("pre")).toContainText("COURSE_PROVIDER_");
    await accessible(page);

    // The key never comes back: not in any response, not in the page.
    await page.waitForTimeout(200);
    for (const body of seen.bodies) {
      expect(body).not.toContain(goodKey);
      expect(body).not.toContain(revokedKey);
    }
    expect(await page.content()).not.toContain(goodKey);
  });
}

test("an administrator cannot approve without a check; a connection in use cannot be removed", async ({
  page,
  request,
}) => {
  const { t } = text("en");
  const fixture = await (
    await request.post("/test/empty-workspace-fixture")
  ).json();
  await page.goto("/admin/");
  await page.getByLabel("One-time sign-in code").fill(fixture.adminCode);
  await page.getByRole("button", { name: "Use code", exact: true }).click();
  await page.getByRole("button", { name: "Set up AI services" }).click();
  const key = page.getByLabel(t("connect.keyLabel"), { exact: true });
  await key.fill("SHORT_KEY_1");
  await page.getByRole("button", { name: t("connect.save") }).click();
  // A key shorter than 16 characters never shows its ending.
  await expect(page.getByText(t("connect.savedNoEnding"))).toBeVisible();
  await expect(page.locator(".ai-connection")).toContainText(t("row.keySaved"));
  await page.getByRole("button", { name: t("models.save") }).click();
  await expect(
    page.getByText(t("models.savedWaiting", { count: 2 })),
  ).toBeVisible();
  const check = page.locator("#ai-check");
  await expect(check.getByText(t("check.approveOwnersOnly"))).toBeVisible();
  await expect(
    check.getByRole("button", { name: t("check.approve") }),
  ).toHaveCount(0);
  // The waiting draft is not on: the connection is not used yet and the models stay pending.
  await expect(page.locator("#ai-models")).toContainText(t("models.pending"));
  // Replace the key in place; then discard the choices.
  await page.getByRole("button", { name: t("row.replaceKey") }).click();
  await page.getByLabel(/New API key for/).fill(revokedKey);
  await page.getByRole("button", { name: t("row.replaceSave") }).click();
  await expect(
    page.getByText(t("connect.errRejected", { service: "Google" })),
  ).toBeVisible();
  await page.getByLabel(/New API key for/).fill(goodKey);
  await page.getByRole("button", { name: t("row.replaceSave") }).click();
  await expect(
    page.getByText(t("row.replaced", { ending: "7Q2c" })),
  ).toBeVisible();
  await page.getByRole("button", { name: t("models.discard") }).click();
  await expect(page.getByText(t("models.discarded"))).toBeVisible();
  await page.getByRole("button", { name: t("row.remove") }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: t("row.removeConfirm") })
    .click();
  await expect(page.getByText(t("row.removed"))).toBeVisible();
  // With no connection left, the page offers to connect one again.
  await expect(
    page.getByLabel(t("connect.keyLabel"), { exact: true }),
  ).toBeVisible();
  await accessible(page);
});

for (const locale of ["en", "he"] as Locale[]) {
  test(`a known model's prices are prefilled from the dated table and saved by the owner (${locale})`, async ({
    page,
    request,
  }, info) => {
    const x = text(locale),
      { t, signIn } = x;
    const fixture = await (
      await request.post("/test/empty-workspace-fixture")
    ).json();
    await page.goto(`/admin/?locale=${locale}`);
    await page.getByLabel(signIn("code")).fill(fixture.ownerCode);
    await page
      .getByRole("button", { name: signIn("useCode"), exact: true })
      .click();
    await page.getByRole("button", { name: x.f("ai.button") }).click();
    await page.getByLabel(t("connect.keyLabel"), { exact: true }).fill(goodKey);
    await page.getByRole("button", { name: t("connect.save") }).click();
    await expect(
      page.getByText(t("connect.saved", { ending: "7Q2c" })),
    ).toBeVisible();

    // Each suggestion says why in one line; special-purpose models stay under "Show all models".
    const models = page.locator("#ai-models");
    await expect(
      models.getByText(t("models.why.companion"), { exact: false }),
    ).toBeVisible();
    await models.locator("details.ai-optional > summary").click();
    await expect(
      models.getByText(t("models.why.reviewer"), { exact: false }),
    ).toBeVisible();
    await expect(models.getByText(t("models.why.media"))).toBeVisible();
    for (const job of ["companion", "supervisor"])
      await models
        .getByLabel(t("models.modelFor", { job: t(`role.${job}.name`) }))
        .selectOption({ label: "Gemini 3.8 Flash (gemini-3.8-flash)" });
    await models.screenshot({
      path: info.outputPath(`06-models-${locale}.png`),
    });
    await models.getByRole("button", { name: t("models.save") }).click();
    await expect(
      page.getByText(t("models.savedWaiting", { count: 2 })),
    ).toBeVisible();

    // Prices: filled in from Google's pricing page with its date; the owner confirms with Save.
    const prices = page.locator("#ai-prices");
    await expect(
      prices.getByLabel(t("prices.input"), { exact: true }),
    ).toHaveValue("0.75");
    await expect(
      prices.getByLabel(t("prices.output"), { exact: true }),
    ).toHaveValue("3.75");
    await expect(prices.locator(".ai-price-suggestion")).toBeVisible();
    await expect(prices.locator(".ai-price-suggestion a")).toHaveAttribute(
      "href",
      "https://ai.google.dev/gemini-api/docs/pricing",
    );
    await expect(
      prices.getByText(t("prices.changeSaved"), { exact: false }),
    ).toBeVisible();
    await accessible(page);
    await prices.screenshot({
      path: info.outputPath(`07-prices-prefilled-${locale}.png`),
    });
    await prices.getByRole("button", { name: t("prices.save") }).click();
    await expect(prices.getByText(t("prices.saved"))).toBeVisible();
    await expect(
      page
        .locator(".ai-status-bar")
        .getByRole("link", { name: t("issue.prices", { count: 1 }) }),
    ).toHaveCount(0);
    // Saved as the workspace's own price, editable like any other.
    await expect(
      prices.getByLabel(t("prices.input"), { exact: true }),
    ).toBeEditable();
  });
}
