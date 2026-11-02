import { expect, test, type Page } from "./health";
import AxeBuilder from "@axe-core/playwright";
import { chooseFromMenu } from "./learner-menu";
import { closeCompanion, companionPanel, openCompanion } from "./companion-helpers";

/*
 * The profile and record AI panels of the learner AI redesign (final design §4.9-§4.17), on the real
 * connected host: a quick check answered in the long-answer composer, connected agents behind
 * "Advanced", a decision waiting on the learner shown in the companion's thread with a "Review" that
 * opens the decisions section, and the agent status in Hebrew on two lines.
 */
const tags = ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"];
const accessible = async (page: Page) => {
  expect((await new AxeBuilder({ page }).withTags(tags).analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
};
const resume = /^(Start the course|Start lesson \d+|Continue lesson \d+|Continue learning) →$/;

async function signIn(page: Page, session: string, locale = "en") {
  const token = (await (await page.request.post(session)).json()).token;
  await page.goto(`/?locale=${locale}#signin=${token}`);
}
/** Opens "My profile" once its loading panels have settled. */
async function openProfile(page: Page, locale: "en" | "he" = "en") {
  await chooseFromMenu(page, locale === "he" ? "הפרופיל שלי" : "My profile");
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  for (const label of locale === "he" ? ["עבודת המנחה נטענת"] : ["Loading your companion's work", "Loading learning memory", "Loading teaching ideas"])
    await expect(page.getByLabel(label, { exact: true })).toHaveCount(0);
}

test("a quick check takes its answer in the long-answer composer: Enter adds a line, Ctrl or Cmd+Enter submits, never mid-composition", async ({ page }, info) => {
  // The course's probes are choices; this one is a number, which the composer takes. The read and
  // the answer are served here, the rest of the profile by the real host.
  const runId = "0b7b0f2c-3f5e-4bb0-9a8b-1e1f8c4a7d22";
  let answered = false;
  const answers: Record<string, unknown>[] = [];
  await page.route(/\/learner-model\/hypotheses$/, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    // The panel drops a read it no longer needs (a newer one replaced it); so does this.
    let response, body;
    try {
      response = await route.fetch();
      body = JSON.parse((await response.body()).toString("utf8"));
    } catch {
      return route.abort().catch(() => {});
    }
    if (!answered && body.items?.[0])
      body.probes = [{ probeRunId: runId, probeId: "probe", hypothesisIds: [body.items[0].hypothesisId], requestedBy: "supervisor", state: "scheduled",
        question: { id: "item", type: "numeric", prompt: "What is the smallest of 4, 9 and 2?" },
        outcome: null, scheduledAt: "2026-01-01T00:00:00Z", expiresAt: "2099-01-08T00:00:00Z", answeredAt: null, countsAsEvidence: false }];
    await route.fulfill({ status: response.status(), contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.route(new RegExp(`/probes/${runId}/answer$`), async (route) => {
    const sent = route.request().postDataJSON() as Record<string, unknown> & { expectedRevision: number };
    answers.push(sent);
    answered = true;
    await route.fulfill({ json: { revision: sent.expectedRevision + 1, eventId: "probe-event", grantsMastery: false, probeRunId: runId, outcome: "correct",
      correct: true, explanation: null, conclusive: false, hypotheses: [], countsAsEvidence: false } });
  });
  await signIn(page, "/test/hypothesis-session");
  await page.getByRole("button", { name: resume }).click();
  await openProfile(page);
  const check = page.locator('[data-prof="quick-check"]');
  await expect(check.getByText("Quick check · doesn't count toward progress", { exact: true })).toBeVisible();
  await expect(check.getByText("Unverified", { exact: true })).toBeVisible();
  // On a phone the kind line wraps inside the quick check instead of running past its edge.
  const head = await check.evaluate((card) => {
    const row = card.firstElementChild as HTMLElement, edge = card.getBoundingClientRect();
    const right = Math.max(...Array.from(row.querySelectorAll("*"), (node) => node.getBoundingClientRect().right));
    return { scroll: row.scrollWidth, client: row.clientWidth, right, edge: edge.right };
  });
  expect(head.scroll).toBeLessThanOrEqual(head.client + 1);
  expect(head.right).toBeLessThanOrEqual(head.edge + 1);
  const field = check.getByRole("textbox", { name: "Your answer", exact: true });
  const mac = await page.evaluate(() => /mac|iphone|ipad/i.test(navigator.platform));
  await expect(field).toHaveAccessibleDescription(mac ? "⌘ Enter to submit" : /Ctrl\+Enter to submit/);
  const submit = check.getByRole("button", { name: "Submit check", exact: true });
  await expect(submit).toBeDisabled();
  await field.click();
  await page.keyboard.type("2");
  await page.keyboard.press("Enter");
  await expect(field).toHaveValue("2\n");
  // An input method's Enter commits its text and never submits.
  await field.dispatchEvent("compositionstart");
  await field.dispatchEvent("keydown", { key: "Enter", code: "Enter", ctrlKey: true, metaKey: true, isComposing: true, keyCode: 229 });
  await field.dispatchEvent("compositionend");
  await page.waitForTimeout(100);
  expect(answers).toEqual([]);
  await accessible(page);
  await check.screenshot({ path: info.outputPath("quick-check.png") });
  await page.keyboard.press(mac ? "Meta+Enter" : "Control+Enter");
  await expect.poll(() => answers.length).toBe(1);
  expect(answers[0]).toMatchObject({ answer: 2 });
  await expect(page.getByText("Thanks. This helps your companion; it doesn't count toward your progress.", { exact: true })).toBeVisible();
});

test("connected agents wait behind Advanced, which opens from the keyboard", async ({ page }, info) => {
  await signIn(page, "/test/session");
  await page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Ordering values", exact: true }) })
    .getByRole("button", { name: "Open course", exact: true }).click();
  await page.getByRole("button", { name: "Start course", exact: true }).click();
  await openProfile(page);
  const advanced = page.locator(".cc-prof-advanced");
  const summary = advanced.locator(":scope > summary");
  await expect(summary).toHaveText("Advanced");
  await expect(page.getByRole("heading", { name: "Connected agents", exact: true })).toBeHidden();
  await summary.focus();
  await page.keyboard.press("Enter");
  await expect(advanced).toHaveAttribute("open", "");
  const panel = page.getByRole("region", { name: "Connected agents" });
  await expect(panel.getByText("Let an AI agent you use elsewhere read parts of your record for Ordering values and suggest changes for you to review.", { exact: true })).toBeVisible();
  await expect(panel.getByText("No agents are connected.", { exact: true })).toBeVisible();
  await accessible(page);
  await advanced.screenshot({ path: info.outputPath("advanced.png") });
  await page.keyboard.press("Enter");
  await expect(advanced).not.toHaveAttribute("open", "");
});

test("a decision waiting on the learner adds a line to the companion's thread, and Review opens the decisions section", async ({ page }, info) => {
  await signIn(page, "/test/supervisor-requests-session");
  await page.getByRole("button", { name: resume }).click();
  const companion = await openCompanion(page);
  const line = companion.getByText("Your companion suggests a new goal.", { exact: true });
  await expect(line).toBeVisible();
  await accessible(page);
  await companion.screenshot({ path: info.outputPath("decision-line.png") });
  // The waiting decision also marks the trigger with its dot, and its name says why.
  const trigger = page.locator(".connected-companion-trigger:visible");
  await closeCompanion(page);
  await expect(trigger).toHaveAccessibleName("Companion, a suggestion to review");
  await expect(trigger.locator(".cc-shell-trigger-dot")).toBeVisible();
  await openCompanion(page);
  await companion.getByRole("button", { name: "Review", exact: true }).click();
  const section = page.locator("#profile-decisions");
  await expect(section).toBeFocused();
  await expect(section).toBeInViewport();
  await expect(section.getByRole("heading", { name: "Decisions and work from your companion", exact: true })).toBeVisible();
  await expect(section.getByText("Suggested goal: Find minima and maxima", { exact: true })).toBeVisible();
  await closeCompanion(page);
  await accessible(page);
  await section.screenshot({ path: info.outputPath("decisions.png") });
  // Deciding takes the line away.
  await section.getByRole("button", { name: "Keep my goal", exact: true }).click();
  await expect(section.getByText("You kept your goal. Nothing changed.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "← Back to learning", exact: true }).click();
  await page.getByRole("button", { name: resume }).click();
  await expect(trigger).toHaveAccessibleName("Companion");
  await expect(trigger.locator(".cc-shell-trigger-dot")).toHaveCount(0);
  await openCompanion(page);
  await expect(companionPanel(page).getByText("Your companion suggests a new goal.", { exact: true })).toHaveCount(0);
});

test("in Hebrew the profile panels name one helper, and a connected agent's dates sit on two lines", async ({ page }, info) => {
  await signIn(page, "/test/session", "he");
  await page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Ordering values", exact: true }) })
    .getByRole("button", { name: "פתיחת הקורס", exact: true }).click();
  await page.getByRole("button", { name: "התחלת הקורס", exact: true }).click();
  await openProfile(page, "he");
  await expect(page.getByRole("heading", { name: "תמיכה אישית בשיעורים", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "הפעלה", exact: true })).toBeVisible();
  await page.getByText("מתקדם", { exact: true }).click();
  const panel = page.getByRole("region", { name: "סוכנים מחוברים" });
  await panel.getByText("חיבור סוכן", { exact: true }).click();
  await panel.getByLabel("שם לסוכן הזה").fill("Desk agent");
  await panel.getByRole("button", { name: "חיבור הסוכן", exact: true }).click();
  const token = await panel.getByLabel("מפתח הסוכן").inputValue();
  // The agent reads once with its key, so the grant has a last use.
  expect((await page.request.post("/api/agent-tools/v1/tools/get_context", { headers: { authorization: `Bearer ${token}` }, data: {} })).status()).toBe(200);
  // The panel reads its list again when My profile opens again.
  await page.getByRole("button", { name: /חזרה ללמידה/ }).click();
  await expect(page.locator(".cc-prof-advanced")).toHaveCount(0);
  await openProfile(page, "he");
  await page.getByText("מתקדם", { exact: true }).click();
  const grant = page.getByRole("list", { name: "סוכנים שמחוברים עכשיו" }).getByRole("listitem");
  await expect(grant.getByText("מחובר עכשיו", { exact: true })).toBeVisible();
  const until = grant.getByText(/^עד /), used = grant.getByText(/^שימוש אחרון: /);
  await expect(until).toBeVisible();
  await expect(used).toBeVisible();
  const [a, b] = [(await until.boundingBox())!, (await used.boundingBox())!];
  expect(b.y).toBeGreaterThanOrEqual(a.y + a.height - 1);
  await expect(grant).not.toContainText("·");
  // The status starts at the reading edge: the right.
  const card = (await grant.boundingBox())!;
  expect(card.x + card.width - (a.x + a.width)).toBeLessThan(40);
  await accessible(page);
  await grant.screenshot({ path: info.outputPath("agent-he.png") });
});
