import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  LOCALES,
  MessageSyntaxError,
  PSEUDO_PAD_RUN,
  SUPPORTED_LOCALES,
  applyDocumentLocale,
  initialClientLocale,
  reconcileServerLocale,
  contentAttributes,
  createTranslator,
  isolateLtr,
  languageDirection,
  messageSignature,
  negotiateLocale,
  parseAcceptLanguage,
  parseMessage,
  pseudoFrame,
  relativeUnit,
  resolveLocale,
  stripBidiControls,
  type MissingEvent,
} from '../src/index.ts';

const en = {
  shell: {
    'nav.overview': 'Overview',
    greeting: 'Hello, {name}!',
    lessons: '{count, plural, =0 {No lessons} one {# lesson} other {# lessons}}',
    role: '{role, select, owner {Owner} learner {Learner} other {Member}}',
    due: 'Due {when, date, long}',
    score: 'Score {value, number, percent}',
    place: '{n, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}',
    help: 'Read the <link>guide</link> before {action}.',
    quoted: "It''s '{literal}' and don't",
    answering: 'Answering: “{question}”',
    pair: 'Wrote "{a} {b}"',
    inZone: '{date} · {zone}',
    courseDue: 'Course due: {date}',
    onlyEnglish: 'Only in English',
  },
} as const;
const he = {
  shell: {
    'nav.overview': 'סקירה כללית',
    greeting: 'שלום, {name}!',
    lessons: '{count, plural, =0 {אין שיעורים} one {שיעור אחד} two {שני שיעורים} other {# שיעורים}}',
    role: '{role, select, owner {בעלים} learner {לומד/ת} other {חבר/ה}}',
    due: 'להגשה עד {when, date, long}',
    score: 'ציון {value, number, percent}',
    place: 'מקום {n}',
    help: 'כדאי לקרוא את <link>המדריך</link> לפני {action}.',
    quoted: "צ'אט '{literal}'",
    answering: 'תשובה לשאלה: "{question}"',
    pair: 'כתוב "{a} {b}"',
    inZone: '{date} · {zone}',
    courseDue: 'מועד אחרון לקורס: {date}',
    $pending: ['onlyEnglish'],
  },
};
const catalogs = { en, he };

function translator(locale: 'en' | 'he' | 'en-XA' | 'ar-XB', events: MissingEvent[] = []) {
  return createTranslator({ locale, catalogs, onMissing: (event) => events.push(event), now: () => Date.UTC(2026, 9, 21, 12) });
}

test('the supported locale list is English and Hebrew with their directions', () => {
  assert.deepEqual([...SUPPORTED_LOCALES], ['en', 'he']);
  assert.equal(LOCALES.en.dir, 'ltr');
  assert.equal(LOCALES.he.dir, 'rtl');
});

test('interpolates arguments and isolates string arguments only in right-to-left locales', () => {
  assert.equal(translator('en').t('shell.greeting', { name: 'Dana' }), 'Hello, Dana!');
  assert.equal(translator('he').t('shell.greeting', { name: 'Dana' }), 'שלום, ⁨Dana⁩!');
  assert.equal(stripBidiControls(translator('he').t('shell.greeting', { name: 'Dana' })), 'שלום, Dana!');
});

test('quotation marks around an isolated argument go inside its isolate, in its own direction', () => {
  const he = translator('he').t;
  // Left-to-right text quoted in a right-to-left sentence: the marks stay at its start and end.
  assert.equal(he('shell.answering', { question: 'Find the step size' }), 'תשובה לשאלה: ⁨"Find the step size"⁩');
  assert.equal(he('shell.answering', { question: 'למה כל צעד?' }), 'תשובה לשאלה: ⁨"למה כל צעד?"⁩');
  assert.equal(stripBidiControls(he('shell.answering', { question: 'Find' })), 'תשובה לשאלה: "Find"');
  // Marks that do not enclose exactly one argument are left where they are.
  assert.equal(he('shell.pair', { a: 'x', b: 'y' }), 'כתוב "⁨x⁩ ⁨y⁩"');
  // Left-to-right locales do not isolate arguments.
  assert.equal(translator('en').t('shell.answering', { question: 'Find' }), 'Answering: “Find”');
});

test('an argument composed only of isolated parts is isolated in the direction of its message', () => {
  const he = translator('he').t;
  const date = he('shell.inZone', { date: '8 בנוב׳ 2026, 07:41', zone: 'UTC' });
  assert.equal(date, '⁨8 בנוב׳ 2026, 07:41⁩ · ⁨UTC⁩');
  // First-strong (FSI) would skip both parts and lay "date · UTC" out left to right, so "UTC" came
  // first when read from the right; the message's own direction keeps date, then zone.
  assert.equal(he('shell.courseDue', { date }), 'מועד אחרון לקורס: ⁧⁨8 בנוב׳ 2026, 07:41⁩ · ⁨UTC⁩⁩');
  // Text with a letter of its own, or with no isolates at all, keeps first-strong isolation.
  assert.equal(he('shell.courseDue', { date: 'Nov 8 · ⁨UTC⁩' }), 'מועד אחרון לקורס: ⁨Nov 8 · ⁨UTC⁩⁩');
  assert.equal(he('shell.courseDue', { date: '1 / 2' }), 'מועד אחרון לקורס: ⁨1 / 2⁩');
});

test('English plurals use one/other and exact matches', () => {
  const t = translator('en').t;
  assert.equal(t('shell.lessons', { count: 0 }), 'No lessons');
  assert.equal(t('shell.lessons', { count: 1 }), '1 lesson');
  assert.equal(t('shell.lessons', { count: 1234 }), '1,234 lessons');
  assert.equal(t('shell.place', { n: 22 }), '22nd');
  assert.equal(t('shell.place', { n: 13 }), '13th');
});

test('Hebrew plurals follow Intl.PluralRules (one, two, other)', () => {
  const he = translator('he');
  assert.equal(he.pluralCategory(1), 'one');
  assert.equal(he.pluralCategory(2), 'two');
  assert.equal(he.pluralCategory(7), 'other');
  assert.equal(he.t('shell.lessons', { count: 0 }), 'אין שיעורים');
  assert.equal(he.t('shell.lessons', { count: 1 }), 'שיעור אחד');
  assert.equal(he.t('shell.lessons', { count: 2 }), 'שני שיעורים');
  assert.equal(he.t('shell.lessons', { count: 20 }), '20 שיעורים');
  // Any category Intl returns for Hebrew must have a branch or fall back to other.
  for (const category of new Intl.PluralRules('he').resolvedOptions().pluralCategories)
    assert.ok(['zero', 'one', 'two', 'few', 'many', 'other'].includes(category));
});

test('select chooses the branch or other', () => {
  assert.equal(translator('he').t('shell.role', { role: 'owner' }), 'בעלים');
  assert.equal(translator('he').t('shell.role', { role: 'reviewer' }), 'חבר/ה');
});

test('missing Hebrew keys fall back to English and are reported; unknown keys return the key', () => {
  const events: MissingEvent[] = [];
  const t = translator('he', events).t;
  assert.equal(t('shell.onlyEnglish'), 'Only in English');
  assert.deepEqual(events, [{ kind: 'fallback', locale: 'he', key: 'shell.onlyEnglish' }]);
  events.length = 0;
  assert.equal(t('shell.nope' as 'shell.greeting'), 'shell.nope');
  assert.equal(t('$pending' as 'shell.greeting'), '$pending');
  assert.equal(t('shell.$pending' as 'shell.greeting'), 'shell.$pending');
  assert.deepEqual(
    events.map((event) => event.kind),
    ['unknown', 'unknown', 'unknown'],
  );
});

test('signed numbers are isolated left to right in right-to-left locales, wherever they are formatted', () => {
  const he = translator('he'), en = translator('en');
  // "-2." in Hebrew text drew as ".2-" where the minus was not kept with its digits.
  assert.equal(he.number(-2), '\u2066-2\u2069');
  assert.equal(he.percent(-0.05), '\u2066-5%\u2069');
  assert.equal(he.number(-2, { signDisplay: 'always' }), '\u2066-2\u2069');
  assert.equal(he.number(3, { signDisplay: 'always' }), '\u2066+3\u2069');
  assert.equal(he.t('shell.score', { value: -0.1 }), 'ציון \u2066-10%\u2069');
  // Unsigned numbers and left-to-right locales are unchanged.
  assert.equal(he.number(1234.5), '1,234.5');
  assert.equal(en.number(-2), '-2');
  assert.equal(stripBidiControls(he.number(-2.5)), '-2.5');
});

test('missing arguments render visibly and are reported', () => {
  const events: MissingEvent[] = [];
  assert.equal(translator('en', events).t('shell.greeting'), 'Hello, {name}!');
  assert.deepEqual(events, [{ kind: 'argument', locale: 'en', key: 'shell.greeting', argument: 'name' }]);
});

test('formats numbers, dates, currency, lists and relative time in Hebrew', () => {
  const he = translator('he');
  const when = new Date(Date.UTC(2026, 9, 21, 12));
  assert.equal(he.number(1234.5), '1,234.5');
  assert.equal(he.t('shell.score', { value: 0.85 }), 'ציון 85%');
  assert.match(he.t('shell.due', { when }), /^להגשה עד 21 באוקטובר 2026$/);
  assert.match(stripBidiControls(he.currency(12.5, 'ILS')), /^12\.50\s₪$/);
  assert.equal(he.list(['שיעור', 'פרק', 'קורס']), 'שיעור, פרק וקורס');
  assert.equal(he.relativeTime(-1, 'day'), 'אתמול');
  assert.equal(he.relativeFrom(Date.UTC(2026, 9, 21, 9)), 'לפני 3 שעות');
  assert.equal(translator('en').relativeFrom(Date.UTC(2026, 9, 23, 12)), 'in 2 days');
  assert.deepEqual(relativeUnit(90 * 60), [2, 'hour']);
});

test('rich messages render tags through handlers; t keeps only the text', () => {
  const en = translator('en');
  assert.equal(en.t('shell.help', { action: 'starting' }), 'Read the guide before starting.');
  assert.deepEqual(
    en.rich('shell.help', { action: 'starting' }, { link: (children, key) => ({ link: children.join(''), key }) }),
    ['Read the ', { link: 'guide', key: '1' }, ' before starting.'],
  );
});

test('ICU quoting keeps apostrophes and Hebrew geresh literal', () => {
  assert.equal(translator('en').t('shell.quoted'), "It's {literal} and don't");
  assert.equal(translator('he').t('shell.quoted'), "צ'אט {literal}");
});

test('the parser rejects malformed messages', () => {
  for (const bad of ['{', '{name', '{n, plural, one {x}}', '{n, plural, lots {x} other {y}}', '<b>x', 'x</b>', '{n, money}', 'a } b'])
    assert.throws(() => parseMessage(bad), MessageSyntaxError, bad);
  assert.deepEqual(messageSignature(en.shell.help), { arguments: ['action'], tags: ['link'] });
  assert.deepEqual(messageSignature(he.shell.lessons), { arguments: ['count'], tags: [] });
});

test('pseudo padding wraps: no unbroken run longer than a short word', () => {
  const xa = translator('en-XA');
  const long = xa.t('shell.help', { action: 'x' }) + xa.t('shell.greeting', { name: 'A much longer learner name for padding' });
  for (const run of long.match(/~+/g) ?? []) assert.ok(run.length <= PSEUDO_PAD_RUN, run);
  const { close } = pseudoFrame('a'.repeat(40));
  assert.equal(close, ' ~~~~~ ~~~~~ ~~~~~ ~⟧');
  assert.deepEqual(pseudoFrame('123'), { open: '⟦', close: '⟧' });
});

test('pseudo-locales transform catalog text but keep arguments and syntax', () => {
  const xa = translator('en-XA');
  assert.equal(xa.dir, 'ltr');
  const text = xa.t('shell.greeting', { name: 'Dana' });
  assert.match(text, /^⟦Ĥéļļö, Dana! [~ ]+⟧$/);
  assert.match(xa.t('shell.lessons', { count: 3 }), /^⟦3 ļéššöñš [~ ]+⟧$/);
  const xb = translator('ar-XB');
  assert.equal(xb.dir, 'rtl');
  assert.ok(xb.t('shell.nav.overview').includes('‮Öṽéŕṽîéŵ‬'));
  assert.equal(xb.number(1234), '1,234');
});

test('negotiates Accept-Language and resolves the documented fallback order', () => {
  assert.deepEqual(parseAcceptLanguage('fr-CH, he;q=0.9, en;q=0.8, *;q=0.5, bad tag, de;q=0'), ['fr-CH', 'he', 'en', '*']);
  assert.deepEqual(parseAcceptLanguage(undefined), []);
  assert.equal(negotiateLocale(['fr', 'he-IL', 'en']), 'he');
  assert.equal(negotiateLocale(['iw']), 'he');
  assert.equal(negotiateLocale(['EN-us']), 'en');
  assert.equal(negotiateLocale(['en-XA']), undefined);
  assert.equal(negotiateLocale(['en-XA', 'he']), 'he');
  assert.equal(negotiateLocale(['en-XA'], { allowPseudo: true }), 'en-XA');
  assert.equal(negotiateLocale(['fr', 'de']), undefined);
  assert.deepEqual(resolveLocale({ user: 'he', requested: ['en'], workspace: 'en' }), { locale: 'he', source: 'user' });
  assert.deepEqual(resolveLocale({ user: null, requested: ['fr', 'he'], workspace: 'en' }), { locale: 'he', source: 'request' });
  assert.deepEqual(resolveLocale({ user: 'xx', requested: ['fr'], workspace: 'he' }), { locale: 'he', source: 'workspace' });
  assert.deepEqual(resolveLocale({ requested: ['fr'] }), { locale: 'en', source: 'default' });
  assert.deepEqual(resolveLocale({ user: 'ar-XB' }), { locale: 'en', source: 'default' });
});

test('content direction follows the declared language, not the UI locale', () => {
  assert.equal(languageDirection('he'), 'rtl');
  assert.equal(languageDirection('ar-EG'), 'rtl');
  assert.equal(languageDirection('az-Arab'), 'rtl');
  assert.equal(languageDirection('ku-Latn'), 'ltr');
  assert.equal(languageDirection('en-GB'), 'ltr');
  assert.equal(languageDirection('not a tag'), undefined);
  assert.deepEqual(contentAttributes('he'), { lang: 'he', dir: 'rtl' });
  assert.deepEqual(contentAttributes(null), { dir: 'auto' });
  assert.equal(isolateLtr('sha256:abc'), '⁦sha256:abc⁩');
});

test('applyDocumentLocale sets html lang and dir', () => {
  const document = { documentElement: { lang: 'en', dir: '' } };
  applyDocumentLocale(document, translator('he'));
  assert.deepEqual(document.documentElement, { lang: 'he', dir: 'rtl' });
  applyDocumentLocale(undefined, translator('he'));
});

test('a client starts from an override, then its stored choice, then the browser languages', () => {
  assert.deepEqual(initialClientLocale({ override: 'en-XA', stored: 'he', allowPseudo: true }), { locale: 'en-XA', source: 'override' });
  assert.deepEqual(initialClientLocale({ override: 'en-XA', stored: 'he' }), { locale: 'he', source: 'stored' });
  assert.deepEqual(initialClientLocale({ stored: 'garbage', languages: ['fr-FR', 'he-IL'] }), { locale: 'he', source: 'browser' });
  assert.deepEqual(initialClientLocale({ languages: ['fr'] }), { locale: 'en', source: 'default' });
});

test('after sign-in a saved preference wins, a device choice is saved, otherwise the server resolves', () => {
  assert.deepEqual(reconcileServerLocale({ server: { preference: 'he', locale: 'he' }, client: { locale: 'en', source: 'stored' } }), { locale: 'he' });
  assert.deepEqual(reconcileServerLocale({ server: { preference: null, locale: 'en' }, client: { locale: 'he', source: 'stored' } }), { locale: 'he', save: 'he' });
  assert.deepEqual(reconcileServerLocale({ server: { preference: null, locale: 'he' }, client: { locale: 'en', source: 'browser' } }), { locale: 'he' });
  assert.deepEqual(reconcileServerLocale({ server: { preference: 'he', locale: 'he' }, client: { locale: 'ar-XB', source: 'override' } }), { locale: 'ar-XB' });
  assert.deepEqual(reconcileServerLocale({ server: { preference: null, locale: 'en' }, client: { locale: 'en-XA', source: 'stored' } }), { locale: 'en-XA' });
});
