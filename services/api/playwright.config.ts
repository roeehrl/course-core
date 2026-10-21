import { defineConfig } from '@playwright/test';
import { browserPorts } from './browser/ports.js';
// Fixed 4317/4318 in CI; free loopback ports locally unless COURSE_BROWSER_PORT /
// COURSE_BROWSER_PASSKEY_PORT are set (see browser/ports.ts). Workers inherit the choice.
const { port, passkeyPort } = browserPorts();
const origin = `http://127.0.0.1:${port}`;
export default defineConfig({
  testDir: './browser', testMatch: '*.spec.ts', fullyParallel: false, workers: 1,
  use: { baseURL: origin, channel: process.env.CI === 'true' ? undefined : 'chrome', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: { command: 'npx tsx browser/start.ts', url: `${origin}/health`, reuseExistingServer: false, timeout: 30000,
    env: { COURSE_BROWSER_PORT: String(port), COURSE_BROWSER_PASSKEY_PORT: String(passkeyPort) } },
  // The renderer health check (Chromium's DevTools protocol) runs once, on the phone project;
  // CI refuses runtime skips, so the other projects leave it out here.
  projects: [{ name: 'desktop', testIgnore: '**/renderer-health.spec.ts', use: { viewport: { width: 1440, height: 960 } } }, { name: 'phone', use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } }, { name: 'tablet', testIgnore: '**/renderer-health.spec.ts', use: { viewport: { width: 834, height: 1112 }, hasTouch: true } }],
});
