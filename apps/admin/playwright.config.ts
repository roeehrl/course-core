import { defineConfig } from "@playwright/test";
import { adminWebPort } from "../../services/api/browser/ports";
// Fixed 4174 in CI; a free loopback port locally unless COURSE_ADMIN_WEB_PORT is set
// (COURSE_BROWSER_PORTS=fixed|free overrides the mode), so checkouts can run it at once.
const port = adminWebPort();
const origin = `http://127.0.0.1:${port}`;
export default defineConfig({
  testDir: "./tests/web",
  outputDir: "./test-results/mock",
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
    command: `npx vite preview --host 127.0.0.1 --port ${port} --strictPort`,
    url: origin,
    reuseExistingServer: false,
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
  ],
});
