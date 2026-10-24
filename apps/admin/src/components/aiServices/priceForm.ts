import { parseUsd, usdInput } from "../../domain/aiServices";
import type { PriceVersion } from "../../domain/providerCosts";
import type { AiText, FieldError } from "./shared";

/** The price fields of one model block, in the order they are shown. */
export const FIELDS = [
  "input",
  "output",
  "cached",
  "perRequest",
  "perSearch",
  "perVideoSecond",
] as const;
export type PriceField = (typeof FIELDS)[number];
export type PriceForm = Record<PriceField, string> & { source: string };
/** Each field's name on the wire (micro-USD). */
export const WIRE: Record<
  PriceField,
  | "inputMicroUsdPerMillionTokens"
  | "outputMicroUsdPerMillionTokens"
  | "cachedInputMicroUsdPerMillionTokens"
  | "microUsdPerRequest"
  | "microUsdPerServerToolRequest"
  | "microUsdPerOutputSecond"
> = {
  input: "inputMicroUsdPerMillionTokens",
  output: "outputMicroUsdPerMillionTokens",
  cached: "cachedInputMicroUsdPerMillionTokens",
  perRequest: "microUsdPerRequest",
  perSearch: "microUsdPerServerToolRequest",
  perVideoSecond: "microUsdPerOutputSecond",
};

/** A saved price version as editable text. */
export function formOf(
  version: PriceVersion | null,
  source: string,
): PriceForm {
  const form = { source } as PriceForm;
  for (const field of FIELDS)
    form[field] = usdInput(version ? (version[WIRE[field]] ?? null) : null);
  return form;
}

/** Whether any price was entered. */
export const hasPrice = (form: PriceForm) =>
  FIELDS.some((field) => form[field].trim());

/** Field problems of one price form: amounts like 0.30, both token prices or neither, a source. */
export function formProblems(
  form: PriceForm,
  idOf: (field: PriceField | "source") => string,
  t: AiText["t"],
): FieldError[] {
  const problems: FieldError[] = [];
  for (const field of FIELDS)
    if (form[field].trim() && parseUsd(form[field]) === null)
      problems.push({
        field: idOf(field),
        message: t("aiServices.prices.errAmount"),
      });
  if (!!form.input.trim() !== !!form.output.trim())
    problems.push({
      field: idOf(form.input.trim() ? "output" : "input"),
      message: t("aiServices.prices.errBoth"),
    });
  if (form.source.trim().length < 3)
    problems.push({
      field: idOf("source"),
      message: t("aiServices.prices.errSource"),
    });
  return problems;
}

/** The prices of a valid form in micro-USD, null where a field is empty. */
export function wirePrices(form: PriceForm) {
  const value = (field: PriceField) =>
    form[field].trim() ? parseUsd(form[field]) : null;
  return {
    inputMicroUsdPerMillionTokens: value("input"),
    outputMicroUsdPerMillionTokens: value("output"),
    cachedInputMicroUsdPerMillionTokens: value("cached"),
    microUsdPerRequest: value("perRequest"),
    microUsdPerOutputSecond: value("perVideoSecond"),
    microUsdPerServerToolRequest: value("perSearch"),
  };
}

/** "$0.40": a rate for a sentence. */
export const rate = (micro: number | null | undefined) =>
  micro === null || micro === undefined ? "" : `$${usdInput(micro)}`;

/** One line about a later price version of a model. */
export function scheduledText(text: AiText, version: PriceVersion) {
  const { t } = text;
  const date = text.date(version.effectiveFrom);
  if (version.status === "withdrawn")
    return t("aiServices.prices.scheduledWithdrawn", { date });
  if (
    version.inputMicroUsdPerMillionTokens !== null &&
    version.outputMicroUsdPerMillionTokens !== null
  )
    return t("aiServices.prices.scheduledTokens", {
      date,
      input: rate(version.inputMicroUsdPerMillionTokens),
      output: rate(version.outputMicroUsdPerMillionTokens),
    });
  return t("aiServices.prices.scheduledOther", { date });
}

type Priced = Pick<PriceVersion, "status" | (typeof WIRE)[PriceField]> | null;
/** Whether two versions charge the same (no price and a withdrawn price are the same). */
export function samePrice(
  a: Priced | undefined,
  b: Priced | undefined,
): boolean {
  const x = a?.status === "active" ? a : null,
    y = b?.status === "active" ? b : null;
  if (!x || !y) return !x && !y;
  return FIELDS.every(
    (field) => (x[WIRE[field]] ?? null) === (y[WIRE[field]] ?? null),
  );
}
/** The pricing view's later versions of one model, as the view sends them. */
export interface ScheduledModel {
  inForce: PriceVersion | null;
  scheduled?: PriceVersion[] | undefined;
}
/** Later versions that change what the model costs, soonest first. A version that repeats the
 * one before it (left by "Keep the current price") is not a change and is not shown. */
export function scheduledChanges(model: ScheduledModel | undefined) {
  const changes: PriceVersion[] = [];
  let prior: PriceVersion | null = model?.inForce ?? null;
  for (const version of model?.scheduled ?? []) {
    if (!samePrice(prior, version)) changes.push(version);
    prior = version;
  }
  return changes;
}
/** The version in force just before a scheduled one (the one in force now for the first). */
export function priorOf(model: ScheduledModel, version: PriceVersion) {
  const list = model.scheduled ?? [];
  const index = list.findIndex(
    (row) => row.effectiveFrom === version.effectiveFrom,
  );
  return index > 0 ? list[index - 1]! : model.inForce;
}
/**
 * Later versions that only repeat `price`, directly after `after` (or from the first scheduled
 * one). When that price is changed they are saved again with the new price, so a price kept
 * after a removed change follows the change instead of bringing the old price back on that date.
 */
export function repeatsAfter(
  model: ScheduledModel,
  after: string | null,
  price: Priced | undefined,
) {
  const repeats: PriceVersion[] = [];
  for (const version of model.scheduled ?? []) {
    if (
      after !== null &&
      Date.parse(version.effectiveFrom) <= Date.parse(after)
    )
      continue;
    if (!samePrice(version, price)) break;
    repeats.push(version);
  }
  return repeats;
}
/** The request fields that charge like `price` (no price: withdrawn). */
export function pricesOf(price: Priced | undefined) {
  const active = price?.status === "active";
  return {
    status: active ? ("active" as const) : ("withdrawn" as const),
    inputMicroUsdPerMillionTokens: active
      ? (price!.inputMicroUsdPerMillionTokens ?? null)
      : null,
    outputMicroUsdPerMillionTokens: active
      ? (price!.outputMicroUsdPerMillionTokens ?? null)
      : null,
    cachedInputMicroUsdPerMillionTokens: active
      ? (price!.cachedInputMicroUsdPerMillionTokens ?? null)
      : null,
    microUsdPerRequest: active ? (price!.microUsdPerRequest ?? null) : null,
    microUsdPerOutputSecond: active
      ? (price!.microUsdPerOutputSecond ?? null)
      : null,
    microUsdPerServerToolRequest: active
      ? (price!.microUsdPerServerToolRequest ?? null)
      : null,
  };
}
