import { defineConfig, devices } from "@playwright/test";
import { learnerWebPort } from "../../services/api/browser/ports";
// Fixed 4173 in CI; a free loopback port locally unless COURSE_LEARNER_WEB_PORT is set
// (COURSE_BROWSER_PORTS=fixed|free overrides the mode), so checkouts can run it at once.
const port = learnerWebPort();
const origin = `http://127.0.0.1:${port}`;

// Installed Chrome locally, Playwright's Chromium in CI. Set per Chromium
// project: a top-level channel would also apply to the WebKit project.
const channel = process.env.CI === "true" ? undefined : "chrome";
/** Specs that also run at tablet size and on WebKit at every size: overlays that must hold the
 * page still, and form controls that must look the same in every engine. */
const STILL_SPECS = /(scroll-keep|controls)\.spec\.ts/;
/** Overlays that must fit small phones (they set the phone sizes): Chromium and WebKit phones. */
const PHONE_SPECS = /sheet-fit\.spec\.ts/;

export default defineConfig({
  testDir: "./tests/web",
  outputDir: "./test-results/web",
  fullyParallel: true,
  workers: 2,
  reporter: "list",
  use: {
    baseURL: origin,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "node scripts/serve.mjs",
    url: origin,
    env: { COURSE_LEARNER_WEB_PORT: String(port) },
    reuseExistingServer: false,
  },
  projects: [
    {
      name: "desktop",
      testIgnore: PHONE_SPECS,
      use: { channel, viewport: { width: 1440, height: 960 } },
    },
    {
      name: "phone",
      use: {
        channel,
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      },
      testIgnore: /wide-scroll\.spec\.ts/,
    },
    // Wheel scrolling on wide screens, also on Safari's engine.
    {
      name: "webkit-wide",
      testMatch: /wide-scroll\.spec\.ts/,
      use: { browserName: "webkit", viewport: { width: 1920, height: 1080 } },
    },
    // Sheets and menus that must hold the page still and fit small screens.
    {
      name: "tablet",
      testMatch: STILL_SPECS,
      use: { channel, viewport: { width: 834, height: 1112 }, hasTouch: true },
    },
    {
      name: "webkit-desktop",
      testMatch: STILL_SPECS,
      use: { browserName: "webkit", viewport: { width: 1440, height: 960 } },
    },
    {
      name: "webkit-phone",
      testMatch: [STILL_SPECS, PHONE_SPECS],
      use: { ...devices["iPhone 15"], browserName: "webkit" },
    },
    {
      name: "webkit-tablet",
      testMatch: STILL_SPECS,
      use: { ...devices["iPad (gen 7)"], browserName: "webkit" },
    },
  ],
});
