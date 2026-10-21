// Tests for scripts/i18n-check.mjs. They need the TypeScript compiler API, so they are not part of
// `npm run test:infra`; CI runs them in the public source job under `npm exec --package=typescript@…`:
//   node --test scripts/i18n-check-tests.mjs
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { BASELINE_FILE, checkCatalogs, compareBaseline, formatBaseline, loadTypeScript, main, scanSource, unexplained } from './i18n-check.mjs';

const ts = loadTypeScript();
const scan = (text, filename = 'View.tsx') => scanSource(ts, filename, text);
const texts = (text, filename) => scan(text, filename).violations.map((violation) => violation.text);

test('flags JSX text, user-facing props, display helpers, user-facing object properties and defaults', () => {
  const found = texts(`
    export function View({ label = "Loading workspace…" }) {
      setError("Sign-out failed. Retry later.");
      const items = [{ id: "a", title: "Overview" }];
      return (
        <section aria-label="Learning content">
          <h1>Pick up where you left off.</h1>
          <Button label={busy ? "Saving…" : "Save"} placeholder={\`Search \${n} items\`} />
          <img alt="A diagram" />
          {ready ? "Ready" : null}
        </section>
      );
    }
    throw new Error("Open a lesson first");
  `);
  assert.deepEqual(found.sort(), [
    'A diagram', 'Learning content', 'Loading workspace…', 'Open a lesson first', 'Overview', 'Pick up where you left off.',
    'Ready', 'Save', 'Saving…', 'Search items', 'Sign-out failed. Retry later.',
  ].sort());
});

test('allows class names, test ids, keys, URLs, machine codes and non-visible strings', () => {
  assert.deepEqual(texts(`
    const key = "shell.nav.overview";
    console.warn("Something internal happened");
    throw new CourseApiError("INVALID_RESPONSE", 502);
    setStatus("idle");
    export const View = () => (
      <a className="nav-link active" href="https://example.org/a" data-testid="nav" id="main-content" key="x"
         title="nav-item" placeholder="name@example.org" role="button" type="submit" lang="he" dir="rtl">
        {t("shell.nav.overview")} · {count} → {"/"}
      </a>
    );
  `), []);
});

test('flags sentence-like strings anywhere, such as error maps and helper return values', () => {
  assert.deepEqual(texts(`
    const messages = { LOGIN_FAILED: "The username or password is incorrect.", BUSY: "Try again soon." };
    export function label(state) {
      if (state === "Not started yet") return "Waiting for a reviewer";
      return state;
    }
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const header = { "Content-Type": "application/json" };
    console.info("Loaded the course list");
  `, 'helpers.ts'), ['The username or password is incorrect.', 'Try again soon.', 'Waiting for a reviewer']);
});

test('flags locale-blind formatting', () => {
  assert.deepEqual(
    scan(`
      const a = new Date(x).toLocaleString();
      const b = new Intl.NumberFormat("en-US").format(1);
      const c = new Intl.DateTimeFormat(undefined, {}).format(d);
      const ok = new Intl.NumberFormat(i18n.lang).format(1);
    `, 'helpers.ts').violations.map((violation) => violation.text),
    ['toLocaleString', 'Intl.NumberFormat', 'Intl.DateTimeFormat'],
  );
});

test('an i18n-ignore with a reason suppresses one line; without a reason it is an error', () => {
  const ignored = scan(`
    export const View = () => (
      <span>
        {/* i18n-ignore: product name, not translated */}
        Course Core
        <b>Visible text</b>
      </span>
    );
    // i18n-ignore: developer diagnostic, never shown
    throw new Error("Unexpected receipt shape");
  `);
  assert.deepEqual(ignored.violations.map((violation) => violation.text), ['Visible text']);
  assert.deepEqual(ignored.errors, []);
  const missing = scan(`
    // i18n-ignore
    export const View = () => <p>Hello there</p>;
  `);
  assert.match(missing.errors[0], /needs a reason/);
  assert.deepEqual(missing.violations.map((violation) => violation.text), ['Hello there']);
  assert.deepEqual(scan(`// i18n-ignore-file: developer-only debug page\nexport const V = () => <p>Debug</p>;`).violations, []);
});

test('the baseline fails on increases and new files and asks to shrink on decreases', () => {
  const { increased, decreased } = compareBaseline({ 'src/a.tsx': 3, 'src/new.tsx': 1, 'src/c.tsx': 1 }, { 'src/a.tsx': 2, 'src/b.tsx': 4, 'src/c.tsx': 5 });
  assert.deepEqual(increased, [
    { file: 'src/a.tsx', count: 3, allowed: 2 },
    { file: 'src/new.tsx', count: 1, allowed: 0 },
  ]);
  assert.deepEqual(decreased, [
    { file: 'src/c.tsx', count: 1, allowed: 5 },
    { file: 'src/b.tsx', count: 0, allowed: 4 },
  ]);
  const text = formatBaseline({ 'src/b.tsx': 2, 'src/a.tsx': 1 });
  assert.deepEqual(JSON.parse(text).files, { 'src/a.tsx': 1, 'src/b.tsx': 2 });
  // A blank line between entries lets parallel edits to different files merge without conflicts.
  assert.match(text, /"src\/a\.tsx": 1,\n\n {4}"src\/b\.tsx": 2\n/);
});

function fixture(files) {
  const root = mkdtempSync(path.join(tmpdir(), 'i18n-check-'));
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
  }
  return root;
}
const messages = 'apps/admin/src/i18n/messages';

test('catalogs: Hebrew must translate or list each key as pending, placeholders must match, no unused or stale keys', async () => {
  const root = fixture({
    [`${messages}/en/shell.json`]: { title: 'Hello {name}', count: '{n, plural, one {# item} other {# items}}', unused: 'Nobody uses this', dynamic: 'x', ok: 'Fine' },
    [`${messages}/he/shell.json`]: { title: 'שלום {person}', count: '{n, plural, one {פריט אחד} two {שני פריטים} other {# פריטים}}', stale: 'ישן', $pending: ['dynamic', 'unused', 'ok'], ok: 'בסדר' },
    [`${messages}/en/orphan.json`]: {},
    'apps/admin/src/View.tsx': 'export const V = () => <p>{t("shell.title")}{t("shell.count")}{t("shell.ok")}{t(`shell.dyn${"amic"}`)}</p>;',
  });
  try {
    const result = await checkCatalogs(ts, 'admin', root);
    const errors = result.errors.join('\n');
    assert.match(errors, /he\/shell\.json: "title" placeholders/);
    assert.match(errors, /he\/shell\.json: "stale" is not in the English catalog/);
    assert.match(errors, /he\/shell\.json: "ok" is translated; remove it from "\$pending"/);
    assert.match(errors, /he\/orphan\.json: missing/);
    assert.match(errors, /unused key "shell\.unused"/);
    assert.doesNotMatch(errors, /shell\.dynamic"/);
    assert.doesNotMatch(errors, /"count"/);
    assert.deepEqual(result.pending.sort(), ['he:shell.dynamic', 'he:shell.unused']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the CLI ratchet: new strings fail, --update lowers counts, a stale baseline fails until updated', async () => {
  const root = fixture({
    'apps/admin/src/View.tsx': 'export const V = () => <p>One string</p>;',
    [`${messages}/en/view.json`]: {},
    [`${messages}/he/view.json`]: {},
  });
  const run = async (...args) => {
    const lines = [];
    const code = await main(args, root, (line) => lines.push(line));
    return { code, out: lines.join('\n') };
  };
  try {
    await run('--sync');
    let result = await run();
    assert.equal(result.code, 1);
    assert.match(result.out, /apps\/admin\/src\/View\.tsx: 1 new hardcoded user-visible strings/);
    writeFileSync(path.join(root, 'apps/admin', BASELINE_FILE), formatBaseline({ 'src/View.tsx': 2 }, { 'src/View.tsx': 'a fixture string kept on purpose' }));
    result = await run();
    assert.equal(result.code, 1);
    assert.match(result.out, /down to 1 from 2\. Shrink the baseline: node scripts\/i18n-check\.mjs --update/);
    assert.equal((await run('--update')).code, 0);
    assert.deepEqual(JSON.parse(readFileSync(path.join(root, 'apps/admin', BASELINE_FILE), 'utf8')).files, { 'src/View.tsx': 1 });
    assert.equal((await run()).code, 0);
    writeFileSync(path.join(root, 'apps/admin/src/View.tsx'), 'export const V = () => <p>One string</p>;\nexport const W = () => <p>Another</p>;');
    result = await run('--update');
    assert.equal(result.code, 1);
    assert.match(result.out, /--update never raises a count/);
    writeFileSync(path.join(root, 'apps/admin/src/View.tsx'), 'export const V = () => <p>{t("view.x")}</p>;');
    // A key missing from the catalog is a TypeScript error in the app, not this check's concern.
    assert.equal((await run('--update')).code, 0);
    assert.deepEqual(JSON.parse(readFileSync(path.join(root, 'apps/admin', BASELINE_FILE), 'utf8')).files, { 'src/View.tsx': 0 });
    assert.equal((await run('--prune')).code, 0);
    assert.deepEqual(JSON.parse(readFileSync(path.join(root, 'apps/admin', BASELINE_FILE), 'utf8')).files, {});
    writeFileSync(path.join(root, 'apps/admin/src/i18n/catalog.ts'), '// edited by hand\n');
    assert.match((await run()).out, /catalog\.ts is stale or missing/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a file that keeps baselined strings must say why; reasons survive --update and go with the strings', async () => {
  assert.deepEqual(unexplained({ 'src/a.tsx': 2, 'src/b.tsx': 0, 'src/c.tsx': 1 }, { 'src/c.tsx': 'developer diagnostic, never shown' }), [{ file: 'src/a.tsx', count: 2 }]);
  assert.deepEqual(unexplained({ 'src/a.tsx': 2 }, { 'src/a.tsx': 'too short' }), [{ file: 'src/a.tsx', count: 2 }]);
  const text = formatBaseline({ 'src/a.tsx': 1, 'src/b.tsx': 0 }, { 'src/a.tsx': 'developer diagnostic, never shown', 'src/b.tsx': 'converted already' });
  assert.deepEqual(JSON.parse(text).reasons, { 'src/a.tsx': 'developer diagnostic, never shown' });
  assert.equal(JSON.parse(formatBaseline({ 'src/a.tsx': 0 })).reasons, undefined);
  const root = fixture({
    'apps/admin/src/View.tsx': 'export const V = () => <p>One string</p>;\nexport const W = () => <p>Another</p>;',
    [`${messages}/en/view.json`]: {},
    [`${messages}/he/view.json`]: {},
  });
  const run = async (...args) => {
    const lines = [];
    const code = await main(args, root, (line) => lines.push(line));
    return { code, out: lines.join('\n') };
  };
  const baseline = () => JSON.parse(readFileSync(path.join(root, 'apps/admin', BASELINE_FILE), 'utf8'));
  try {
    await run('--sync');
    writeFileSync(path.join(root, 'apps/admin', BASELINE_FILE), formatBaseline({ 'src/View.tsx': 2 }));
    let result = await run();
    assert.equal(result.code, 1);
    assert.match(result.out, /src\/View\.tsx: 2 baselined hardcoded strings with no reason/);
    writeFileSync(path.join(root, 'apps/admin', BASELINE_FILE), formatBaseline({ 'src/View.tsx': 2 }, { 'src/View.tsx': 'a developer-only page, never shown' }));
    assert.equal((await run()).code, 0);
    writeFileSync(path.join(root, 'apps/admin/src/View.tsx'), 'export const V = () => <p>One string</p>;');
    assert.equal((await run('--update')).code, 0);
    assert.deepEqual(baseline().reasons, { 'src/View.tsx': 'a developer-only page, never shown' });
    writeFileSync(path.join(root, 'apps/admin/src/View.tsx'), 'export const V = () => null;');
    assert.equal((await run('--update')).code, 0);
    assert.deepEqual(baseline().files, { 'src/View.tsx': 0 });
    assert.equal(baseline().reasons, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
