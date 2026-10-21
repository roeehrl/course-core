// Enforces "no hardcoded user-visible strings" and message catalog consistency.
// See docs/i18n.md ("Enforcement"). Usage:
//   node scripts/i18n-check.mjs                 check strings against each surface's baseline, and all catalogs
//   node scripts/i18n-check.mjs --update        lower baseline counts to the current counts (never raises them)
//   node scripts/i18n-check.mjs --report [path] list each violation (file:line:col) under an optional path prefix
//   node scripts/i18n-check.mjs --summary       violation counts per surface and directory
//   node scripts/i18n-check.mjs --prune         drop zero and deleted entries (coordinator, after merges)
//   node scripts/i18n-check.mjs --sync          regenerate each surface's src/i18n/catalog.ts from its message folders
//   node scripts/i18n-check.mjs --init          write a baseline for a surface that has none (a newly added surface)
// Needs the TypeScript compiler API: an installed module's node_modules/typescript, or `tsc` on PATH
// (CI runs it under `npm exec --package=typescript@<admin lock version>`).
import { existsSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './is-main.mjs';

export const ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const require = createRequire(import.meta.url);

/** Surfaces scanned for hardcoded strings. `catalog` is where the surface's message catalogs live. */
export const SURFACES = Object.freeze({
  admin: { directory: 'apps/admin', sources: ['src'], catalog: 'src/i18n/messages' },
  learner: { directory: 'apps/learner', sources: ['src'], catalog: 'src/i18n/messages' },
  // Visuals has no catalog yet: its strings move behind a `messages` prop at its next version bump.
  visuals: {
    directory: 'packages/visuals',
    sources: ['src'],
    catalog: null,
    exclude: [[/^src\/demos\.ts$/, 'demo scenes are course content, rendered with the course language']],
  },
});
export const BASELINE_FILE = 'i18n-baseline.json';
const BASELINE_RULE =
  'Hardcoded user-visible strings per file. Counts may only go down: convert strings to catalog keys, then run node scripts/i18n-check.mjs --update. Never raise a count; see docs/i18n.md.';

/** Source paths that are not UI chrome, with the reason. */
const EXCLUDED = [
  [/(^|\/)i18n\/(?:messages\/|catalog\.ts$)/, 'message catalogs and the generated catalog index'],
  [/(^|\/)data\//, 'demo course content and fixtures: course content, rendered with the course language'],
  [/\.d\.ts$/, 'declarations'],
  [/\.(test|spec)\.[cm]?[jt]sx?$/, 'tests'],
];

export function loadTypeScript() {
  const candidates = [];
  if (process.env.I18N_TYPESCRIPT) candidates.push(process.env.I18N_TYPESCRIPT);
  for (const directory of ['packages/i18n', 'apps/admin', 'apps/learner'])
    candidates.push(path.join(ROOT, directory, 'node_modules/typescript'));
  for (const folder of (process.env.PATH ?? '').split(path.delimiter)) {
    const bin = path.join(folder, 'tsc');
    if (folder && existsSync(bin)) candidates.push(path.resolve(path.dirname(realpathSync(bin)), '..'));
  }
  for (const candidate of candidates) {
    const entry = path.join(candidate, 'lib/typescript.js');
    if (existsSync(entry)) return require(entry);
  }
  throw new Error('The TypeScript compiler API is required: install a module (npm ci in apps/admin) or run under npm exec --package=typescript@<version>.');
}

// ---------------------------------------------------------------------------
// String detection
// ---------------------------------------------------------------------------

/** JSX attributes and object properties whose string values users read. */
const USER_FACING = new Set([
  'title', 'label', 'placeholder', 'alt', 'eyebrow', 'summary', 'caption', 'description', 'heading', 'subtitle', 'message',
  'hint', 'helperText', 'tooltip', 'detail', 'text', 'body', 'explanation', 'note', 'emptyText', 'emptyLabel',
  'confirmLabel', 'cancelLabel', 'actionLabel', 'submitLabel', 'ariaLabel', 'accessibilityLabel', 'accessibilityHint',
  'aria-label', 'aria-description', 'aria-valuetext', 'aria-roledescription', 'aria-placeholder', 'aria-braillelabel',
]);
const USER_FACING_SUFFIX = /(?:Label|Title|Text|Message|Placeholder|Hint|Description|Heading|Caption|Tooltip|Summary)$/;
export const isUserFacingName = (name) => USER_FACING.has(name) || USER_FACING_SUFFIX.test(name);

/** Functions whose string arguments are shown to people. */
const DISPLAY_CALLS = new Set(['alert', 'confirm', 'prompt', 'announce', 'notify', 'toast', 'showNotice', 'showError']);
const DISPLAY_SETTER = /^set[A-Z]\w*(?:Error|Notice|Status|Message|Feedback|Warning|Hint|Label|Title|Announcement)$|^set(?:Error|Notice|Status|Message|Saved|Syntax)$/;
const ERROR_CONSTRUCTOR = /^(?:[A-Z][A-Za-z]*)?Error$/;

const hasLetter = (text) => /\p{L}/u.test(text);
/** Lower-case identifiers, keys, paths and class lists: `nav-link active`, `shell.nav`, `a_b`. */
const lowerCode = (text) => /^[a-z0-9]+(?:[._:/#@-][a-z0-9]+)*$/.test(text.trim()) || /^(?:[a-z0-9-]+ )+[a-z0-9-]+$/.test(text.trim()) && !/\s{2}/.test(text);
/** Upper-case machine codes: `UNAVAILABLE`, `INVALID_RESPONSE`. */
const upperCode = (text) => /^[A-Z0-9]+(?:_[A-Z0-9]+)*$/.test(text.trim());
const urlLike = (text) => /^(?:https?:|mailto:|data:|blob:|\/|\.\/|#)/.test(text.trim()) || /^\S+@\S+\.\S+$/.test(text.trim());

/**
 * Finds hardcoded user-visible strings in one file. Returns violations and
 * opt-out errors (an `i18n-ignore` without a reason).
 */
export function scanSource(ts, filename, text) {
  const kind = /\.tsx$/.test(filename) ? ts.ScriptKind.TSX : /\.jsx$/.test(filename) ? ts.ScriptKind.JSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true, kind);
  const lines = text.split('\n');
  const ignored = new Set();
  const errors = [];
  let fileIgnored = false;
  lines.forEach((line, index) => {
    const match = /i18n-ignore(-file)?(?::\s*(.*?))?\s*(?:\*\/\s*\}?)?$/.exec(line);
    if (!match || !/(\/\/|\/\*)\s*i18n-ignore/.test(line)) return;
    const reason = (match[2] ?? '').replace(/\*\/.*$/, '').trim();
    if (reason.length < 4) {
      errors.push(`${filename}:${index + 1}: i18n-ignore needs a reason, e.g. // i18n-ignore: product name`);
      return;
    }
    if (match[1]) fileIgnored = true;
    else ignored.add(index + 1);
  });
  const violations = [];
  if (fileIgnored) return { violations, errors };
  const flag = (node, value, why) => {
    const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
    if (ignored.has(line + 1) || ignored.has(line)) return;
    violations.push({ line: line + 1, column: character + 1, text: value.replace(/\s+/g, ' ').trim().slice(0, 80), why });
  };
  /** Visits every string a value expression can evaluate to. */
  const results = (node, visit) => {
    if (!node) return;
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression?.(node) || ts.isNonNullExpression(node))
      return results(node.expression, visit);
    if (ts.isConditionalExpression(node)) {
      results(node.whenTrue, visit);
      results(node.whenFalse, visit);
      return;
    }
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      if (op === ts.SyntaxKind.AmpersandAmpersandToken) return results(node.right, visit);
      if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.PlusToken) {
        results(node.left, visit);
        results(node.right, visit);
      }
      return;
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return visit(node, node.text);
    if (ts.isTemplateExpression(node)) {
      const literal = [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(' ');
      if (hasLetter(literal)) visit(node, literal);
      for (const span of node.templateSpans) results(span.expression, visit);
    }
  };
  const proseOrName = (value) => hasLetter(value) && !lowerCode(value) && !urlLike(value);
  const prose = (value) => proseOrName(value) && !upperCode(value);
  const walk = (node) => {
    if (ts.isJsxText(node)) {
      if (hasLetter(node.text)) flag(node, node.text, 'JSX text');
    } else if (ts.isJsxExpression(node) && node.expression && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) {
      results(node.expression, (literal, value) => hasLetter(value) && !urlLike(value) && flag(literal, value, 'JSX child'));
    } else if (ts.isJsxAttribute(node) && node.initializer) {
      const name = node.name.getText(source);
      if (isUserFacingName(name)) {
        const value = ts.isJsxExpression(node.initializer) ? node.initializer.expression : node.initializer;
        results(value, (literal, text) => proseOrName(text) && flag(literal, text, `${name} prop`));
      }
    } else if (ts.isPropertyAssignment(node)) {
      const name = ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : undefined;
      if (name && isUserFacingName(name)) results(node.initializer, (literal, text) => prose(text) && flag(literal, text, `${name} property`));
    } else if ((ts.isBindingElement(node) || ts.isParameter(node)) && node.initializer && ts.isIdentifier(node.name) && isUserFacingName(node.name.text)) {
      results(node.initializer, (literal, text) => prose(text) && flag(literal, text, `${node.name.text} default`));
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && /^toLocale(?:Date|Time)?String$/.test(node.expression.name.text)) {
      flag(node.expression.name, node.expression.name.text, 'locale-blind formatting (use the active locale: useI18n())');
    } else if (
      ts.isNewExpression(node) && ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'Intl' && (!node.arguments?.length || ts.isStringLiteral(node.arguments[0]) || node.arguments[0].kind === ts.SyntaxKind.UndefinedKeyword || (ts.isIdentifier(node.arguments[0]) && node.arguments[0].text === 'undefined'))
    ) {
      flag(node.expression, `Intl.${node.expression.name.text}`, 'locale-blind formatting (use the active locale: useI18n())');
    } else if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
      const display = ts.isNewExpression(node) ? name && ERROR_CONSTRUCTOR.test(name) : name && (DISPLAY_CALLS.has(name) || DISPLAY_SETTER.test(name));
      if (display) for (const argument of node.arguments ?? []) results(argument, (literal, text) => prose(text) && /\s/.test(text.trim()) && flag(literal, text, `${name}() argument`));
    }
    ts.forEachChild(node, walk);
  };
  walk(source);
  return { violations, errors };
}

// ---------------------------------------------------------------------------
// Files and baselines
// ---------------------------------------------------------------------------

function* sourceFiles(directory, relative = '') {
  const absolute = path.join(directory, relative);
  if (!existsSync(absolute)) return;
  for (const entry of readdirSync(absolute, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const next = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== 'dist') yield* sourceFiles(directory, next);
    } else if (/\.[cm]?[jt]sx?$/.test(entry.name)) yield next;
  }
}
export const excludedReason = (relative) => EXCLUDED.find(([pattern]) => pattern.test(relative))?.[1];

export function scanSurface(ts, name, root = ROOT) {
  const surface = SURFACES[name];
  const directory = path.join(root, surface.directory);
  const files = new Map();
  const errors = [];
  for (const sourceDirectory of surface.sources)
    for (const file of sourceFiles(directory, sourceDirectory)) {
      if (excludedReason(file) || surface.exclude?.some(([pattern]) => pattern.test(file))) continue;
      const result = scanSource(ts, file, readFileSync(path.join(directory, file), 'utf8'));
      errors.push(...result.errors.map((error) => `${surface.directory}/${error}`));
      if (result.violations.length) files.set(file, result.violations);
    }
  return { files, errors };
}

/** Writes JSON with a blank line between file entries, so parallel edits to different files merge cleanly. */
export function formatBaseline(counts) {
  const entries = Object.keys(counts).sort().map((file) => `    ${JSON.stringify(file)}: ${counts[file]}`);
  return `{\n  "rule": ${JSON.stringify(BASELINE_RULE)},\n  "files": {\n${entries.join(',\n\n')}\n  }\n}\n`;
}
export function readBaseline(name, root = ROOT) {
  const filename = path.join(root, SURFACES[name].directory, BASELINE_FILE);
  if (!existsSync(filename)) return undefined;
  const parsed = JSON.parse(readFileSync(filename, 'utf8'));
  for (const [file, count] of Object.entries(parsed.files ?? {}))
    if (!Number.isSafeInteger(count) || count < 0) throw new Error(`${SURFACES[name].directory}/${BASELINE_FILE}: invalid count for ${file}`);
  return parsed.files ?? {};
}

/** Compares current counts with the baseline. Increases and new files fail; decreases ask for --update. */
export function compareBaseline(current, baseline) {
  const increased = [];
  const decreased = [];
  for (const [file, count] of Object.entries(current)) {
    const allowed = baseline[file] ?? 0;
    if (count > allowed) increased.push({ file, count, allowed });
    else if (count < allowed) decreased.push({ file, count, allowed });
  }
  for (const [file, allowed] of Object.entries(baseline))
    if (!Object.hasOwn(current, file) && allowed > 0) decreased.push({ file, count: 0, allowed });
  return { increased, decreased };
}

// ---------------------------------------------------------------------------
// Catalogs
// ---------------------------------------------------------------------------

const NAMESPACE = /^[a-z][A-Za-z0-9]*$/;
const KEY = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*$/;

/** Every string literal and template prefix in a surface's sources: a key is used when one names it. */
export function collectKeyReferences(ts, directory, sources) {
  const literals = new Set();
  const prefixes = new Set();
  for (const sourceDirectory of sources)
    for (const file of sourceFiles(directory, sourceDirectory)) {
      if (/(^|\/)i18n\/messages\//.test(file) || /\.d\.ts$/.test(file)) continue;
      const text = readFileSync(path.join(directory, file), 'utf8');
      const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      const visit = (node) => {
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) literals.add(node.text);
        else if (ts.isTemplateExpression(node) && node.head.text.includes('.')) prefixes.add(node.head.text);
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  return { literals, prefixes };
}

export async function checkCatalogs(ts, name, root = ROOT) {
  const surface = SURFACES[name];
  const errors = [];
  const pending = [];
  if (!surface.catalog) return { errors, pending, keys: 0 };
  const { SUPPORTED_LOCALES, DEFAULT_LOCALE, messageSignature } = await import('../packages/i18n/src/index.ts');
  const directory = path.join(root, surface.directory);
  const catalogDirectory = path.join(directory, surface.catalog);
  const label = (locale, namespace) => `${surface.directory}/${surface.catalog}/${locale}/${namespace}.json`;
  const read = (locale, namespace) => {
    const filename = path.join(catalogDirectory, locale, `${namespace}.json`);
    if (!existsSync(filename)) return undefined;
    try {
      const value = JSON.parse(readFileSync(filename, 'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
      return value;
    } catch (error) {
      errors.push(`${label(locale, namespace)}: invalid JSON (${error.message})`);
      return {};
    }
  };
  const namespaces = existsSync(path.join(catalogDirectory, DEFAULT_LOCALE))
    ? readdirSync(path.join(catalogDirectory, DEFAULT_LOCALE)).filter((file) => file.endsWith('.json')).map((file) => file.slice(0, -5)).sort()
    : [];
  for (const locale of SUPPORTED_LOCALES) {
    const folder = path.join(catalogDirectory, locale);
    if (!existsSync(folder)) {
      errors.push(`${surface.directory}/${surface.catalog}/${locale}: missing locale folder`);
      continue;
    }
    for (const file of readdirSync(folder).filter((entry) => entry.endsWith('.json')))
      if (!namespaces.includes(file.slice(0, -5))) errors.push(`${label(locale, file.slice(0, -5))}: namespace has no English catalog`);
  }
  const english = new Map();
  for (const namespace of namespaces) {
    if (!NAMESPACE.test(namespace)) errors.push(`${label(DEFAULT_LOCALE, namespace)}: namespace must be lowerCamelCase`);
    const messages = read(DEFAULT_LOCALE, namespace) ?? {};
    for (const [key, message] of Object.entries(messages)) {
      const full = `${namespace}.${key}`;
      if (!KEY.test(key)) errors.push(`${label(DEFAULT_LOCALE, namespace)}: invalid key "${key}"`);
      if (typeof message !== 'string') {
        errors.push(`${label(DEFAULT_LOCALE, namespace)}: "${key}" must be a string`);
        continue;
      }
      try {
        english.set(full, messageSignature(message));
      } catch (error) {
        errors.push(`${label(DEFAULT_LOCALE, namespace)}: "${key}" ${error.message}`);
      }
    }
  }
  for (const locale of SUPPORTED_LOCALES.filter((value) => value !== DEFAULT_LOCALE))
    for (const namespace of namespaces) {
      const messages = read(locale, namespace);
      if (!messages) {
        errors.push(`${label(locale, namespace)}: missing (create it with {} and list untranslated keys in "$pending")`);
        continue;
      }
      const listed = messages.$pending ?? [];
      if (!Array.isArray(listed) || listed.some((key) => typeof key !== 'string')) errors.push(`${label(locale, namespace)}: "$pending" must be an array of keys`);
      const pendingKeys = new Set(Array.isArray(listed) ? listed : []);
      for (const key of pendingKeys) {
        if (!english.has(`${namespace}.${key}`)) errors.push(`${label(locale, namespace)}: "$pending" lists unknown key "${key}"`);
        else if (Object.hasOwn(messages, key)) errors.push(`${label(locale, namespace)}: "${key}" is translated; remove it from "$pending"`);
        else pending.push(`${locale}:${namespace}.${key}`);
      }
      for (const [key, message] of Object.entries(messages)) {
        if (key === '$pending') continue;
        const signature = english.get(`${namespace}.${key}`);
        if (!signature) {
          errors.push(`${label(locale, namespace)}: "${key}" is not in the English catalog`);
          continue;
        }
        if (typeof message !== 'string') {
          errors.push(`${label(locale, namespace)}: "${key}" must be a string`);
          continue;
        }
        try {
          const translated = messageSignature(message);
          if (JSON.stringify(translated) !== JSON.stringify(signature))
            errors.push(`${label(locale, namespace)}: "${key}" placeholders ${JSON.stringify(translated)} differ from English ${JSON.stringify(signature)}`);
        } catch (error) {
          errors.push(`${label(locale, namespace)}: "${key}" ${error.message}`);
        }
      }
      for (const key of english.keys())
        if (key.startsWith(`${namespace}.`) && !Object.hasOwn(messages, key.slice(namespace.length + 1)) && !pendingKeys.has(key.slice(namespace.length + 1)))
          errors.push(`${label(locale, namespace)}: missing "${key.slice(namespace.length + 1)}" (translate it or list it in "$pending")`);
    }
  const { literals, prefixes } = collectKeyReferences(ts, directory, surface.sources);
  for (const key of english.keys())
    if (!literals.has(key) && ![...prefixes].some((prefix) => key.startsWith(prefix) && prefix.length > key.indexOf('.') + 1))
      errors.push(`${surface.directory}: unused key "${key}" (remove it from every locale, or reference it)`);
  return { errors, pending, keys: english.size };
}

/** The generated import index for a surface's catalogs; `--sync` writes it, the check compares it. */
export async function catalogIndex(name, root = ROOT) {
  const surface = SURFACES[name];
  if (!surface.catalog) return undefined;
  const { SUPPORTED_LOCALES, DEFAULT_LOCALE } = await import('../packages/i18n/src/index.ts');
  const folder = path.join(root, surface.directory, surface.catalog, DEFAULT_LOCALE);
  const namespaces = existsSync(folder) ? readdirSync(folder).filter((file) => file.endsWith('.json')).map((file) => file.slice(0, -5)).sort() : [];
  const others = SUPPORTED_LOCALES.filter((locale) => locale !== DEFAULT_LOCALE);
  const ident = (locale, namespace) => `${locale.replace(/-/g, '_')}_${namespace}`;
  const lines = [
    `// Generated by \`node scripts/i18n-check.mjs --sync\` from ${surface.catalog}. Do not edit.`,
    `// Add a namespace by creating ${surface.catalog}/<locale>/<namespace>.json for every locale, then run --sync.`,
    'import type { PartialCatalog } from "@course-core/i18n";',
  ];
  for (const locale of [DEFAULT_LOCALE, ...others])
    for (const namespace of namespaces) lines.push(`import ${ident(locale, namespace)} from "./messages/${locale}/${namespace}.json";`);
  lines.push('', `export const ${DEFAULT_LOCALE} = {`, ...namespaces.map((namespace) => `  ${namespace}: ${ident(DEFAULT_LOCALE, namespace)},`), '} as const;');
  for (const locale of others)
    lines.push(
      `export const ${locale.replace(/-/g, '_')}: PartialCatalog<typeof ${DEFAULT_LOCALE}> = {`,
      ...namespaces.map((namespace) => `  ${namespace}: ${ident(locale, namespace)},`),
      '};',
    );
  lines.push(`export const catalogs = { ${[DEFAULT_LOCALE, ...others].map((locale) => locale.replace(/-/g, '_')).join(', ')} };`);
  return { filename: path.join(root, surface.directory, 'src/i18n/catalog.ts'), text: `${lines.join('\n')}\n` };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function directoryOf(file) {
  const parts = file.split('/');
  return parts.length > 2 ? parts.slice(0, 2).join('/') : parts.length === 2 ? parts[0] : '.';
}

export async function main(args = process.argv.slice(2), root = ROOT, log = console.log) {
  const mode = args.find((arg) => ['--update', '--report', '--summary', '--prune', '--sync', '--init'].includes(arg)) ?? 'check';
  const filter = mode === '--report' ? args[args.indexOf('--report') + 1] : undefined;
  const ts = loadTypeScript();
  let failed = false;
  const fail = (message) => {
    failed = true;
    log(`✖ ${message}`);
  };
  for (const name of Object.keys(SURFACES)) {
    const surface = SURFACES[name];
    const index = await catalogIndex(name, root);
    if (mode === '--sync') {
      if (index) {
        writeFileSync(index.filename, index.text);
        log(`${path.relative(root, index.filename)} regenerated.`);
      }
      continue;
    }
    if (index && (mode === 'check' || mode === '--update') && (!existsSync(index.filename) || readFileSync(index.filename, 'utf8') !== index.text))
      fail(`${path.relative(root, index.filename)} is stale or missing. Run node scripts/i18n-check.mjs --sync`);
    const { files, errors } = scanSurface(ts, name, root);
    for (const error of errors) fail(error);
    const current = Object.fromEntries([...files].map(([file, violations]) => [file, violations.length]));
    const baseline = readBaseline(name, root) ?? {};
    const baselineFile = path.join(root, surface.directory, BASELINE_FILE);
    if (mode === '--report') {
      for (const [file, violations] of files) {
        const relative = `${surface.directory}/${file}`;
        if (filter && !relative.startsWith(filter.replace(/^\.\//, ''))) continue;
        for (const violation of violations) log(`${relative}:${violation.line}:${violation.column}  ${violation.why}: ${JSON.stringify(violation.text)}`);
      }
      continue;
    }
    if (mode === '--summary') {
      const byDirectory = new Map();
      for (const [file, count] of Object.entries(current)) byDirectory.set(directoryOf(file), (byDirectory.get(directoryOf(file)) ?? 0) + count);
      const total = Object.values(current).reduce((sum, count) => sum + count, 0);
      log(`${name} (${surface.directory}): ${total} in ${files.size} files`);
      for (const [directory, count] of [...byDirectory].sort()) log(`  ${directory}: ${count}`);
      continue;
    }
    if (mode === '--init') {
      if (existsSync(baselineFile)) log(`${surface.directory}/${BASELINE_FILE} exists; --init never replaces a baseline.`);
      else {
        writeFileSync(baselineFile, formatBaseline(current));
        log(`${surface.directory}/${BASELINE_FILE} written.`);
      }
      continue;
    }
    const { increased, decreased } = compareBaseline(current, baseline);
    if (mode === '--update' || mode === '--prune') {
      if (increased.length) {
        for (const item of increased) fail(`${surface.directory}/${item.file}: ${item.count} hardcoded strings, baseline allows ${item.allowed}. --update never raises a count.`);
        continue;
      }
      const next = { ...baseline };
      for (const item of decreased) next[item.file] = item.count;
      if (mode === '--prune') for (const file of Object.keys(next)) if (!next[file]) delete next[file];
      if (Object.keys(next).length || existsSync(baselineFile)) writeFileSync(baselineFile, formatBaseline(next));
      log(`${surface.directory}/${BASELINE_FILE}: ${decreased.length} entr${decreased.length === 1 ? 'y' : 'ies'} lowered${mode === '--prune' ? ', zero entries pruned' : ''}.`);
    } else {
      for (const item of increased)
        fail(
          item.allowed
            ? `${surface.directory}/${item.file}: ${item.count} hardcoded user-visible strings, baseline allows ${item.allowed}. Use catalog keys (docs/i18n.md); list them with --report ${surface.directory}/${item.file}`
            : `${surface.directory}/${item.file}: ${item.count} new hardcoded user-visible strings. Use catalog keys (docs/i18n.md); list them with --report ${surface.directory}/${item.file}`,
        );
      if (decreased.length) {
        for (const item of decreased) fail(`${surface.directory}/${item.file}: down to ${item.count} from ${item.allowed}. Shrink the baseline: node scripts/i18n-check.mjs --update`);
      }
      const total = Object.values(current).reduce((sum, count) => sum + count, 0);
      if (!increased.length && !decreased.length) log(`✔ ${name}: ${total} baselined hardcoded strings in ${files.size} files; none added.`);
    }
    if (mode === 'check' || mode === '--update') {
      const catalogs = await checkCatalogs(ts, name, root);
      for (const error of catalogs.errors) fail(error);
      if (surface.catalog && !catalogs.errors.length) log(`✔ ${name}: ${catalogs.keys} catalog keys consistent across locales.`);
      if (catalogs.pending.length) log(`ℹ ${name}: ${catalogs.pending.length} keys pending translation: ${catalogs.pending.join(', ')}`);
    }
  }
  return failed ? 1 : 0;
}

if (isMain(import.meta.url)) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(`i18n check failed: ${error.message}`);
      process.exitCode = 1;
    },
  );
}

export const _internal = { lowerCode, upperCode, urlLike, statSync };
