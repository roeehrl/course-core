import type { MessageNode } from './message.ts';
import type { PseudoLocale } from './locales.ts';

const ACCENTED: Readonly<Record<string, string>> = Object.fromEntries(
  [...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'].map((char, index) => [
    char,
    [...'åƀçðéƒĝĥîĵķļɱñöþǫŕšţûṽŵẋýžÅƁÇÐÉƑĜĤÎĴĶĻṀÑÖÞǪŔŠŢÛṼŴẊÝŽ'][index]!,
  ]),
);
/** Right-to-left override and pop: ar-XB text renders mirrored, like Android's RTL pseudo-locale. */
const RLO = '‮';
const PDF = '‬';

export function accent(text: string): string {
  return [...text].map((char) => ACCENTED[char] ?? char).join('');
}

/** Transforms a parsed message's literal text, keeping arguments, plural syntax and tags intact. */
export function pseudoNodes(nodes: readonly MessageNode[], locale: PseudoLocale): MessageNode[] {
  return nodes.map((node): MessageNode => {
    switch (node.type) {
      case 'text': {
        const value = accent(node.value);
        return { type: 'text', value: locale === 'ar-XB' ? `${RLO}${value}${PDF}` : value };
      }
      case 'plural':
      case 'select':
        return {
          ...node,
          options: Object.fromEntries(Object.entries(node.options).map(([key, option]) => [key, pseudoNodes(option, locale)])),
        };
      case 'tag':
        return { ...node, children: pseudoNodes(node.children, locale) };
      default:
        return node;
    }
  });
}

/**
 * Marks the start and end of a translated message and expands it by about 40%,
 * so clipped text and concatenated fragments are visible.
 */
export function pseudoFrame(text: string): { open: string; close: string } {
  const letters = [...text].filter((char) => /\p{L}/u.test(char)).length;
  return { open: '⟦', close: `${letters ? ' ' + '~'.repeat(Math.max(1, Math.ceil(letters * 0.4))) : ''}⟧` };
}
