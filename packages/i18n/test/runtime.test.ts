import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  LOCALES,
  MessageSyntaxError,
  SUPPORTED_LOCALES,
  applyDocumentLocale,
  contentAttributes,
  createTranslator,
  isolateLtr,
  languageDirection,
  messageSignature,
  negotiateLocale,
  parseAcceptLanguage,
  parseMessage,
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

test('pseudo-locales transform catalog text but keep arguments and syntax', () => {
  const xa = translator('en-XA');
  assert.equal(xa.dir, 'ltr');
  const text = xa.t('shell.greeting', { name: 'Dana' });
  assert.match(text, /^⟦Ĥéļļö, Dana! ~+⟧$/);
  assert.match(xa.t('shell.lessons', { count: 3 }), /^⟦3 ļéššöñš ~+⟧$/);
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
  assert.equal(negotiateLocale(['en-XA']), 'en');
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
