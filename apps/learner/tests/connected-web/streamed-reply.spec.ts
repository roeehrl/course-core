import { test, expect } from "./health";

// A streamed companion reply in the real app, over the real event stream: the draft grows,
// is labelled as not yet checked, is kept out of the live announcements, and is withdrawn with
// a notice when the whole-answer checks refuse it. The model is scripted by the test host.
test("a streaming reply shows as an unchecked draft and a refused one is withdrawn", async ({ page, request }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const token = (await (await request.post("/test/session")).json()).token;
  await page.goto(`/#signin=${token}`);
  await page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Ordering values", exact: true }) })
    .getByRole("button", { name: "Open course", exact: true }).click();
  await page.getByRole("button", { name: "Start course", exact: true }).click();
  await page.getByRole("button", { name: /^(Start the course|Start lesson \d+|Continue lesson \d+|Continue learning) →$/ }).click();
  if (!info.project.name.endsWith("desktop")) await page.getByRole("button", { name: "Companion", exact: true }).click();
  const draft = page.getByRole("textbox", { name: "Message to your companion", exact: true });
  const drafts = page.getByLabel("Reply being written, not yet checked");
  for (const [index, question, end] of [[0, `Streamed question ${Date.now()}`, "complete"], [1, `Refused question ${Date.now()}`, "withdrawn"]] as const) {
    await draft.fill(question);
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    // Read from the saved conversation: while it sends, the (read-only) box still holds the same text.
    await expect(page.getByRole("log", { name: "Saved companion messages" }).getByText(question, { exact: true })).toBeVisible();
    // The question is saved by the time the host can find it; then the scripted model plays.
    await expect.poll(async () => (await (await request.post("/test/companion-draft", { data: { question,
      pieces: ["Picture both values on a number line. ", "The one farther left ", "is smaller."], end, gapMs: 250 } })).json()).reason ?? "opened").toBe("opened");
    const region = drafts.nth(index);
    await expect(region).toContainText("Picture both values on a number line.");
    await expect(region).toHaveAttribute("aria-live", "off");
    await expect(page.getByRole("status").filter({ hasText: "Writing a reply" })).toBeVisible();
    if (end === "complete") {
      await expect(region).toContainText("Picture both values on a number line. The one farther left is smaller.");
      await expect(region).toContainText("checking it before it is kept");
    } else {
      // Said once, by the question's label: why it was not shown.
      await expect(page.getByText("Reply not shown · it did not pass the checks, so nothing of it was kept", { exact: true })).toBeVisible();
      // Only the first (completed) draft is left; the withdrawn one kept no text.
      await expect(drafts).toHaveCount(1);
    }
  }
  // The draft view fits the companion at this size without sideways scrolling.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  expect(errors).toEqual([]);
});
