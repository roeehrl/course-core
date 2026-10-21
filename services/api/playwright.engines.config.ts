import { defineConfig, devices } from '@playwright/test';
import base from './playwright.config.js';
// The same learner journeys on the other engines learners actually use:
// Safari's WebKit (desktop, iPhone, iPad) and Firefox desktop.
export default defineConfig({
  ...base,
  use: { ...base.use, channel: undefined },
  // Passkey journeys need Chromium's CDP virtual authenticator; the Chromium run covers them.
  testIgnore: ['**/passkey.spec.ts'],
  projects: [
    { name: 'webkit-desktop', use: { browserName: 'webkit', viewport: { width: 1440, height: 960 } } },
    { name: 'webkit-iphone', use: { ...devices['iPhone 15'], browserName: 'webkit' } },
    { name: 'webkit-ipad', use: { ...devices['iPad (gen 7)'], browserName: 'webkit' } },
    { name: 'firefox-desktop', use: { browserName: 'firefox', viewport: { width: 1440, height: 960 } } },
  ],
});
