// Real API, PostgreSQL and learner export: a learner who answers as soon as a check appears never
// loses the tap, wherever on the option it lands, including the strip just above the sticky answer
// actions when the option runs on under them.
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const CHECKS = 12;
/** The fixture's options for check n (start.ts, /test/quick-answer-session); the last is right. */
const options = (n: number): [string, string, string] => [
  `${n + 29} is the minimum, because the value read last in a list always replaces the values read before it.`,
  "Neither is the minimum: two different values compared with each other are always treated as equal.",
  `${n + 2} is the minimum: it is no greater than any other member, so a running minimum keeps it once it is read.`,
];

async function openQuickAnswers(page: Page, request: APIRequestContext) {
  const fixture = await (await request.post("/test/quick-answer-session", { data: { items: CHECKS } })).json();
  await page.goto(`/#signin=${fixture.token}`);
  await page.getByRole("button", { name: "Open course", exact: true }).click();
  await page.getByRole("button", { name: "Start course", exact: true }).click();
  await page.getByRole("region", { name: "Already know some of this?" }).getByRole("button", { name: "Start from the beginning" }).click();
  // The decline is confirmed (the offer leaves) before the next press.
  await expect(page.locator("section.connected-placement")).toHaveCount(0);
  await page.getByRole("button", { name: "Continue learning →", exact: true }).first().click();
  await page.getByRole("button", { name: "Mark this part read", exact: true }).click();
}

declare global {
  interface Window {
    __quick?: { shown: Map<string, number>; pressedAt: number | null };
  }
}

/** Records when each option first appears and when the next press starts. */
async function watchPresses(page: Page) {
  await page.evaluate(() => {
    const quick = (window.__quick = { shown: new Map<string, number>(), pressedAt: null as number | null });
    const seen = () => {
      for (const radio of document.querySelectorAll('[role="radio"]')) {
        const name = radio.getAttribute("aria-label") ?? "";
        if (!quick.shown.has(name)) quick.shown.set(name, performance.now());
      }
    };
    new MutationObserver(seen).observe(document.body, { childList: true, subtree: true });
    for (const type of ["pointerdown", "touchstart", "mousedown"])
      document.addEventListener(type, () => (quick.pressedAt ??= performance.now()), { capture: true, passive: true });
  });
}

type Spot = "top" | "middle" | "edge";
/**
 * Waits, frame by frame, for the new check's options and, in the frame they are first found,
 * brings one into view as a learner's flick would and returns a point on it: near the top of the
 * first option, in the middle of the second, or (`edge`) on the last option with only `shown` px of
 * it above the sticky answer actions, 3 to 9 px above them.
 */
async function spotAsSoonAsShown(page: Page, n: number, spot: Spot) {
  const handle = await page.waitForFunction(
    ({ names, spot, shown, gap }) => {
      const index = spot === "top" ? 0 : spot === "middle" ? 1 : 2;
      const radio = Array.from(document.querySelectorAll('[role="radio"]')).find((el) => el.getAttribute("aria-label") === names[index]);
      const actions = document.querySelector(".connected-answer-actions");
      if (!radio || !actions) return null;
      const pane = document.querySelector<HTMLElement>(".connected-main");
      const scroller = pane && pane.scrollHeight > pane.clientHeight ? pane : document.scrollingElement!;
      const header = document.querySelector(".connected-header")?.getBoundingClientRect().bottom ?? 0;
      const barTop = () => Math.min(actions.getBoundingClientRect().top, innerHeight);
      const box = radio.getBoundingClientRect();
      const want = spot === "top" ? header + 24 : spot === "middle" ? (header + barTop() - box.height) / 2 : barTop() - shown;
      scroller.scrollTop += box.top - want;
      const now = radio.getBoundingClientRect(), top = Math.max(now.top, header), bottom = Math.min(now.bottom, barTop());
      if (bottom - top < 12) return null;
      const y = spot === "top" ? top + 6 : spot === "middle" ? (top + bottom) / 2 : bottom - gap;
      return { name: names[index]!, x: now.left + now.width / 2, y, shownAt: window.__quick!.shown.get(names[index]!) ?? performance.now() };
    },
    { names: options(n), spot, shown: 40 + ((n * 13) % 50), gap: 3 + (n % 7) },
    { polling: "raf", timeout: 10_000 },
  );
  return (await handle.jsonValue())!;
}

test("a tap on an option the moment a check appears always chooses it, also just above the answer actions", async ({ page, request }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await openQuickAnswers(page, request);
  await watchPresses(page);
  const touch = Boolean(info.project.use.hasTouch);
  const spots: Spot[] = ["edge", "top", "middle"];
  const lost: string[] = [], delays: number[] = [];
  for (let n = 1; n <= CHECKS; n++) {
    const start = page.getByRole("button", { name: "Start the next check →", exact: true });
    await page.evaluate(() => (window.__quick!.pressedAt = null));
    await start.click();
    const spot = spots[n % spots.length]!;
    const point = await spotAsSoonAsShown(page, n, spot);
    if (touch) await page.touchscreen.tap(point.x, point.y);
    else await page.mouse.click(point.x, point.y);
    delays.push(Math.round((await page.evaluate(() => window.__quick!.pressedAt ?? NaN)) - point.shownAt));
    const option = page.getByRole("radio", { name: point.name, exact: true });
    // A tap that registered shows at once; one that was lost never will.
    const taken = await expect(option).toHaveAttribute("aria-checked", "true", { timeout: 2_000 }).then(() => true, () => false);
    if (!taken) {
      lost.push(`check ${n}: ${spot} of "${point.name.slice(0, 24)}…" at y ${Math.round(point.y)}`);
      await option.click();
    }
    if (point.name !== options(n)[2]) await page.getByRole("radio", { name: options(n)[2], exact: true }).click();
    await page.getByRole("button", { name: "Check answer", exact: true }).click();
    await expect(start).toBeVisible();
  }
  info.annotations.push({ type: "ms from an option appearing to the tap", description: delays.join(", ") });
  expect(lost, `taps lost: ${lost.length} of ${CHECKS}`).toEqual([]);
  expect(errors).toEqual([]);
});

test("keyboard focus on an option under the answer actions is still scrolled clear of them", async ({ page, request }) => {
  await openQuickAnswers(page, request);
  await page.getByRole("button", { name: "Start the next check →", exact: true }).click();
  const last = page.getByRole("radio", { name: options(1)[2], exact: true });
  // Its top in view, the rest under the sticky actions.
  await last.evaluate((radio) => {
    const pane = document.querySelector<HTMLElement>(".connected-main");
    const scroller = pane && pane.scrollHeight > pane.clientHeight ? pane : document.scrollingElement!;
    const bar = document.querySelector(".connected-answer-actions")!.getBoundingClientRect();
    scroller.scrollTop += radio.getBoundingClientRect().top - (bar.top - 30);
  });
  await page.getByRole("radio", { name: options(1)[1], exact: true }).focus();
  await page.keyboard.press("ArrowDown");
  await expect(last).toBeFocused();
  await expect(last).toHaveAttribute("aria-checked", "true");
  const [box, bar] = [(await last.boundingBox())!, (await page.locator(".connected-answer-actions").boundingBox())!];
  expect(box.y + box.height).toBeLessThanOrEqual(bar.y + 1);
});
