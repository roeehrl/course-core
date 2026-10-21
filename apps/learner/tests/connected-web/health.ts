import { test as base, expect } from "@playwright/test";
import { recordRendererHealth, watchRenderer } from "../../../../services/api/browser/renderer-health";

/** Every connected learner test: when one fails in Chromium, the report says whether the
 * page's renderer still answered and, if not, whether its own script was the cause
 * (services/api/browser/renderer-health.ts). A failure with a live renderer is the app's or
 * the test's, not the machine's. */
export const test = base.extend<{ rendererHealth: void }>({
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
