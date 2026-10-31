import { expect, test, type Page } from "./health";
import AxeBuilder from "@axe-core/playwright";

/* P04: optional help never costs the learner their place. Opening the
 * companion, or the profile from "Your course", and coming back restores the
 * step, the answer draft, the reading position (anchor), focus, the open help
 * and the very same media element (so its playback position is kept). */

declare global {
  interface Window {
    __video?: Element | null;
  }
}

async function scrollState(page: Page) {
  return page.evaluate(() => {
    const host = document.querySelector(".connected-host")!;
    const main = document.querySelector<HTMLElement>(".connected-main")!;
    return host.classList.contains("is-compact")
      ? main.scrollTop
      : window.scrollY;
  });
}

test("help round trip keeps the step, draft, anchor, focus, open help and media", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const signIn = await page.request.post("/test/media-session");
  expect(signIn.ok()).toBeTruthy();
  await page.goto(`/#signin=${(await signIn.json()).token}`);
  await page
    .getByRole("button", { name: /^(Start the course|Start lesson \d+|Continue lesson \d+|Continue learning) →$/ })
    .first()
    .click();
  await page
    .getByRole("button", { name: /^(Start the course|Start lesson \d+|Continue lesson \d+|Continue learning) →$/ })
    .click();
  await expect(
    page.getByRole("heading", { name: "Minimum", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Mark this part read", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Start the next check →", exact: true })
    .click();
  const answer = page.getByRole("radio", { name: "2", exact: true });
  await answer.click();
  const help = page.getByText("1 reviewed resource for this episode");
  await help.click();
  const video = page.locator("video");
  await expect(video).toHaveCount(1);
  await page.evaluate(() => {
    window.__video = document.querySelector("video");
  });
  await answer.scrollIntoViewIfNeeded();
  await answer.focus();
  const anchor = await scrollState(page);
  expect(anchor).toBeGreaterThan(0);

  // 1. The companion: a sheet, a collapsed pane or an open pane depending on size.
  const trigger = page.locator(".connected-companion-trigger");
  if (await trigger.isVisible()) await trigger.click();
  const draft = page.getByRole("textbox", {
    name: "Message to your companion",
    exact: true,
  });
  await draft.fill("Why is 2 the smaller value?");
  if (await page.getByRole("dialog", { name: "Your companion" }).isVisible())
    await page.keyboard.press("Escape");
  else await answer.focus();
  await expect(answer).toBeChecked();
  // Opening a side pane narrows the lesson and may reflow it; the answer stays in view.
  await expect(answer).toBeInViewport();
  if (!(await page.locator(".connected-layout.with-companion").count()))
    expect(Math.abs((await scrollState(page)) - anchor)).toBeLessThanOrEqual(2);

  // 2. The profile, then back to learning.
  await answer.focus();
  const before = await scrollState(page);
  // The header (and its menu) stays on screen; dispatch the clicks so the test
  // driver does not scroll the page the way a pointer user never would.
  await page.locator(".connected-menu-toggle").dispatchEvent("click");
  await page
    .locator(".connected-menu-panel")
    .getByRole("button", { name: "My profile", exact: true })
    .dispatchEvent("click");
  await expect(page.locator(".connected-lesson-keeper")).toBeHidden();
  await page
    .getByRole("button", { name: "← Back to learning", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Minimum", exact: true }),
  ).toBeVisible();
  await expect(answer).toBeChecked();
  await expect(answer).toBeFocused();
  await expect.poll(() => scrollState(page)).toBeGreaterThan(before - 3);
  expect(Math.abs((await scrollState(page)) - before)).toBeLessThanOrEqual(2);
  expect(
    await page.evaluate(
      () =>
        window.__video === document.querySelector("video") &&
        window.__video !== null,
    ),
  ).toBe(true);
  await expect(page.locator(".connected-resources")).toHaveAttribute(
    "open",
    "",
  );
  await expect(page.locator('[aria-current="step"]')).toContainText(
    "Check your understanding",
  );
  if (await trigger.isVisible()) await trigger.click();
  await expect(draft).toHaveValue("Why is 2 the smaller value?");
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await page.screenshot({ path: info.outputPath("help-roundtrip.png") });
  expect(errors).toEqual([]);
});
