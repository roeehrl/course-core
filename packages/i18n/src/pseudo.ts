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

/** The longest run of padding without a break opportunity, so padding wraps like words do. */
export const PSEUDO_PAD_RUN = 5;
/**
 * Marks the start and end of a translated message and expands it by about 40%,
 * so clipped text and concatenated fragments are visible. The padding is split into short
 * space-separated runs: it grows the text like a longer translation would, and wraps at a
 * narrow width instead of forcing horizontal overflow that real text never causes.
 */
export function pseudoFrame(text: string): { open: string; close: string } {
  const letters = [...text].filter((char) => /\p{L}/u.test(char)).length;
  if (!letters) return { open: '⟦', close: '⟧' };
  const pad = Math.max(1, Math.ceil(letters * 0.4));
  const runs = Array.from({ length: Math.ceil(pad / PSEUDO_PAD_RUN) }, (_, index) =>
    '~'.repeat(Math.min(PSEUDO_PAD_RUN, pad - index * PSEUDO_PAD_RUN)),
  );
  return { open: '⟦', close: ` ${runs.join(' ')}⟧` };
}
