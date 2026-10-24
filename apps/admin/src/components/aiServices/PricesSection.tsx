import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ExternalLink } from "lucide-react";
import {
  activeRoles,
  parseUsd,
  priceGroups,
  usdInput,
  type PriceGroup,
  type SectionState,
  type SuggestedPrice,
} from "../../domain/aiServices";
import type { SectionProps } from "./AiServicesPage";
import {
  ErrorSummary,
  Field,
  Ltr,
  Message,
  Section,
  described,
  errorText,
  jobName,
  useRequestKeys,
  serviceName,
  useAiText,
  type FieldError,
} from "./shared";
import { ChangedElsewhere } from "../ChangedElsewhere";
import { useEditableSnapshot } from "../../hooks/useEditableSnapshot";

type Props = SectionProps & { state: SectionState; unsaved: boolean };
const FIELDS = [
  "input",
  "output",
  "cached",
  "perRequest",
  "perSearch",
  "perVideoSecond",
] as const;
type PriceField = (typeof FIELDS)[number];
type Form = Record<PriceField, string> & { source: string };
/** A scheduled price change this close is called out as a warning. */
export const CHANGE_WARNING_DAYS = 60;
const DAY_MS = 86_400_000;
const TABLE_FIELDS: Partial<Record<PriceField, keyof SuggestedPrice>> = {
  input: "inputMicroUsdPerMillionTokens",
  output: "outputMicroUsdPerMillionTokens",
  cached: "cachedInputMicroUsdPerMillionTokens",
};
const WIRE: Record<PriceField, string> = {
  input: "inputMicroUsdPerMillionTokens",
  output: "outputMicroUsdPerMillionTokens",
  cached: "cachedInputMicroUsdPerMillionTokens",
  perRequest: "microUsdPerRequest",
  perSearch: "microUsdPerServerToolRequest",
  perVideoSecond: "microUsdPerOutputSecond",
};

export function PricesSection(props: Props) {
  const text = useAiText();
  const { t } = text;
  const { data, port, workspaceId, reload, onDirty } = props;
  const base = useId().replaceAll(":", "");
  const active = useMemo(
    () => activeRoles(data.setup.configuration),
    [data.setup.configuration],
  );
  const groups = useMemo(
    () => priceGroups(active, data.draft, data.pricing),
    [active, data.draft, data.pricing],
  );
  const kindOf = (group: PriceGroup) =>
    data.connections.connections.find((c) => c.id === group.connectionId)
      ?.kind ??
    (
      data.setup.configuration as { adapters?: { id: string; kind: string }[] }
    )?.adapters?.find((a) => a.id === group.connectionId)?.kind ??
    "";
  const today = text.date(new Date());
  /** The bundled table's price for a group's model, when Core knows it. */
  const suggestionFor = (group: PriceGroup) =>
    data.pricing?.models.find(
      (m) => group.modelIds.includes(m.modelId) && m.suggested,
    )?.suggested ?? null;
  const initial = useMemo(() => {
    const result: Record<string, Form> = {};
    for (const group of groups) {
      const current = data.pricing?.models.find(
        (m) => group.modelIds.includes(m.modelId) && m.inForce,
      )?.inForce;
      // An unpriced model Core knows is prefilled from the table; the owner confirms and saves.
      const table = current ? null : suggestionFor(group);
      const form = {
        source:
          current?.sourceNote ??
          (table
            ? t("aiServices.prices.sourceTable", {
                service: serviceName(t, table.service),
                date: text.date(`${table.checkedOn}T12:00:00Z`),
                url: table.url,
              })
            : t("aiServices.prices.sourceDefault", {
                service: serviceName(t, kindOf(group)),
                date: today,
              })),
      } as Form;
      for (const field of FIELDS) {
        const fromTable = table && TABLE_FIELDS[field];
        form[field] = usdInput(
          fromTable
            ? (table[fromTable] as number | null)
            : ((current?.[WIRE[field] as keyof typeof current] as
                number | null | undefined) ?? null),
        );
      }
      result[group.key] = form;
    }
    return result;
  }, [groups, data.pricing]);
  /** Groups prefilled from the table and not priced yet: saving them is the owner's confirmation. */
  const prefilled = groups
    .filter((g) => !g.priced && !!suggestionFor(g))
    .map((g) => g.key);
  // Until the owner edits a price the form shows the saved (or table) prices, derived rather
  // than copied in, so a price typed the moment the section appears or while the page reloads
  // is kept (see useEditableSnapshot).
  const snapshot = useEditableSnapshot(initial);
  const forms = snapshot.value;
  const dirtyKeys = groups
    .filter(
      (g) =>
        snapshot.edited &&
        JSON.stringify(forms[g.key]) !== JSON.stringify(initial[g.key]),
    )
    .map((g) => g.key);
  const savable = groups
    .filter((g) => dirtyKeys.includes(g.key) || prefilled.includes(g.key))
    .map((g) => g.key);
  useEffect(() => onDirty(dirtyKeys.length > 0), [dirtyKeys.length, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [message, setMessage] = useState<{
    tone: "ok" | "error";
    text: string;
  }>();
  const [saving, setSaving] = useState(false);
  const keys = useRequestKeys();
  const times = useRef(new Map<string, string>());
  const effective = (id: string) => {
    let value = times.current.get(id);
    if (!value) times.current.set(id, (value = new Date().toISOString()));
    return value;
  };
  const kinds = [...new Set(groups.map(kindOf).filter(Boolean))];
  if (!groups.length)
    return (
      <Section
        id="prices"
        title={t("aiServices.section.prices")}
        state={props.state}
        unsaved={props.unsaved}
      >
        <p>{t("aiServices.prices.nothing")}</p>
      </Section>
    );
  const fieldId = (group: PriceGroup, field: string) =>
    `${base}-${groups.indexOf(group)}-${field}`;
  function validate() {
    const problems: FieldError[] = [];
    for (const group of groups) {
      if (!savable.includes(group.key) && group.priced) continue;
      const form = forms[group.key]!;
      const any = FIELDS.some((f) => form[f].trim());
      if (!any) continue;
      for (const field of FIELDS)
        if (form[field].trim() && parseUsd(form[field]) === null)
          problems.push({
            field: fieldId(group, field),
            message: t("aiServices.prices.errAmount"),
          });
      if (!!form.input.trim() !== !!form.output.trim())
        problems.push({
          field: fieldId(group, form.input.trim() ? "output" : "input"),
          message: t("aiServices.prices.errBoth"),
        });
      if (form.source.trim().length < 3)
        problems.push({
          field: fieldId(group, "source"),
          message: t("aiServices.prices.errSource"),
        });
    }
    return problems;
  }
  async function save() {
    setMessage(undefined);
    const problems = validate();
    setErrors(problems);
    if (problems.length || snapshot.changedElsewhere) return;
    setSaving(true);
    try {
      for (const group of groups) {
        if (!savable.includes(group.key)) continue;
        const form = forms[group.key]!;
        if (!FIELDS.some((f) => form[f].trim())) continue;
        const table = suggestionFor(group);
        // The announced change is saved too, from its date, when the owner kept the table's prices.
        const change =
          table?.change &&
          (Object.keys(TABLE_FIELDS) as PriceField[]).every(
            (f) =>
              (parseUsd(form[f]) ?? null) ===
              (table[TABLE_FIELDS[f]!] as number | null),
          )
            ? table.change
            : null;
        for (const modelId of group.modelIds) {
          const model = data.pricing?.models.find((m) => m.modelId === modelId);
          const prices = Object.fromEntries(
            FIELDS.map((f) => [
              WIRE[f],
              form[f].trim() ? parseUsd(form[f]) : null,
            ]),
          );
          const request = {
            modelId,
            expectedVersion: model?.latestVersion ?? 0,
            status: "active" as const,
            currency: "USD" as const,
            inputMicroUsdPerMillionTokens:
              prices.inputMicroUsdPerMillionTokens ?? null,
            outputMicroUsdPerMillionTokens:
              prices.outputMicroUsdPerMillionTokens ?? null,
            cachedInputMicroUsdPerMillionTokens:
              prices.cachedInputMicroUsdPerMillionTokens ?? null,
            microUsdPerRequest: prices.microUsdPerRequest ?? null,
            microUsdPerOutputSecond: prices.microUsdPerOutputSecond ?? null,
            microUsdPerServerToolRequest:
              prices.microUsdPerServerToolRequest ?? null,
            sourceNote: form.source.trim(),
          };
          const id = keys.key(request);
          const saved = await port.savePrice(workspaceId, {
            ...request,
            idempotencyKey: id,
            effectiveFrom: effective(id),
          });
          if (change) {
            const next = {
              ...request,
              expectedVersion: saved.version,
              inputMicroUsdPerMillionTokens:
                change.inputMicroUsdPerMillionTokens,
              outputMicroUsdPerMillionTokens:
                change.outputMicroUsdPerMillionTokens,
              cachedInputMicroUsdPerMillionTokens:
                change.cachedInputMicroUsdPerMillionTokens,
              sourceNote: t("aiServices.prices.sourceChange", {
                source: form.source.trim(),
                date: text.date(`${change.from}T12:00:00Z`),
              }).slice(0, 500),
            };
            const nextId = keys.key(next);
            await port.savePrice(workspaceId, {
              ...next,
              idempotencyKey: nextId,
              effectiveFrom: new Date(`${change.from}T00:00:00Z`).toISOString(),
            });
          }
        }
      }
      keys.settle();
      snapshot.settle();
      setMessage({ tone: "ok", text: t("aiServices.prices.saved") });
      await reload();
    } catch (error) {
      keys.settle(error);
      setMessage({ tone: "error", text: errorText(text, error) });
    } finally {
      setSaving(false);
    }
  }
  const update = (group: PriceGroup, field: keyof Form, value: string) => {
    snapshot.set((current) => ({
      ...current,
      [group.key]: { ...current[group.key]!, [field]: value },
    }));
  };
  const money = (group: PriceGroup, field: PriceField, label: string) => {
    const id = fieldId(group, field),
      error = errors.find((e) => e.field === id)?.message;
    return (
      <Field id={id} label={label} error={error}>
        <span className="ai-money" dir="ltr">
          <span aria-hidden="true">$</span>
          <input
            id={id}
            inputMode="decimal"
            autoComplete="off"
            value={forms[group.key]?.[field] ?? ""}
            disabled={saving}
            onChange={(event) => update(group, field, event.target.value)}
            {...described(id, false, error)}
          />
        </span>
      </Field>
    );
  };
  return (
    <Section
      id="prices"
      title={t("aiServices.section.prices")}
      state={props.state}
      unsaved={props.unsaved}
    >
      {kinds.map((kind) => {
        const service = serviceName(t, kind);
        const url = data.setup.metadataKinds.find(
          (k) => k.kind === kind,
        )?.pricingUrl;
        return (
          <p key={kind}>
            {t("aiServices.prices.intro", { service })}{" "}
            {url && (
              <a href={url} target="_blank" rel="noreferrer noopener">
                {t("aiServices.prices.openPricing", { service })}
                <ExternalLink size={13} aria-hidden="true" />
                <span className="sr-only">
                  {" "}
                  {t("aiServices.connect.newTab")}
                </span>
              </a>
            )}
          </p>
        );
      })}
      <form
        className="ai-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <ErrorSummary errors={errors} />
        {groups.map((group) => {
          const current = data.pricing?.models.find(
            (m) => group.modelIds.includes(m.modelId) && m.inForce,
          )?.inForce;
          const listName = group.remoteModel;
          return (
            <fieldset className="ai-price" key={group.key}>
              <legend>
                <Ltr className="mono">{listName}</Ltr>
                <span className="ai-muted">
                  {" "}
                  ·{" "}
                  {t("aiServices.prices.usedBy", {
                    roles: text.list(group.roles.map((r) => jobName(t, r))),
                  })}
                </span>
              </legend>
              {current && (
                <p className="ai-muted">
                  {t("aiServices.prices.current", {
                    date: text.date(current.effectiveFrom),
                  })}
                </p>
              )}
              {!group.priced && (
                <p className="ai-muted">{t("aiServices.prices.missingNote")}</p>
              )}
              <TableNote
                suggestion={suggestionFor(group)}
                prefilled={prefilled.includes(group.key)}
              />
              <div className="ai-grid">
                {money(group, "input", t("aiServices.prices.input"))}
                {money(group, "output", t("aiServices.prices.output"))}
              </div>
              <details>
                <summary>{t("aiServices.prices.more")}</summary>
                <div className="ai-grid">
                  {money(group, "cached", t("aiServices.prices.cached"))}
                  {money(
                    group,
                    "perRequest",
                    t("aiServices.prices.perRequest"),
                  )}
                  {group.roles.includes("research") &&
                    money(group, "perSearch", t("aiServices.prices.perSearch"))}
                  {group.roles.includes("media") &&
                    money(
                      group,
                      "perVideoSecond",
                      t("aiServices.prices.perVideoSecond"),
                    )}
                </div>
              </details>
              <Field
                id={fieldId(group, "source")}
                label={t("aiServices.prices.source")}
                error={
                  errors.find((e) => e.field === fieldId(group, "source"))
                    ?.message
                }
              >
                <input
                  id={fieldId(group, "source")}
                  dir="auto"
                  maxLength={500}
                  value={forms[group.key]?.source ?? ""}
                  disabled={saving}
                  onChange={(event) =>
                    update(group, "source", event.target.value)
                  }
                />
              </Field>
            </fieldset>
          );
        })}
        {message && <Message tone={message.tone}>{message.text}</Message>}
        {snapshot.changedElsewhere && (
          <ChangedElsewhere
            disabled={saving}
            onShowSaved={snapshot.discard}
            onKeep={snapshot.keep}
          />
        )}
        <div className="ai-actions">
          <button
            type="submit"
            className="button primary"
            disabled={saving || !savable.length || snapshot.changedElsewhere}
          >
            {saving
              ? t("aiServices.prices.saving")
              : t("aiServices.prices.save")}
          </button>
        </div>
      </form>
    </Section>
  );
}

const rate = (micro: number | null) =>
  micro === null ? "" : `$${usdInput(micro)}`;
/** Where a prefilled price came from, its long-prompt tier, and an announced change. */
function TableNote({
  suggestion,
  prefilled,
}: {
  suggestion: SuggestedPrice | null;
  prefilled: boolean;
}) {
  const text = useAiText();
  const { t } = text;
  if (!suggestion) return null;
  const service = serviceName(t, suggestion.service);
  const change = suggestion.change;
  const days = change
    ? (Date.parse(`${change.from}T00:00:00Z`) - Date.now()) / DAY_MS
    : Infinity;
  const changeText = change
    ? t("aiServices.prices.changeNote", {
        service,
        date: text.date(`${change.from}T12:00:00Z`),
        input: rate(change.inputMicroUsdPerMillionTokens),
        output: rate(change.outputMicroUsdPerMillionTokens),
      })
    : null;
  return (
    <>
      {prefilled && (
        <p className="ai-price-suggestion">
          {t("aiServices.prices.fromTable", {
            service,
            date: text.date(`${suggestion.checkedOn}T12:00:00Z`),
          })}{" "}
          <a href={suggestion.url} target="_blank" rel="noreferrer noopener">
            {t("aiServices.prices.openPricing", { service })}
            <span className="sr-only"> {t("aiServices.connect.newTab")}</span>
          </a>
        </p>
      )}
      {prefilled && suggestion.promptTokensUpTo !== null && (
        <p className="ai-muted">
          {t("aiServices.prices.tierNote", {
            tokens: suggestion.promptTokensUpTo,
          })}
        </p>
      )}
      {changeText &&
        (days <= CHANGE_WARNING_DAYS ? (
          <Message tone="warn">
            {changeText}{" "}
            {prefilled
              ? t("aiServices.prices.changeSaved")
              : t("aiServices.prices.changeUpdate")}
          </Message>
        ) : (
          prefilled && (
            <p className="ai-muted">
              {changeText} {t("aiServices.prices.changeSaved")}
            </p>
          )
        ))}
    </>
  );
}
