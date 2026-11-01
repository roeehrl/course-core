import { test, expect } from "./health";
import { ask, startLesson, stream, thread } from "./conversation-helpers";

// A streamed companion reply in the real app, over the real event stream (final design §3.5):
// the text replaces the preparing line in place and grows with a caret, is never in a live region
// and carries no "not yet checked" label; a reply the whole-answer checks refuse is replaced in
// place by why it was removed. The model is scripted by the test host.
test("a streaming reply grows in place with no unchecked label, and a refused one is replaced by why it was removed", async ({ page, request }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await startLesson(page, request);
  const log = thread(page);
  await expect(log).toHaveAttribute("aria-live", "off");
  for (const [question, end] of [[`Streamed question ${Date.now()}`, "complete"], [`Refused question ${Date.now()}`, "withdrawn"]] as const) {
    await ask(page, question);
    await stream(request, question, ["Picture both values on a number line. ", "The one farther left ", "is smaller."], { end, gapMs: 250 });
    const turn = log.locator(".cc-chat-item").filter({ hasText: question });
    if (end === "complete") {
      const row = turn.locator('[data-reply-state="streaming"]');
      await expect(row).toContainText("Picture both values on a number line. The one farther left is smaller.");
      await expect(page.getByText(/not yet checked|unchecked|not checked yet/)).toHaveCount(0);
      // Written and being checked: "Checking the reply…" after a second, under the text.
      await expect(row).toContainText("Checking the reply…");
      expect((await (await request.post("/test/companion-job", { data: { question, state: "applied", answer: "Picture both values on a number line. The one farther left is smaller." } })).json()).updated).toBe(true);
      await expect(turn.locator('[data-reply-state="streaming"]')).toHaveCount(0, { timeout: 15_000 });
    } else {
      const row = turn.locator('[data-reply-state="ended"]');
      await expect(row).toHaveText(/This reply was removed because it didn't pass the course's checks\./);
      // In place: none of the refused text stays.
      await expect(turn).not.toContainText("Picture both values");
    }
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  expect(errors).toEqual([]);
});
