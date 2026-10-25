import { formatNodes, parseMessage, type FormatContext, type MessageNode, type MessageParams, type TagHandlers } from './message.ts';
import { pseudoFrame, pseudoNodes } from './pseudo.ts';
import {
  DEFAULT_LOCALE,
  catalogLocale,
  formatLocale,
  isPseudoLocale,
  localeDirection,
  type AppLocale,
  type Direction,
  type SupportedLocale,
} from './locales.ts';

/** One namespace file: flat keys (dots allowed) to ICU messages. */
export type Messages = { readonly [key: string]: string };
/** A surface's catalog for one locale: namespace → messages. */
export type Catalog = { readonly [namespace: string]: Messages };
/** Every `namespace.key` of a catalog, as a string literal union. */
export type CatalogKey<C> = {
  [N in keyof C & string]: `${N}.${Exclude<keyof C[N], '$pending'> & string}`;
}[keyof C & string];
/** A translation catalog: any subset of the English keys, plus `$pending` for keys knowingly not yet translated. */
export type PartialCatalog<C> = {
  readonly [N in keyof C]?: { readonly [K in keyof C[N]]?: string } & { readonly $pending?: readonly string[] };
};
export type Catalogs<C> = { readonly en: C } & { readonly [L in Exclude<SupportedLocale, 'en'>]?: PartialCatalog<C> };

export interface MissingEvent {
  /** fallback: the locale lacks the key, English was used. unknown: no catalog has it. argument: a parameter was not supplied. */
  readonly kind: 'fallback' | 'unknown' | 'argument';
  readonly locale: AppLocale;
  readonly key: string;
  readonly argument?: string;
}

export type RelativeUnit = Intl.RelativeTimeFormatUnit;

export interface Translator<Key extends string = string> {
  readonly locale: AppLocale;
  /** BCP 47 tag for `lang` attributes. */
  readonly lang: string;
  readonly dir: Direction;
  /** Translates a key to plain text. Tags keep only their text. */
  t(key: Key, params?: MessageParams): string;
  /** Translates a key whose message has tags; each tag name maps to a renderer. */
  rich<R>(key: Key, params: MessageParams | undefined, tags: TagHandlers<R>): Array<string | R>;
  /** Whether the active locale (or the English fallback) has the key. */
  has(key: string): boolean;
  number(value: number | bigint, options?: Intl.NumberFormatOptions): string;
  percent(value: number, options?: Intl.NumberFormatOptions): string;
  currency(value: number, currency: string, options?: Intl.NumberFormatOptions): string;
  date(value: Date | number | string, options?: Intl.DateTimeFormatOptions | 'short' | 'medium' | 'long' | 'full'): string;
  time(value: Date | number | string, options?: Intl.DateTimeFormatOptions | 'short' | 'medium'): string;
  dateTime(value: Date | number | string, options?: Intl.DateTimeFormatOptions): string;
  relativeTime(value: number, unit: RelativeUnit, options?: Intl.RelativeTimeFormatOptions): string;
  /** "3 minutes ago" / "in 2 days" from `value` relative to `now`, choosing the unit. */
  relativeFrom(value: Date | number | string, now?: Date | number): string;
  list(items: readonly string[], type?: Intl.ListFormatType): string;
  pluralCategory(value: number, ordinal?: boolean): Intl.LDMLPluralRule;
}

export interface TranslatorOptions<C extends Catalog> {
  locale: AppLocale;
  catalogs: Catalogs<C>;
  /** Called for fallbacks, unknown keys and missing arguments. Apps report these in dev and test. */
  onMissing?: (event: MissingEvent) => void;
  /** Wrap string arguments in FSI…PDI. Defaults to true for right-to-left locales. */
  isolateArguments?: boolean;
  /** Clock for relativeFrom; tests pin it. */
  now?: () => number;
}

const instant = (value: Date | number | string) => (value instanceof Date ? value : new Date(value));

export function createTranslator<C extends Catalog>(options: TranslatorOptions<C>): Translator<CatalogKey<C>> {
  const { locale, catalogs } = options;
  const intlLocale = formatLocale(locale);
  const dir = localeDirection(locale);
  const pseudo = isPseudoLocale(locale) ? locale : undefined;
  const source = catalogLocale(locale);
  const report = options.onMissing ?? (() => {});
  const parsed = new Map<string, MessageNode[] | null>();
  const numberFormats = new Map<string, Intl.NumberFormat>();
  const dateFormats = new Map<string, Intl.DateTimeFormat>();
  const pluralRules = new Map<boolean, Intl.PluralRules>();
  const numberFormat = (opts: Intl.NumberFormatOptions = {}) => {
    const cacheKey = JSON.stringify(opts);
    let format = numberFormats.get(cacheKey);
    if (!format) numberFormats.set(cacheKey, (format = new Intl.NumberFormat(intlLocale, opts)));
    return format;
  };
  const dateFormat = (opts: Intl.DateTimeFormatOptions) => {
    const cacheKey = JSON.stringify(opts);
    let format = dateFormats.get(cacheKey);
    if (!format) dateFormats.set(cacheKey, (format = new Intl.DateTimeFormat(intlLocale, opts)));
    return format;
  };
  const pluralCategory = (value: number, ordinal = false) => {
    let rules = pluralRules.get(ordinal);
    if (!rules) pluralRules.set(ordinal, (rules = new Intl.PluralRules(intlLocale, { type: ordinal ? 'ordinal' : 'cardinal' })));
    return rules.select(value);
  };

  const lookup = (catalog: Catalog | PartialCatalog<C> | undefined, key: string): string | undefined => {
    const dot = key.indexOf('.');
    if (dot <= 0) return undefined;
    const namespace = (catalog as Record<string, Record<string, unknown> | undefined> | undefined)?.[key.slice(0, dot)];
    const name = key.slice(dot + 1);
    if (!namespace || name === '$pending' || !Object.hasOwn(namespace, name)) return undefined;
    const message = namespace[name];
    return typeof message === 'string' ? message : undefined;
  };
  const resolve = (key: string): MessageNode[] | null => {
    if (parsed.has(key)) return parsed.get(key)!;
    let message = lookup(source === DEFAULT_LOCALE ? catalogs.en : catalogs[source as Exclude<SupportedLocale, 'en'>], key);
    if (message === undefined && source !== DEFAULT_LOCALE) {
      message = lookup(catalogs.en, key);
      if (message !== undefined) report({ kind: 'fallback', locale, key });
    }
    if (message === undefined) {
      report({ kind: 'unknown', locale, key });
      parsed.set(key, null);
      return null;
    }
    let nodes: MessageNode[];
    try {
      nodes = parseMessage(message);
    } catch {
      // A malformed translation must not break the page; the catalog check rejects it in CI.
      report({ kind: 'unknown', locale, key });
      nodes = [{ type: 'text', value: message }];
    }
    if (pseudo) nodes = pseudoNodes(nodes, pseudo);
    parsed.set(key, nodes);
    return nodes;
  };
  const format = <R>(key: string, params: MessageParams | undefined, tags: TagHandlers<R> | undefined): Array<string | R> => {
    const nodes = resolve(key);
    if (!nodes) return [key];
    const context: FormatContext = {
      locale: intlLocale,
      isolate: options.isolateArguments ?? dir === 'rtl',
      direction: dir,
      number: (value, opts) => numberFormat(opts).format(value),
      date: (value, opts) => dateFormat(opts).format(value),
      pluralCategory,
      onMissingArgument: (argument) => report({ kind: 'argument', locale, key, argument }),
    };
    const parts = formatNodes(nodes, params ?? {}, context, tags);
    if (!pseudo) return parts;
    const frame = pseudoFrame(parts.filter((part): part is string => typeof part === 'string').join(''));
    return [frame.open, ...parts, frame.close];
  };
  const dateOptions = (value: Intl.DateTimeFormatOptions | DateStyleName | undefined, key: 'dateStyle' | 'timeStyle', fallback: DateStyleName) =>
    typeof value === 'string' || value === undefined ? { [key]: value ?? fallback } : value;

  return {
    locale,
    lang: locale,
    dir,
    t: (key, params) => format<never>(key, params, undefined).join(''),
    rich: (key, params, tags) => {
      const parts = format(key, params, tags);
      const merged: typeof parts = [];
      for (const part of parts)
        if (typeof part === 'string' && typeof merged[merged.length - 1] === 'string') merged[merged.length - 1] += part;
        else merged.push(part);
      return merged;
    },
    has: (key) =>
      lookup(catalogs.en, key) !== undefined ||
      (source !== DEFAULT_LOCALE && lookup(catalogs[source as Exclude<SupportedLocale, 'en'>], key) !== undefined),
    number: (value, opts) => numberFormat(opts).format(value),
    percent: (value, opts) => numberFormat({ style: 'percent', ...opts }).format(value),
    currency: (value, currency, opts) => numberFormat({ style: 'currency', currency, ...opts }).format(value),
    date: (value, opts) => dateFormat(dateOptions(opts, 'dateStyle', 'medium')).format(instant(value)),
    time: (value, opts) => dateFormat(dateOptions(opts, 'timeStyle', 'short')).format(instant(value)),
    dateTime: (value, opts) => dateFormat(opts ?? { dateStyle: 'medium', timeStyle: 'short' }).format(instant(value)),
    relativeTime: (value, unit, opts) => new Intl.RelativeTimeFormat(intlLocale, { numeric: 'auto', ...opts }).format(value, unit),
    relativeFrom: (value, now) => {
      const seconds = (instant(value).getTime() - (now === undefined ? (options.now?.() ?? Date.now()) : instant(now).getTime())) / 1000;
      const [amount, unit] = relativeUnit(seconds);
      return new Intl.RelativeTimeFormat(intlLocale, { numeric: 'auto' }).format(amount, unit);
    },
    list: (items, type = 'conjunction') => new Intl.ListFormat(intlLocale, { type }).format(items),
    pluralCategory,
  };
}
type DateStyleName = 'short' | 'medium' | 'long' | 'full';

/** The largest unit that keeps the number readable ("90 minutes" becomes "2 hours"). */
export function relativeUnit(seconds: number): [number, Intl.RelativeTimeFormatUnit] {
  const abs = Math.abs(seconds);
  const round = (value: number) => Math.round(value) || 0;
  if (abs < 45) return [round(seconds), 'second'];
  if (abs < 45 * 60) return [round(seconds / 60), 'minute'];
  if (abs < 22 * 3600) return [round(seconds / 3600), 'hour'];
  if (abs < 26 * 86400) return [round(seconds / 86400), 'day'];
  if (abs < 320 * 86400) return [round(seconds / (30.4375 * 86400)), 'month'];
  return [round(seconds / (365.25 * 86400)), 'year'];
}
