// The parts of Playwright's Page, CDPSession and TestInfo this file uses, written out so it
// imports no package: the learner app's connected tests import it from outside services/api,
// and the learner CI job installs only the learner's dependencies, so `@playwright/test` does
// not resolve from here there (renderer-health-imports.test.ts keeps it that way).
interface DevToolsSession {
  send(method: "Runtime.evaluate", params: { expression: string; returnByValue: boolean }): Promise<unknown>;
  send(method: "Runtime.terminateExecution"): Promise<unknown>;
  detach(): Promise<void>;
}
interface Page {
  context(): { browser(): { browserType(): { name(): string } } | null; newCDPSession(page: never): Promise<DevToolsSession> };
  isClosed(): boolean;
}
type TestStatus = "passed" | "failed" | "timedOut" | "skipped" | "interrupted";
interface FinishedTest {
  status?: TestStatus;
  expectedStatus: TestStatus;
  annotations: { type: string; description?: string }[];
  attach(name: string, options: { body: string; contentType: string }): Promise<void>;
}

const NO_ANSWER: unique symbol = Symbol("no answer");
type NoAnswer = typeof NO_ANSWER;
const within = <T>(work: Promise<T>, ms: number): Promise<T | NoAnswer> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race<T | NoAnswer>([
    work.catch((): NoAnswer => NO_ANSWER),
    new Promise<NoAnswer>((resolve) => (timer = setTimeout(() => resolve(NO_ANSWER), ms))),
  ]).finally(() => clearTimeout(timer));
};

const sessions = new WeakMap<Page, DevToolsSession>();

/** Opens the DevTools session the health check uses. It must exist before the page
 * stops answering: attaching a new session needs the renderer's main thread. No
 * DevTools domain is enabled, so it does not change how the page runs. */
export async function watchRenderer(page: Page) {
  if (page.context().browser()?.browserType().name() === "chromium")
    sessions.set(page, await page.context().newCDPSession(page as never));
}

/** After a failed Chromium test, records whether the page's renderer still answers.
 *
 * A fill once timed out with no retry in its call log, no failure screenshot and no
 * page snapshot: the page answered nothing for 30 seconds, while the DOM captured
 * just before showed an enabled, editable field. That is a renderer that stopped
 * answering, not a field that was disabled or covered, and the trace alone cannot
 * say why. So when a page stops answering, this finds out which: if stopping its
 * running script brings it back, the page was stuck in its own JavaScript (a loop
 * to fix in the app); if not, its main thread was blocked outside JavaScript (the
 * browser or the machine). A page that still answers gets nothing extra: that
 * failure is an ordinary one. */
export async function recordRendererHealth(
  page: Page,
  testInfo: FinishedTest,
) {
  const cdp = sessions.get(page);
  if (!cdp) return;
  sessions.delete(page);
  const answers = () => within(cdp.send("Runtime.evaluate", { expression: "document.readyState", returnByValue: true }), 2_000);
  try {
    if (testInfo.status === testInfo.expectedStatus || page.isClosed()) return;
    if ((await answers()) !== NO_ANSWER) return;
    // Handled off the main thread, so it reaches even a script that never yields.
    await within(cdp.send("Runtime.terminateExecution"), 2_000);
    const finding = (await answers()) !== NO_ANSWER
      ? "The page stopped answering because its own JavaScript never yielded; stopping that script brought it back. Look for a loop in the app."
      : "The page stopped answering and stopping its JavaScript did not help: its main thread was blocked outside JavaScript (browser or machine), not by the app's code.";
    testInfo.annotations.push({ type: "renderer unresponsive", description: finding });
    await testInfo.attach("renderer-health", { body: finding, contentType: "text/plain" });
  } finally {
    await within(cdp.detach(), 1_000);
  }
}
