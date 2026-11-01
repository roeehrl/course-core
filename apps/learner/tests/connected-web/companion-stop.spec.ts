import { test, expect } from "./health";
import { announcer, ask, box, roundButton, startLesson, thread, resumeLesson } from "./conversation-helpers";
import { companionPanel, openCompanion } from "./companion-helpers";

/*
 * The learner's Stop (final design §3.5, Q10): pressing the round button (or Esc in the box) while
 * a reply streams stops it; the text that was on screen stays, muted, with "This part wasn't
 * checked, so it won't be saved." Nothing of it is stored: the saved conversation has no reply, and
 * after a reload only "You stopped this reply." remains. The call was sent (its job had a call in
 * flight), so this is a stop after sending, never a cancelled question. Scripted by the test host.
 */
async function enrollmentId(page: import("@playwright/test").Page) {
  const enrollments = (await (await page.request.get("/api/enrollments")).json()) as { id: string; title: string }[];
  return enrollments.find((row) => row.title === "Ordering values")!.id;
}
const pieces = Array.from({ length: 30 }, (_, i) => `Part ${i + 1} of the reply. `);

for (const how of ["the round button", "Esc"] as const)
  test(`stopping with ${how} keeps the partial text muted, stores nothing, and after a reload says only that it stopped`, async ({ page, request }, info) => {
    await startLesson(page, request);
    const question = `Stop me ${how} ${Date.now()}`;
    await ask(page, question);
    await expect.poll(async () => (await (await request.post("/test/conversation-dispatch", { data: { question, pieces, gapMs: 400 } })).json()).opened).toBe(true);
    const row = thread(page).locator('[data-reply-state="streaming"]');
    await expect(row).toContainText("Part 2 of the reply.", { timeout: 15_000 });
    await expect(roundButton(page)).toHaveAccessibleName("Stop reply");
    if (how === "Esc") {
      await box(page).click();
      await box(page).fill("Keep this draft");
      await box(page).press("Escape");
      // The sheet of today's dock also closes on Esc; the shell's panel decides after the box
      // handled it (bridge.ts "Esc chain"). Either way the reply was stopped.
      await openCompanion(page);
    } else await roundButton(page).click();
    const stopped = thread(page).locator('[data-reply-state="stopped"]');
    await expect(stopped).toBeVisible();
    await expect(stopped).toContainText("You stopped this reply. This part wasn't checked, so it won't be saved.");
    const muted = stopped.locator(".cc-chat-prose.is-muted");
    await expect(muted).toContainText("Part 1 of the reply.");
    const shown = await muted.textContent();
    // The muted text does not keep growing once stopped.
    await page.waitForTimeout(1200);
    expect(await muted.textContent()).toBe(shown);
    await expect(announcer(page)).toHaveText("Reply stopped");
    await expect(roundButton(page)).toHaveAccessibleName("Send");
    if (how === "Esc") await expect(box(page)).toHaveValue("Keep this draft");
    await expect(stopped.getByRole("button", { name: "Ask again" })).toBeVisible();
    await page.screenshot({ path: info.outputPath(`stopped-${how === "Esc" ? "esc" : "button"}.png`) });
    // Nothing of the reply was stored.
    const saved = (await (await page.request.get(`/api/enrollments/${await enrollmentId(page)}/companion`)).json()) as { messages: { role: string; content: string; job_state: string | null; job_sent: boolean | null }[] };
    expect(saved.messages.filter((m) => m.role === "assistant")).toHaveLength(0);
    expect(saved.messages.find((m) => m.content === question)).toMatchObject({ job_state: "cancelled", job_sent: true });
    expect(JSON.stringify(saved)).not.toContain("Part 1 of the reply.");
    // After a reload only the line remains.
    await page.reload();
    await resumeLesson(page);
    await openCompanion(page);
    const after = companionPanel(page).getByRole("log").locator('[data-reply-state="stopped"]');
    await expect(after).toContainText("You stopped this reply.");
    await expect(after).not.toContainText("wasn't checked");
    await expect(after).not.toContainText("Part 1 of the reply.");
  });

test("Stop pressed while the question is still being sent cancels it once it is saved, and its text goes back to the box", async ({ page, request }) => {
  await startLesson(page, request);
  // The send's answer is slow, so Stop comes before it: the cancel waits for the send and must
  // then use the revision the send moved on to (never a stale one).
  await page.route(/\/companion$/, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const response = await route.fetch();
    await new Promise((resolve) => setTimeout(resolve, 800));
    await route.fulfill({ response });
  });
  const question = `Stop while sending ${Date.now()}`;
  await box(page).fill(question);
  await roundButton(page).click();
  await expect(thread(page).getByText(question, { exact: true })).toBeVisible();
  await expect(roundButton(page)).toHaveAccessibleName("Stop reply");
  const cancelled = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname.endsWith("/cancel"));
  await roundButton(page).click();
  expect((await cancelled).status()).toBe(200);
  await expect(box(page)).toHaveValue(question);
  await expect(thread(page).getByText(question, { exact: true })).toHaveCount(0, { timeout: 15_000 });
  await expect(thread(page).getByText("Couldn't stop the reply. Try again, or delete the question.")).toHaveCount(0);
  await expect(announcer(page)).toHaveText("Question cancelled. Your text is back in the box.");
  await expect(roundButton(page)).toHaveAccessibleName("Send");
});
