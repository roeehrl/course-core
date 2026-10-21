import { defineConfig } from "@playwright/test";

// Installed Chrome locally, Playwright's Chromium in CI. Set per Chromium
// project: a top-level channel would also apply to the WebKit project.
const channel = process.env.CI === "true" ? undefined : "chrome";

export default defineConfig({
  testDir: "./tests/web",
  outputDir: "./test-results/web",
  fullyParallel: true,
  workers: 2,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "node scripts/serve.mjs",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: false,
  },
  projects: [
    {
      name: "desktop",
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
  ],
});
