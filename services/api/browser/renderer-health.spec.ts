import { expect, test } from "@playwright/test";
import { recordRendererHealth, watchRenderer } from "./renderer-health.js";

// The check uses Chromium's DevTools protocol; one Chromium project is enough to test it, so
// playwright.config.ts runs this file on the phone project only (CI refuses runtime skips).

/** A stand-in for a failed test's info, so the check runs inside a passing test. */
function failedTest() {
  const attached: { name: string; body: string }[] = [];
  return {
    attached,
    info: {
      status: "timedOut" as const,
      expectedStatus: "passed" as const,
      annotations: [] as { type: string; description?: string }[],
      attach: async (name: string, options: { body?: string | Buffer }) => void attached.push({ name, body: String(options.body) }),
    },
  };
}

test("a failed test whose page is stuck in its own script is reported as a loop in the app", async ({ page }) => {
  await watchRenderer(page);
  await page.setContent(`<input aria-label="Answer"><script>function spin() { for (;;) {} }</script>`);
  await page.evaluate(() => void setTimeout(() => (window as unknown as { spin(): void }).spin(), 0));
  // From here the page cannot answer: the evaluation never returns while it spins.
  const stuck = await Promise.race([
    page.evaluate(() => "answered").catch(() => "closed"),
    new Promise((resolve) => setTimeout(() => resolve("no answer"), 1_000)),
  ]);
  expect(stuck).toBe("no answer");
  const { info, attached } = failedTest();
  await recordRendererHealth(page, info);
  expect(info.annotations).toEqual([{ type: "renderer unresponsive", description: expect.stringMatching(/its own JavaScript never yielded/) }]);
  expect(attached.map((a) => a.name)).toEqual(["renderer-health"]);
  // Stopping the script brought the page back.
  await page.getByRole("textbox", { name: "Answer" }).fill("7");
  await expect(page.getByRole("textbox", { name: "Answer" })).toHaveValue("7");
});

test("a failed test whose page still answers, or a passing test, gets no renderer finding", async ({ page }) => {
  await watchRenderer(page);
  await page.setContent(`<input aria-label="Answer" disabled>`);
  const failed = failedTest();
  await recordRendererHealth(page, failed.info);
  expect(failed.info.annotations).toEqual([]);
  expect(failed.attached).toEqual([]);
  await watchRenderer(page);
  const passed = failedTest();
  await recordRendererHealth(page, { ...passed.info, status: "passed" });
  expect(passed.info.annotations).toEqual([]);
});
