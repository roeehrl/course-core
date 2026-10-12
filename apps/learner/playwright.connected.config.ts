import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/connected-web",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:4317",
    channel: "chrome",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command:
      "node ../../services/api/node_modules/tsx/dist/cli.mjs ../../services/api/browser/start.ts",
    url: "http://127.0.0.1:4317/health",
    reuseExistingServer: false,
    timeout: 30000,
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
    {
      name: "tablet",
      use: { viewport: { width: 834, height: 1112 }, hasTouch: true },
    },
  ],
  outputDir: "./test-results/connected",
});
