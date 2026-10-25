import { defineConfig, devices } from "@playwright/test";
import { adminWebPort } from "../../services/api/browser/ports";
// Fixed 4174 in CI; a free loopback port locally unless COURSE_ADMIN_WEB_PORT is set
// (COURSE_BROWSER_PORTS=fixed|free overrides the mode), so checkouts can run it at once.
const port = adminWebPort();
const origin = `http://127.0.0.1:${port}`;
// Installed Chrome locally, Playwright's Chromium in CI. Set per Chromium project: a top-level
// channel would also apply to the WebKit projects.
const channel = process.env.CI === "true" ? undefined : "chrome";
/** Specs that also run at tablet size and on WebKit at every size: overlays that must hold the
 * page still, and form controls that must look the same in every engine. */
const STILL_SPECS = /(scroll-keep|controls)\.spec\.ts/;
/** Overlays that must fit small phones (they set the phone sizes): Chromium and WebKit phones. */
const PHONE_SPECS = /dialog-fit\.spec\.ts/;
export default defineConfig({
  testDir: "./tests/web",
  outputDir: "./test-results/mock",
  fullyParallel: true,
  workers: 2,
  reporter: "list",
  use: {
    baseURL: origin,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: `npx vite preview --host 127.0.0.1 --port ${port} --strictPort`,
    url: origin,
    reuseExistingServer: false,
  },
  projects: [
    {
      name: "desktop",
      testIgnore: PHONE_SPECS,
      use: { channel, viewport: { width: 1440, height: 1000 } },
    },
    // Tests tagged @desktop-window set their own window sizes and run once, on desktop.
    {
      name: "phone",
      grepInvert: /@desktop-window/,
      use: {
        channel,
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      },
    },
    // Overlays that must hold the page still and fit small screens, also at tablet size and on
    // Safari's engine (phone, tablet and desktop).
    {
      name: "tablet",
      testMatch: STILL_SPECS,
      use: { channel, viewport: { width: 834, height: 1112 }, hasTouch: true },
    },
    {
      name: "webkit-desktop",
      testMatch: STILL_SPECS,
      use: {
        browserName: "webkit",
        viewport: { width: 1440, height: 1000 },
      },
    },
    {
      name: "webkit-phone",
      testMatch: [STILL_SPECS, PHONE_SPECS],
      use: { ...devices["iPhone 15"], browserName: "webkit" },
    },
    {
      name: "webkit-tablet",
      testMatch: STILL_SPECS,
      use: {
        ...devices["iPad (gen 7)"],
        browserName: "webkit",
      },
    },
  ],
});
