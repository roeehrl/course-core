import { defineConfig } from "@playwright/test";
import { browserPorts } from "../../services/api/browser/ports";
// The API browser host's ports: fixed 4317/4318 in CI, free loopback ports locally
// unless COURSE_BROWSER_PORT / COURSE_BROWSER_PASSKEY_PORT are set.
const { port, passkeyPort } = browserPorts();
const origin = `http://127.0.0.1:${port}`;
export default defineConfig({
  testDir: "./tests/connected-web",
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
    command:
      "node ../../services/api/node_modules/tsx/dist/cli.mjs ../../services/api/browser/start.ts",
    url: `${origin}/health`,
    env: {
      COURSE_BROWSER_PORT: String(port),
      COURSE_BROWSER_PASSKEY_PORT: String(passkeyPort),
    },
    reuseExistingServer: false,
    timeout: 30000,
  },
  // Tests tagged @desktop-window set their own window sizes and run once, on desktop.
  // PR and release CI fail on a runtime skip, so the exclusion lives here.
  projects: [
    { name: "desktop", use: { viewport: { width: 1440, height: 960 } } },
    {
      name: "phone",
      grepInvert: /@desktop-window/,
      use: {
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: "tablet",
      grepInvert: /@desktop-window/,
      use: { viewport: { width: 834, height: 1112 }, hasTouch: true },
    },
  ],
  outputDir: "./test-results/connected",
});
