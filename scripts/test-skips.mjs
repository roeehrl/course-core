import { spawn } from 'node:child_process';
import { ensure } from './modules.mjs';
import { isMain } from './is-main.mjs';

// PR and release CI fail on a test-level skip. A test that does not apply to a browser
// project or engine is excluded in that Playwright config (grepInvert/testIgnore), where
// review sees it, rather than skipped at run time. Nightly suites use nightly.mjs no-skips.

const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;
const MAX_LINE = 64 * 1024;

/** Reads test-runner summaries from output as it streams, keeping only counts (bounded memory).
 * node:test (spec `ℹ` or TAP `#`), Vitest (`Tests  3 passed | 1 skipped (4)`, `Test Files …`)
 * and Playwright's list/line/dot reporters (`  2 skipped`, `  1 did not run`). */
export class SkipScanner {
  summaries = 0;
  skipped = 0;
  todo = 0;
  notRun = 0;
  #partial = '';
  push(chunk) {
    const lines = (this.#partial + chunk).split(/\r?\n/);
    this.#partial = lines.pop().slice(-MAX_LINE);
    for (const line of lines) this.#line(line);
  }
  end() { if (this.#partial) this.#line(this.#partial); this.#partial = ''; return this.result(); }
  result() { return { summaries: this.summaries, skipped: this.skipped, todo: this.todo, notRun: this.notRun }; }
  #line(raw) {
    const line = raw.replace(ANSI, '').trim();
    let match = /^(?:ℹ|#) (tests|skipped|todo) (\d+)$/.exec(line);
    if (match) {
      if (match[1] === 'tests') this.summaries++;
      else this[match[1]] += Number(match[2]);
      return;
    }
    match = /^(Tests|Test Files)\s+(.+?)\s*\(\d+\)$/.exec(line);
    if (match) {
      // Tests in a skipped file are also counted on the Tests line.
      if (match[1] === 'Tests') {
        this.summaries++;
        for (const [, count, kind] of match[2].matchAll(/(\d+) (skipped|todo)\b/g)) this[kind] += Number(count);
      }
      return;
    }
    match = /^(\d+) (passed|skipped|did not run|flaky)(?: \(.*\))?$/.exec(line);
    if (match) {
      if (match[2] === 'passed') this.summaries++;
      else if (match[2] === 'skipped') this.skipped += Number(match[1]);
      else if (match[2] === 'did not run') this.notRun += Number(match[1]);
    }
  }
}

/** Throws unless a runner summary was seen and nothing was skipped, left as todo or not run. */
export function requireNothingSkipped(result, label = 'test command') {
  ensure(result.summaries > 0, `${label}: no test runner summary found, so skips cannot be ruled out`);
  ensure(result.skipped === 0 && result.todo === 0 && result.notRun === 0,
    `${label}: ${result.skipped} skipped, ${result.todo} todo and ${result.notRun} not-run tests. PR and release CI do not allow test-level skips; ` +
    'exclude a test that does not apply to a browser project in that Playwright config instead');
}

/** Runs a command with inherited stdin, forwarding its output while scanning it. */
export function runScanned(command, args, options = {}) {
  const scanner = new SkipScanner();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['inherit', 'pipe', 'pipe'] });
    options.onChild?.(child);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { process.stdout.write(chunk); scanner.push(chunk); });
    child.stderr.on('data', chunk => { process.stderr.write(chunk); scanner.push(chunk); });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, ...scanner.end() }));
  });
}

export async function testSkipsMain(args = process.argv.slice(2)) {
  ensure(args[0] === '--' && args.length >= 2, 'Use: node scripts/test-skips.mjs -- <test command> [arguments]');
  const [command, ...rest] = args.slice(1);
  const result = await runScanned(command, rest, { shell: false });
  const label = [command, ...rest].join(' ');
  if (result.code !== 0) { console.error(`${label} failed (${result.signal ?? result.code})`); process.exitCode = result.code || 1; return result; }
  requireNothingSkipped(result, label);
  console.log(`No skipped tests in ${result.summaries} runner summar${result.summaries === 1 ? 'y' : 'ies'}.`);
  return result;
}
if (isMain(import.meta.url)) testSkipsMain().catch(error => { console.error(error.message); process.exitCode = 1; });
