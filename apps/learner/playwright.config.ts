import { defineConfig } from "@playwright/test";
import { learnerWebPort } from "../../services/api/browser/ports";
// Fixed 4173 in CI; a free loopback port locally unless COURSE_LEARNER_WEB_PORT is set
// (COURSE_BROWSER_PORTS=fixed|free overrides the mode), so checkouts can run it at once.
const port = learnerWebPort();
const origin = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./tests/web",
  outputDir: "./test-results/web",
  fullyParallel: true,
  workers: 2,
  reporter: "list",
  use: {
    baseURL: origin,
    channel: process.env.CI === "true" ? undefined : "chrome",
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
    { name: "desktop", use: { viewport: { width: 1440, height: 960 } } },
    {
      name: "phone",
      use: {
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
});
