import { test as base, expect } from "@playwright/test";
import { recordRendererHealth, watchRenderer } from "../../../../services/api/browser/renderer-health";

/** Every connected learner test: when one fails in Chromium, the report says whether the
 * page's renderer still answered and, if not, whether its own script was the cause
 * (services/api/browser/renderer-health.ts). A failure with a live renderer is the app's or
 * the test's, not the machine's. */
export const test = base.extend<{ rendererHealth: void; companionPane: "open" | "default"; companionPaneSetup: void }>({
  /** The companion pane beside a lesson starts collapsed until the learner opens it, and that
   * choice is remembered on the device. Suites about the companion's own behaviour start as a
   * learner who opened it beside the lesson in an expanded window before ("open");
   * tests/connected-web/roadmap.spec.ts checks the first-visit default ("default"). */
  companionPane: ["open", { option: true }],
  companionPaneSetup: [
    async ({ page, companionPane }, use) => {
      if (companionPane === "open")
        await page.addInitScript(() => {
          try {
            // As the pane used to start: open beside the lesson in an expanded window only.
            if (Math.min(window.innerWidth, window.screen.width) >= 840 && !window.localStorage.getItem("course:learner-companion-pane"))
              window.localStorage.setItem("course:learner-companion-pane", "open");
          } catch {
            /* storage unavailable: the default applies */
          }
        });
      await use();
    },
    { auto: true },
  ],
  rendererHealth: [
    async ({ page }, use, testInfo) => {
      await watchRenderer(page);
      await use();
      await recordRendererHealth(page, testInfo);
    },
    { auto: true },
  ],
});
export { expect };
export type { Locator, Page } from "@playwright/test";
