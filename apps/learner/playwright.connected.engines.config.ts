import { defineConfig, devices } from "@playwright/test";
import base from "./playwright.connected.config";
// The learner-owned connected flows on Safari's engine (desktop, iPhone, iPad),
// against the same real API host and disposable database as the Chromium run.
export default defineConfig({
  ...base,
  // WebKit's first use on a machine is slow; pay it before the tests (see the file).
  globalSetup: "../../services/api/browser/warm-webkit.ts",
  use: { ...base.use, channel: undefined },
  projects: [
    { name: "webkit-desktop", use: { browserName: "webkit", viewport: { width: 1440, height: 960 } } },
    { name: "webkit-iphone", grepInvert: /@desktop-window/, use: { ...devices["iPhone 15"], browserName: "webkit" } },
    { name: "webkit-ipad", grepInvert: /@desktop-window/, use: { ...devices["iPad (gen 7)"], browserName: "webkit" } },
  ],
  outputDir: "./test-results/connected-webkit",
});
