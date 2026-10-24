// Global setup for the configs that run WebKit: pays WebKit's once-per-machine start-up cost
// before the first test instead of inside it.
//
// On a fresh Linux machine WebKit builds caches under ~/.cache the first time it is used: the
// GStreamer plugin registry when it launches and Mesa's software-GL shader cache when it first
// draws a page. Until they exist, opening and drawing the first page is slow; every later
// browser on the same machine is fast. In CI the first WebKit test of a job ran 2-12 s longer
// than the same test in the next WebKit project on the same runner, and once (PR #218, run
// 40130987928) the first page took 28 s to open, so the first test (activity-hints) had less
// than a second of its 30 s timeout left for its own steps. Playwright counts the page fixture
// against the test's timeout; global setup runs before any test, outside those timeouts.
//
// It imports no package: the learner app's configs use it too, and the learner CI job installs
// only the learner's dependencies. The WebKit launcher is the one from the Playwright that runs
// the config.
import { createRequire } from "node:module";
import { join } from "node:path";

export interface WarmConfig {
  configFile?: string;
  rootDir: string;
  projects: { use: { browserName?: string } }[];
}
interface WarmPage {
  setContent(html: string): Promise<unknown>;
  click(selector: string, options: { timeout: number }): Promise<unknown>;
}
interface WarmBrowser {
  newPage(options: { viewport: { width: number; height: number } }): Promise<WarmPage>;
  close(): Promise<unknown>;
}
export interface WebKitLauncher {
  launch(options: { timeout: number }): Promise<WarmBrowser>;
}
export interface WarmOptions {
  /** The whole warm-up must finish within this; a WebKit that cannot open, draw and click
   * one page in two minutes would time out every test, so the run stops here instead. */
  limitMs?: number;
  log?: (line: string) => void;
}

const LIMIT_MS = 120_000;
const CLOSE_MS = 10_000;

async function within<T>(work: Promise<T>, ms: number, timedOut: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(timedOut()), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

export async function warmWebKit(config: WarmConfig, launcher: WebKitLauncher, options: WarmOptions = {}) {
  if (!config.projects.some((project) => project.use.browserName === "webkit")) return;
  const limitMs = options.limitMs ?? LIMIT_MS;
  const log = options.log ?? ((line: string) => console.log(line));
  const laps: string[] = [];
  let last = Date.now();
  const lap = (name: string) => {
    const now = Date.now();
    laps.push(`${name} ${now - last} ms`);
    last = now;
  };
  let browser = undefined as WarmBrowser | undefined;
  const warm = async () => {
    browser = await launcher.launch({ timeout: limitMs });
    lap("launch");
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    lap("first page");
    await page.setContent('<button type="button">Warm up</button>');
    await page.click("button", { timeout: limitMs });
    lap("first draw and click");
  };
  try {
    await within(warm(), limitMs, () => new Error(
      `WebKit did not open, draw and click a first page within ${limitMs} ms (${laps.join(", ") || "launch not finished"}).`,
    ));
  } finally {
    // Closed even when a step failed or hung, but a stuck browser does not hold the run: it is
    // killed with the test runner's process.
    if (browser) await within(browser.close(), CLOSE_MS, () => new Error("closing WebKit timed out")).catch(() => undefined);
  }
  log(`WebKit warm-up before the tests: ${laps.join(", ")}.`);
}

export default async function globalSetup(config: WarmConfig) {
  const require = createRequire(config.configFile ?? join(config.rootDir, "playwright.config.ts"));
  const { webkit } = require("@playwright/test") as { webkit: WebKitLauncher };
  await warmWebKit(config, webkit);
}
