import { VisualError } from "./visual-error.js";
import { englishErrorMessages } from "./i18n/messages/errors.js";

export { englishErrorMessages };
export type ErrorKey = keyof typeof englishErrorMessages;
type Params<K extends ErrorKey> = Parameters<(typeof englishErrorMessages)[K]>;

/** The English text of a catalog error. */
export function errorText<K extends ErrorKey>(
  key: K,
  ...params: Params<K>
): string {
  return (englishErrorMessages[key] as (...args: Params<K>) => string)(
    ...params,
  );
}
/**
 * A VisualError from the message catalog (0.5): its stable `code`, plus the catalog `key`
 * and `params`, so a host can show its own translation. The message is the English text.
 */
export class VisualCatalogError extends VisualError {
  constructor(
    code: string,
    readonly key: ErrorKey,
    readonly params: Readonly<Record<string, string | number>>,
    message: string,
  ) {
    super(code, message);
  }
}
/** A catalog error with a stable code, a key and its parameters. */
export function visualError<K extends ErrorKey>(
  code: string,
  key: K,
  ...params: Params<K>
): VisualCatalogError {
  return new VisualCatalogError(
    code,
    key,
    Object.freeze({ ...(params[0] ?? {}) }) as Record<string, string | number>,
    errorText(key, ...params),
  );
}
/** English text with its catalog key and parameters, for results that are not thrown. */
export interface CatalogText {
  message: string;
  key: ErrorKey;
  params: Readonly<Record<string, string | number>>;
}
/** A catalog message as data: `message` (English), `key` and `params` for a host's translation. */
export function catalogText<K extends ErrorKey>(
  key: K,
  ...params: Params<K>
): CatalogText {
  return {
    message: errorText(key, ...params),
    key,
    params: Object.freeze({ ...(params[0] ?? {}) }) as Record<
      string,
      string | number
    >,
  };
}
