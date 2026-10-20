import { defineConfig } from "@playwright/test";
import { adminRealPort } from "../../services/api/browser/ports";
// Fixed 4384 in CI; a free loopback port locally unless COURSE_ADMIN_REAL_PORT is set
// (COURSE_BROWSER_PORTS=fixed|free overrides the mode),
// so real-API suites in separate checkouts can run at the same time.
const port = adminRealPort();
const origin = `http://127.0.0.1:${port}`;
export default defineConfig({
  testDir: "./tests/real",
  outputDir: "./test-results/real",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: origin,
    channel: process.env.CI === "true" ? undefined : "chrome",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "../../services/api/node_modules/.bin/tsx scripts/real-server.ts",
    url: `${origin}/health`,
    env: { COURSE_ADMIN_REAL_PORT: String(port) },
    reuseExistingServer: false,
    timeout: 30000,
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1440, height: 1000 } } },
    {
      name: "phone",
      use: {
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: "tablet",
      use: { viewport: { width: 834, height: 1112 }, hasTouch: true },
    },
  ],
});
