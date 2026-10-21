import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createTranslator } from '../src/index.ts';
import { createI18nBindings } from '../src/react.ts';

const en = { app: { title: 'Course {name}', help: 'See <b>this</b>' } } as const;
const he = { app: { title: 'קורס {name}' } };
type Key = 'app.title' | 'app.help';

test('React bindings provide the translator to a subtree and switch with it', () => {
  const { I18nProvider, useT, useI18n } = createI18nBindings<Key>();
  function Title() {
    const t = useT();
    const { dir, lang, rich } = useI18n();
    return createElement('h1', { dir, lang }, t('app.title', { name: 'X' }), ' ', rich('app.help', undefined, { b: (children, key) => createElement('b', { key }, ...children) }));
  }
  const render = (locale: 'en' | 'he') =>
    renderToStaticMarkup(createElement(I18nProvider, { value: createTranslator({ locale, catalogs: { en, he } }) }, createElement(Title)));
  assert.equal(render('en'), '<h1 dir="ltr" lang="en">Course X See <b>this</b></h1>');
  assert.equal(render('he'), '<h1 dir="rtl" lang="he">קורס ⁨X⁩ See <b>this</b></h1>');
});

test('using the hooks outside the provider fails loudly', () => {
  const { useT } = createI18nBindings<Key>();
  function Orphan() {
    useT();
    return null;
  }
  assert.throws(() => renderToStaticMarkup(createElement(Orphan)), /inside I18nProvider/);
});

test('a fallback translator serves components rendered without a provider', () => {
  const { useT } = createI18nBindings<Key>({ fallback: () => createTranslator({ locale: 'en', catalogs: { en } }) });
  function Alone() {
    return createElement('p', null, useT()('app.title', { name: 'Y' }));
  }
  assert.equal(renderToStaticMarkup(createElement(Alone)), '<p>Course Y</p>');
});
