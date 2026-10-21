import { expect, test, type Page } from "./health";
import AxeBuilder from "@axe-core/playwright";
import { chooseFromMenu } from "./learner-menu";

const accessible = async (page: Page) => {
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
};
const companion = (page: Page) => page.locator('[aria-label="Your companion"]').or(page.getByRole("button", { name: "Companion", exact: true }));

test("a learner reads the study explanation, joins explicitly, gets the fixed path without the companion, and leaves", async ({ page, request }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const signIn = await request.post("/test/study-session");
  await page.goto(`/#signin=${(await signIn.json()).token}`);
  await page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Study ordering", exact: true }) })
    .getByRole("button", { name: "Open course", exact: true }).click();
  await page.getByRole("button", { name: "Start course", exact: true }).click();
  const prompt = page.getByRole("region", { name: "Join a research study? Ordering study" });
  await expect(prompt).toBeVisible();
  await expect(prompt.getByText(/A fair, random draw places you/)).toBeVisible();
  await expect(prompt.getByText(/conversations with the AI companion/)).toBeVisible();
  // Before joining, the course is the standard one.
  await expect(companion(page).first()).toBeAttached();
  await expect(prompt.getByRole("button", { name: "Join the study" })).toBeDisabled();
  await accessible(page);
  await page.screenshot({ path: info.outputPath("study-prompt.png"), fullPage: true });
  await prompt.getByRole("checkbox", { name: "I have read this and agree to take part" }).check();
  await prompt.getByRole("button", { name: "Join the study" }).click();
  await expect(prompt).toHaveCount(0);
  // The fixed path: the companion is not offered.
  await expect(companion(page)).toHaveCount(0);

  // A failed check: the next steps offer the lesson and a fresh check, never a control that leads to the hidden companion.
  await page.getByRole("button", { name: "Continue learning →", exact: true }).click();
  await page.getByRole("button", { name: "Mark this part read", exact: true }).click();
  await page.getByRole("button", { name: "Start the next check →", exact: true }).click();
  await page.getByRole("radio", { name: "5", exact: true }).click();
  await page.getByRole("button", { name: "Check answer", exact: true }).click();
  const steps = page.getByRole("group", { name: "Next steps" });
  await expect(steps.getByRole("button", { name: /Review “Minimum”/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /companion/i })).toHaveCount(0);
  await expect(page.getByText(/Ask (the|your) companion|Point your companion/)).toHaveCount(0);
  await expect(companion(page)).toHaveCount(0);
  await accessible(page);
  await page.screenshot({ path: info.outputPath("fixed-next-steps.png"), fullPage: true });

  await chooseFromMenu(page, "My profile");
  const settings = page.getByRole("region", { name: "Research study: Ordering study" });
  await expect(settings.getByText(/Your study code is P[0-9A-F]{10}/)).toBeVisible();
  await expect(settings.getByText(/Your version: The fixed lesson path/)).toBeVisible();
  await expect(page.getByText(/has no personal support\. Leave the study to turn it on\./)).toBeVisible();
  await accessible(page);
  await settings.getByRole("button", { name: "Leave the study" }).click();
  const confirm = settings.getByRole("group", { name: "Confirm leaving the study" });
  await expect(confirm).toContainText("your data is left out of the study");
  await accessible(page);
  await confirm.getByRole("button", { name: "Leave the study" }).click();
  await expect(settings.getByText(/You left this study/)).toBeVisible();
  await expect(companion(page).first()).toBeAttached();
  await page.reload();
  await page.getByRole("button", { name: "Continue learning →", exact: true }).click();
  await chooseFromMenu(page, "My profile");
  await expect(page.getByRole("region", { name: "Research study: Ordering study" }).getByText(/You left this study/)).toBeVisible();
  await accessible(page);
  expect(errors).toEqual([]);
});

test("in a study that asked for usability timings, the app sends only place codes, times and counts for the participant", async ({ page, request }, info) => {
  const signIn = await request.post("/test/study-session", { data: { usability: true } });
  await page.goto(`/#signin=${(await signIn.json()).token}`);
  await page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Study ordering", exact: true }) })
    .getByRole("button", { name: "Open course", exact: true }).click();
  await page.getByRole("button", { name: "Start course", exact: true }).click();
  const prompt = page.getByRole("region", { name: "Join a research study? Ordering study" });
  await expect(prompt.getByText(/how many other buttons you try first/)).toBeVisible();
  await prompt.getByRole("checkbox", { name: "I have read this and agree to take part" }).check();
  await prompt.getByRole("button", { name: "Join the study" }).click();
  await expect(prompt).toHaveCount(0);
  const sent: { body: { batchId: string; trials: Record<string, unknown>[] }; status: number }[] = [];
  page.on("response", async (response) => {
    if (response.url().endsWith("/study/usability") && response.request().method() === "POST")
      sent.push({ body: response.request().postDataJSON(), status: response.status() });
  });
  await page.getByRole("button", { name: "Continue learning →", exact: true }).click();
  await page.getByRole("button", { name: "Mark this part read", exact: true }).click();
  // Leaving the app sends what was timed.
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(() => sent.length).toBeGreaterThan(0);
  const trials = sent.flatMap((s) => s.body.trials);
  expect(sent.every((s) => s.status === 200)).toBe(true);
  const device = info.project.name === "phone" ? "phone" : info.project.name === "tablet" ? "tablet" : "desktop";
  expect(trials.filter((t) => t.outcome === "reached").map((t) => [t.kind, t.place, t.deviceClass])).toEqual([
    ["next_action", "course_page", device],
    ["next_action", "lesson", device],
  ]);
  // Nothing else leaves the device: no lesson ids, no text, no positions.
  for (const t of trials) expect(Object.keys(t).sort()).toEqual(["contextKept", "deviceClass", "elapsedMs", "kind", "outcome", "place", "wrongTurns"]);
});
