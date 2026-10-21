/**
 * A small ICU MessageFormat subset (see docs/i18n.md, "Message syntax"):
 *
 *   {name}                         argument
 *   {n, number} {n, number, integer|percent}
 *   {d, date} {d, date, short|medium|long|full}   (also `time`)
 *   {n, plural, =0 {…} one {…} two {…} other {# …}}   (`#` is the formatted number)
 *   {n, selectordinal, one {#st} other {#th}}
 *   {kind, select, owner {…} other {…}}
 *   <link>text</link>, <strong/>   tags, rendered by `rich`; `t` keeps only their text
 *
 * Quoting follows ICU: `''` is a literal apostrophe, and an apostrophe directly
 * before `{`, `}`, `<` (or `#` inside a plural) starts quoted literal text up to the
 * next lone apostrophe. Any other apostrophe is literal, so Hebrew geresh (צ'אט) needs
 * no escaping.
 */
export type DateStyle = 'short' | 'medium' | 'long' | 'full';
export type MessageNode =
  | { readonly type: 'text'; readonly value: string }
  | { readonly type: 'argument'; readonly name: string }
  | { readonly type: 'number'; readonly name: string; readonly style?: 'integer' | 'percent' }
  | { readonly type: 'date' | 'time'; readonly name: string; readonly style: DateStyle }
  | {
      readonly type: 'plural';
      readonly name: string;
      readonly ordinal: boolean;
      readonly options: Readonly<Record<string, readonly MessageNode[]>>;
    }
  | { readonly type: 'select'; readonly name: string; readonly options: Readonly<Record<string, readonly MessageNode[]>> }
  | { readonly type: 'pound' }
  | { readonly type: 'tag'; readonly name: string; readonly children: readonly MessageNode[] };

export class MessageSyntaxError extends Error {
  readonly position: number;
  constructor(message: string, position: number) {
    super(`${message} at position ${position}`);
    this.name = 'MessageSyntaxError';
    this.position = position;
  }
}

const NAME = /[A-Za-z_][A-Za-z0-9_]*/y;
const TAG_NAME = /[A-Za-z][A-Za-z0-9_-]*/y;
const SELECTOR = /(?:=\d+|[A-Za-z0-9_-]+)/y;
const PLURAL_SELECTORS = new Set(['zero', 'one', 'two', 'few', 'many', 'other']);
const DATE_STYLES = new Set(['short', 'medium', 'long', 'full']);

export function parseMessage(source: string): MessageNode[] {
  let index = 0;
  const peek = () => source[index];
  const fail = (message: string): never => {
    throw new MessageSyntaxError(message, index);
  };
  const skipSpace = () => {
    while (index < source.length && /\s/.test(source[index]!)) index++;
  };
  const match = (pattern: RegExp): string | undefined => {
    pattern.lastIndex = index;
    const found = pattern.exec(source);
    if (!found) return undefined;
    index += found[0].length;
    return found[0];
  };
  const expect = (char: string) => {
    if (source[index] !== char) fail(`Expected "${char}"`);
    index++;
  };

  function parseNodes(inPlural: boolean, closingTag: string | undefined, nested: boolean): MessageNode[] {
    const nodes: MessageNode[] = [];
    let text = '';
    const flush = () => {
      if (text) nodes.push({ type: 'text', value: text });
      text = '';
    };
    while (index < source.length) {
      const char = source[index]!;
      if (char === "'") {
        const next = source[index + 1];
        if (next === "'") {
          text += "'";
          index += 2;
          continue;
        }
        if (next === '{' || next === '}' || next === '<' || (inPlural && next === '#')) {
          index++;
          while (index < source.length) {
            if (source[index] === "'") {
              if (source[index + 1] === "'") {
                text += "'";
                index += 2;
                continue;
              }
              index++;
              break;
            }
            text += source[index];
            index++;
          }
          continue;
        }
        text += char;
        index++;
        continue;
      }
      if (char === '{') {
        flush();
        nodes.push(parseArgument(inPlural));
        continue;
      }
      if (char === '}') {
        if (nested) break;
        fail('Unmatched "}"');
      }
      if (char === '#' && inPlural) {
        flush();
        nodes.push({ type: 'pound' });
        index++;
        continue;
      }
      if (char === '<') {
        const after = source[index + 1];
        if (after === '/' && /[A-Za-z]/.test(source[index + 2] ?? '')) {
          if (closingTag === undefined) fail('Unexpected closing tag');
          break;
        }
        if (after !== undefined && /[A-Za-z]/.test(after)) {
          flush();
          nodes.push(parseTag(inPlural));
          continue;
        }
      }
      text += char;
      index++;
    }
    flush();
    return nodes;
  }

  function parseTag(inPlural: boolean): MessageNode {
    expect('<');
    const name = match(TAG_NAME) ?? fail('Expected a tag name');
    skipSpace();
    if (peek() === '/') {
      index++;
      expect('>');
      return { type: 'tag', name, children: [] };
    }
    expect('>');
    const children = parseNodes(inPlural, name, false);
    if (source.slice(index, index + name.length + 3) !== `</${name}>`) fail(`Expected </${name}>`);
    index += name.length + 3;
    return { type: 'tag', name, children };
  }

  function parseOptions(inPluralFormat: boolean): Record<string, MessageNode[]> {
    const options: Record<string, MessageNode[]> = {};
    skipSpace();
    while (peek() !== '}') {
      if (index >= source.length) fail('Unterminated options');
      const selector = match(SELECTOR) ?? fail('Expected an option selector');
      if (Object.hasOwn(options, selector)) fail(`Duplicate option "${selector}"`);
      skipSpace();
      expect('{');
      options[selector] = parseNodes(inPluralFormat, undefined, true);
      expect('}');
      skipSpace();
    }
    if (!Object.hasOwn(options, 'other')) fail('An "other" option is required');
    return options;
  }

  function parseArgument(inPlural: boolean): MessageNode {
    expect('{');
    skipSpace();
    const name = match(NAME) ?? fail('Expected an argument name');
    skipSpace();
    if (peek() === '}') {
      index++;
      return { type: 'argument', name };
    }
    expect(',');
    skipSpace();
    const kind = match(NAME) ?? fail('Expected an argument type');
    skipSpace();
    let node: MessageNode;
    if (kind === 'plural' || kind === 'selectordinal') {
      expect(',');
      const options = parseOptions(true);
      for (const selector of Object.keys(options))
        if (!selector.startsWith('=') && !PLURAL_SELECTORS.has(selector)) fail(`Unknown plural category "${selector}"`);
      node = { type: 'plural', name, ordinal: kind === 'selectordinal', options };
    } else if (kind === 'select') {
      expect(',');
      node = { type: 'select', name, options: parseOptions(inPlural) };
    } else if (kind === 'number') {
      let style: 'integer' | 'percent' | undefined;
      if (peek() === ',') {
        index++;
        skipSpace();
        const value = match(NAME);
        if (value !== 'integer' && value !== 'percent') fail('Number style must be integer or percent');
        style = value as 'integer' | 'percent';
        skipSpace();
      }
      node = style ? { type: 'number', name, style } : { type: 'number', name };
    } else if (kind === 'date' || kind === 'time') {
      let style: DateStyle = kind === 'date' ? 'medium' : 'short';
      if (peek() === ',') {
        index++;
        skipSpace();
        const value = match(NAME) ?? '';
        if (!DATE_STYLES.has(value)) fail('Date style must be short, medium, long or full');
        style = value as DateStyle;
        skipSpace();
      }
      node = { type: kind, name, style };
    } else {
      return fail(`Unknown argument type "${kind}"`);
    }
    skipSpace();
    expect('}');
    return node;
  }

  const nodes = parseNodes(false, undefined, false);
  if (index < source.length) fail('Unexpected input');
  return nodes;
}

/** Argument and tag names a message uses: what must match across locales. */
export function messageSignature(source: string): { arguments: string[]; tags: string[] } {
  const args = new Set<string>();
  const tags = new Set<string>();
  const visit = (nodes: readonly MessageNode[]) => {
    for (const node of nodes) {
      if (node.type === 'tag') {
        tags.add(node.name);
        visit(node.children);
      } else if (node.type === 'plural' || node.type === 'select') {
        args.add(node.name);
        for (const option of Object.values(node.options)) visit(option);
      } else if ('name' in node) args.add(node.name);
    }
  };
  visit(parseMessage(source));
  return { arguments: [...args].sort(), tags: [...tags].sort() };
}

export type MessageValue = string | number | bigint | boolean | Date | null | undefined;
export type MessageParams = Readonly<Record<string, MessageValue>>;
export type TagHandlers<R> = Readonly<Record<string, (children: Array<string | R>, key: string) => R>>;

export interface FormatContext {
  readonly locale: string;
  readonly isolate: boolean;
  number(value: number | bigint, options?: Intl.NumberFormatOptions): string;
  date(value: Date | number, options: Intl.DateTimeFormatOptions): string;
  pluralCategory(value: number, ordinal: boolean): string;
  onMissingArgument(name: string): void;
}

const toNumber = (value: MessageValue): number => (typeof value === 'number' ? value : typeof value === 'bigint' ? Number(value) : Number(value));

/** Formats parsed nodes into strings and tag results. Adjacent strings are merged. */
export function formatNodes<R>(
  nodes: readonly MessageNode[],
  params: MessageParams,
  context: FormatContext,
  tags: TagHandlers<R> | undefined,
  pound?: number,
  keyPrefix = '',
): Array<string | R> {
  const out: Array<string | R> = [];
  const push = (part: string | R) => {
    if (typeof part === 'string') {
      if (!part) return;
      if (typeof out[out.length - 1] === 'string') out[out.length - 1] = (out[out.length - 1] as string) + part;
      else out.push(part);
    } else out.push(part);
  };
  const value = (name: string): MessageValue => {
    if (!Object.hasOwn(params, name) || params[name] === undefined) {
      context.onMissingArgument(name);
      return undefined;
    }
    return params[name];
  };
  nodes.forEach((node, position) => {
    switch (node.type) {
      case 'text':
        push(node.value);
        return;
      case 'pound':
        push(pound === undefined ? '#' : context.number(pound));
        return;
      case 'argument': {
        const raw = value(node.name);
        if (raw === undefined) return push(`{${node.name}}`);
        let text: string;
        if (raw instanceof Date) text = context.date(raw, { dateStyle: 'medium' });
        else if (typeof raw === 'number' || typeof raw === 'bigint') text = context.number(raw);
        else text = String(raw);
        push(context.isolate && typeof raw === 'string' ? `⁨${text}⁩` : text);
        return;
      }
      case 'number': {
        const raw = value(node.name);
        if (raw === undefined) return push(`{${node.name}}`);
        const options: Intl.NumberFormatOptions =
          node.style === 'percent' ? { style: 'percent' } : node.style === 'integer' ? { maximumFractionDigits: 0 } : {};
        push(context.number(typeof raw === 'bigint' ? raw : toNumber(raw), options));
        return;
      }
      case 'date':
      case 'time': {
        const raw = value(node.name);
        if (raw === undefined) return push(`{${node.name}}`);
        const instant = raw instanceof Date ? raw : new Date(typeof raw === 'string' ? raw : toNumber(raw));
        push(context.date(instant, node.type === 'date' ? { dateStyle: node.style } : { timeStyle: node.style }));
        return;
      }
      case 'plural': {
        const raw = value(node.name);
        const count = raw === undefined ? NaN : toNumber(raw);
        const exact = node.options[`=${count}`];
        const branch = exact ?? node.options[context.pluralCategory(count, node.ordinal)] ?? node.options.other!;
        for (const part of formatNodes(branch, params, context, tags, count, `${keyPrefix}${position}.`)) push(part);
        return;
      }
      case 'select': {
        const raw = value(node.name);
        const branch = node.options[String(raw)] ?? node.options.other!;
        for (const part of formatNodes(branch, params, context, tags, pound, `${keyPrefix}${position}.`)) push(part);
        return;
      }
      case 'tag': {
        const children = formatNodes(node.children, params, context, tags, pound, `${keyPrefix}${position}.`);
        const handler = tags?.[node.name];
        if (handler) push(handler(children, `${keyPrefix}${position}`));
        else for (const part of children) push(part);
        return;
      }
    }
  });
  return out;
}
