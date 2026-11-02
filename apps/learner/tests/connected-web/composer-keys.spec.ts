import { nextControlKey, test, expect } from "./health";
import { box, roundButton, settled, startLesson, thread } from "./conversation-helpers";
import { closeCompanion, openCompanion } from "./companion-helpers";
import heAsk from "../../src/i18n/messages/he/askCompanionButton.json";

/*
 * The composer's keys in a real browser (final design §3.6, §5; the owner's "you can't press Enter
 * or Cmd+Enter to send"): Enter sends with a mouse and keyboard, Shift+Enter makes a line,
 * Cmd/Ctrl+Enter sends everywhere, a touch keyboard's Enter makes a line; focus stays in the box
 * after a send and after the reply; the box grows to its limit, then scrolls; in Hebrew the round
 * button sits at the bottom left; and the composer's own Tab order. Replies are stored by the test
 * host; no model is involved.
 */
test("Enter, Cmd+Enter and Ctrl+Enter send, Shift+Enter makes a line, and focus stays in the box", async ({ page, request }) => {
  await startLesson(page, request);
  // A touch keyboard (phone, tablet, iPhone, iPad), not the project's name: "webkit-desktop" has a
  // fine pointer too.
  const touch = await page.evaluate(() => matchMedia("(pointer: coarse)").matches);
  const field = box(page);
  await field.click();
  await field.pressSequentially("Which is smaller");
  await field.press("Shift+Enter");
  await field.pressSequentially("two or three?");
  await expect(field).toHaveValue("Which is smaller\ntwo or three?");
  const saved = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname.endsWith("/companion"));
  if (touch) {
    // A touch keyboard's Enter is a new line; the hardware chord still sends.
    await field.press("Enter");
    await expect(field).toHaveValue("Which is smaller\ntwo or three?\n");
    await field.press("Backspace");
    await field.press("Control+Enter");
  } else await field.press("Enter");
  expect((await saved).status()).toBe(200);
  const first = thread(page).locator(".cc-chat-bubble").filter({ hasText: "Which is smaller" });
  await expect(first).toBeVisible();
  await expect(field).toHaveValue("");
  await expect(field).toBeFocused();
  // A reply is on its way: Enter does nothing more, and the box stays editable.
  await field.pressSequentially("Next");
  await field.press(touch ? "Control+Enter" : "Enter");
  await expect(thread(page).locator(".cc-chat-bubble")).toHaveCount(1);
  await expect(field).toHaveValue("Next");
  expect((await (await request.post("/test/companion-job", { data: { question: "Which is smaller\ntwo or three?", state: "applied", answer: "Two is smaller than three." } })).json()).updated).toBe(true);
  await expect(thread(page).getByText("Two is smaller than three.", { exact: true })).toBeVisible({ timeout: 15_000 });
  // Focus stayed in the box while the reply arrived.
  await expect(field).toBeFocused();
  await field.fill("And four?");
  await field.press("Meta+Enter");
  await expect(thread(page).locator(".cc-chat-bubble").filter({ hasText: "And four?" })).toBeVisible();
  await expect.poll(async () => (await (await request.post("/test/companion-job", { data: { question: "And four?", state: "applied", answer: "Four is larger." } })).json()).updated).toBe(true);
  await expect(thread(page).getByText("Four is larger.", { exact: true })).toBeVisible({ timeout: 15_000 });
  // A tap on the round button (a click with a mouse) keeps the focus in the box as well: left on
  // the button, which turns into Stop, a second tap would stop the reply (§3.5, §6).
  await field.fill("And five?");
  await (touch ? roundButton(page).tap() : roundButton(page).click());
  await expect(thread(page).locator(".cc-chat-bubble").filter({ hasText: "And five?" })).toBeVisible();
  await expect(field).toBeFocused();
});

test("the box grows to its line limit, then scrolls inside", async ({ page, request }, info) => {
  await startLesson(page, request);
  const field = box(page);
  const line = await field.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight));
  await field.fill("one");
  const single = (await field.boundingBox())!.height;
  await field.fill(Array.from({ length: 3 }, (_, i) => `line ${i + 1}`).join("\n"));
  expect((await field.boundingBox())!.height).toBeGreaterThan(single + line * 1.5);
  await field.fill(Array.from({ length: 14 }, (_, i) => `line ${i + 1}`).join("\n"));
  // 8 lines in a panel (216 px), 5 on a phone (140 px).
  const limit = ["phone", "webkit-iphone"].includes(info.project.name) ? 140 : 216;
  const tall = (await field.boundingBox())!.height;
  expect(tall).toBeLessThanOrEqual(limit + 1);
  expect(tall).toBeGreaterThan(limit * 0.6);
  expect(await field.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  await page.screenshot({ path: info.outputPath("grown.png") });
});

test("in Hebrew the round button sits at the bottom left of the pill, and an attachment comes before the box in Tab order", async ({ page, request, browserName }) => {
  await startLesson(page, request, { locale: "he" });
  const field = box(page);
  await field.fill("שאלה ראשונה\nושורה שנייה\nושלישית");
  // Measured where the sheet rests (it slides in and grows to full height on a tablet), and all
  // three boxes from one frame.
  await settled(page);
  const { pill, button, text } = await page.evaluate(() => {
    const rect = (selector: string) => {
      const { x, y, width, height } = document.querySelector(`#connected-companion ${selector}`)!.getBoundingClientRect();
      return { x, y, width, height };
    };
    return { pill: rect(".cc-chat-pill"), button: rect(".cc-chat-send"), text: rect(".cc-chat-pill textarea") };
  });
  expect(button.x).toBeLessThan(text.x);
  expect(button.x - pill.x).toBeLessThan(16);
  expect(pill.y + pill.height - (button.y + button.height)).toBeLessThan(12);
  // A lesson selection attaches to the next message as a chip inside the pill once "Ask companion"
  // is pressed (made with the companion closed, where the phone sheet would cover the lesson).
  await closeCompanion(page, "he");
  await page.evaluate(() => {
    const walker = document.createTreeWalker(document.querySelector("[data-reading-part]")!, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.textContent?.indexOf("member") ?? -1;
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + "member".length);
      document.getSelection()!.removeAllRanges();
      document.getSelection()!.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
      return;
    }
  });
  await page.getByRole("button", { name: heAsk.label, exact: true }).click();
  await openCompanion(page);
  const remove = page.locator(".cc-chat-attachment button");
  await expect(remove).toBeVisible();
  await field.focus();
  await page.keyboard.press(nextControlKey(browserName, true));
  await expect(remove).toBeFocused();
  await page.keyboard.press(nextControlKey(browserName));
  await expect(field).toBeFocused();
  await page.keyboard.press(nextControlKey(browserName));
  await expect(roundButton(page)).toBeFocused();
});
