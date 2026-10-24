import { describe, expect, it } from 'vitest';
import { warmWebKit, type WarmConfig, type WebKitLauncher } from '../browser/warm-webkit.js';

const webkitConfig: WarmConfig = { rootDir: '.', projects: [{ use: { browserName: 'webkit' } }, { use: { browserName: 'firefox' } }] };

function fakeWebKit(overrides: { launch?: () => Promise<void>; newPage?: () => Promise<void>; click?: () => Promise<void> } = {}) {
  const calls: string[] = [];
  const launcher: WebKitLauncher = {
    async launch(options) {
      calls.push(`launch ${options.timeout}`);
      await overrides.launch?.();
      return {
        async newPage(options) {
          calls.push(`newPage ${options.viewport.width}x${options.viewport.height}`);
          await overrides.newPage?.();
          return {
            async setContent(html) { calls.push(`setContent ${html}`); },
            async click(selector, options) { calls.push(`click ${selector} ${options.timeout}`); await overrides.click?.(); },
          };
        },
        async close() { calls.push('close'); },
      };
    },
  };
  return { launcher, calls };
}

describe('WebKit warm-up before the engines suites', () => {
  it('launches nothing for a config without a WebKit project', async () => {
    const { launcher, calls } = fakeWebKit();
    const lines: string[] = [];
    await warmWebKit({ rootDir: '.', projects: [{ use: { browserName: 'chromium' } }, { use: {} }] }, launcher, { log: (line) => lines.push(line) });
    expect(calls).toEqual([]);
    expect(lines).toEqual([]);
  });

  it('opens, draws and clicks one page, closes the browser and logs each step', async () => {
    const { launcher, calls } = fakeWebKit();
    const lines: string[] = [];
    await warmWebKit(webkitConfig, launcher, { limitMs: 5_000, log: (line) => lines.push(line) });
    expect(calls).toEqual([
      'launch 5000',
      'newPage 1440x960',
      'setContent <button type="button">Warm up</button>',
      'click button 5000',
      'close',
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^WebKit warm-up before the tests: launch \d+ ms, first page \d+ ms, first draw and click \d+ ms\.$/);
  });

  it('stops the run when the first page never opens, says how far it got and closes the browser', async () => {
    const { launcher, calls } = fakeWebKit({ newPage: () => new Promise<void>(() => {}) });
    const lines: string[] = [];
    const started = Date.now();
    await expect(warmWebKit(webkitConfig, launcher, { limitMs: 100, log: (line) => lines.push(line) }))
      .rejects.toThrow(/^WebKit did not open, draw and click a first page within 100 ms \(launch \d+ ms\)\.$/);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(calls).toEqual(['launch 100', 'newPage 1440x960', 'close']);
    expect(lines).toEqual([]);
  });

  it('reports a failed click and still closes the browser', async () => {
    const { launcher, calls } = fakeWebKit({ click: async () => { throw new Error('click failed'); } });
    await expect(warmWebKit(webkitConfig, launcher, { limitMs: 5_000, log: () => {} })).rejects.toThrow('click failed');
    expect(calls.at(-1)).toBe('close');
  });

  it('reports a browser that fails to launch, with nothing to close', async () => {
    const { launcher, calls } = fakeWebKit({ launch: async () => { throw new Error('executable missing'); } });
    await expect(warmWebKit(webkitConfig, launcher, { log: () => {} })).rejects.toThrow('executable missing');
    expect(calls).toEqual(['launch 120000']);
  });

  it('names the launch as unfinished when the launch itself hangs', async () => {
    const { launcher } = fakeWebKit({ launch: () => new Promise<void>(() => {}) });
    await expect(warmWebKit(webkitConfig, launcher, { limitMs: 50, log: () => {} }))
      .rejects.toThrow('WebKit did not open, draw and click a first page within 50 ms (launch not finished).');
  });
});
