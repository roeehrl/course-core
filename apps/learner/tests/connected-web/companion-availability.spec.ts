import { expect, test, type Page } from "./health";
import AxeBuilder from "@axe-core/playwright";

// Split from roadmap.spec.ts: the companion on the course page and in a lesson, with the server's availability.

/*
 * The course page and the lesson page as a learner meets them (0.1.60 owner review): the page says
 * where the learner is, what is next and how far along they are, in words that match their real
 * state, on every device project.
 */

async function signIn(page: Page, session = "/test/session") {
  const token = (await (await page.request.post(session)).json()).token;
  await page.goto(`/#signin=${token}`);
}
async function startCourse(page: Page) {
  await signIn(page);
  await page
    .getByRole("article")
    .filter({
      has: page.getByRole("heading", { name: "Ordering values", exact: true }),
    })
    .getByRole("button", { name: "Open course", exact: true })
    .click();
  await page.getByRole("button", { name: "Start course", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Your learning path" }),
  ).toBeVisible();
}

// A first visit: no remembered companion pane preference.
test.use({ companionPane: "default" });

const axe = (page: Page) =>
  new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();

for (const [session, banner] of [
  ["/test/session", undefined],
  ["/test/companion-off-session", "Your companion isn't on for this course yet. You can still ask; questions are saved and answered once it's on."],
] as const)
  test(`the companion is closed on the course page and shows the server's state only when it limits asking: ${banner ? "not set up" : "ready"}`, async ({ page }, info) => {
    if (session === "/test/session") await startCourse(page);
    else {
      await signIn(page, session);
      await page.getByRole("button", { name: "Continue learning →", exact: true }).click();
    }
    await expect(page.getByTestId("next-step")).toBeVisible();
    const pane = page.locator("#connected-companion");
    await expect(pane).toBeHidden();
    await expect(page.locator(".connected-layout")).not.toHaveClass(/with-companion/);
    await page.locator(".connected-companion-trigger:visible").click();
    await expect(pane).toBeVisible();
    const notice = pane.locator(".cc-chat-notice");
    // No status line: nothing says "Available" or "Checking whether it is on".
    for (const gone of [/^Companion: /, /Available/, /Checking whether/, "Your saved conversation", "Following your place", "Course roadmap", "Asking about"])
      await expect(pane.getByText(gone)).toHaveCount(0);
    // Outside a lesson: where the conversation lives, the way into a lesson, no composer.
    await expect(pane.getByText("Your conversation lives here", { exact: true })).toBeVisible();
    await expect(notice).toContainText(banner ?? "Open a lesson to ask about it. Your conversation stays here.");
    await expect(pane.getByRole("textbox")).toHaveCount(0);
    // In a lesson it asks about that lesson, and it stays as the learner left it.
    await page.getByRole("button", { name: "Close companion" }).click();
    await page.getByTestId("next-step").locator('[data-usability="next"]').click();
    await expect(page.getByRole("heading", { name: "Minimum", exact: true })).toBeVisible();
    await expect(pane).toBeHidden();
    await page.locator(".connected-companion-trigger:visible").click();
    if (banner) await expect(notice).toHaveText(banner);
    else await expect(notice).toHaveCount(0);
    await expect(pane.getByText("Ask anything about this lesson", { exact: true })).toBeVisible();
    await expect(pane.getByRole("textbox", { name: "Message to your companion", exact: true })).toBeVisible();
    await expect(pane.locator(".cc-chat-send")).toHaveAccessibleName("Send");
    expect((await axe(page)).violations).toEqual([]);
    await page.screenshot({ path: info.outputPath("companion.png") });
  });
