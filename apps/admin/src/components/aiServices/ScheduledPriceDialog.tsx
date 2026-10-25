import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  parseUsd,
  type AiPricing,
  type AiServicesPort,
  type PriceGroup,
} from "../../domain/aiServices";
import type { PriceVersion } from "../../domain/providerCosts";
import { focusInPlace, lockPageScroll, useMoreBelow } from "../ui";
import {
  ErrorSummary,
  Field,
  Ltr,
  Message,
  described,
  errorText,
  useAiText,
  useRequestKeys,
  type FieldError,
} from "./shared";
import {
  formOf,
  formProblems,
  hasPrice,
  pricesOf,
  rate,
  repeatsAfter,
  wirePrices,
  type PriceField,
  type PriceForm,
} from "./priceForm";

/**
 * Changes a price version scheduled for a later date: one modal at a time, prefilled with the
 * scheduled prices. Saving records a new version at exactly the scheduled time for every model of
 * the block, which replaces the scheduled one from then on; the price in force until then is not
 * touched. The sentence above the buttons says what saving will do before it is pressed.
 */
export function ScheduledPriceDialog({
  group,
  version,
  pricing,
  port,
  workspaceId,
  onClose,
  onSaved,
}: {
  group: PriceGroup;
  version: PriceVersion;
  pricing: AiPricing;
  port: Pick<AiServicesPort, "savePrice">;
  workspaceId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const text = useAiText();
  const { t } = text;
  const ref = useRef<HTMLDialogElement>(null),
    titleId = useId(),
    base = useId().replaceAll(":", "");
  const [form, setForm] = useState<PriceForm>(() =>
    formOf(version, version.sourceNote),
  );
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [failure, setFailure] = useState("");
  const [pending, setPending] = useState(false);
  const keys = useRequestKeys();
  useMoreBelow(ref);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null,
      dialog = ref.current!;
    const unlock = lockPageScroll();
    dialog.showModal();
    return () => {
      dialog.close();
      if (before?.isConnected) focusInPlace(before);
      unlock();
    };
  }, []);
  const date = text.date(version.effectiveFrom);
  const idOf = (field: PriceField | "source") => `${base}-${field}`;
  const extra: PriceField[] = [
    "cached",
    "perRequest",
    ...(group.roles.includes("research") ? (["perSearch"] as const) : []),
    ...(group.roles.includes("media") ? (["perVideoSecond"] as const) : []),
  ];
  const input = parseUsd(form.input),
    output = parseUsd(form.output);
  const preview =
    input !== null && output !== null && form.input.trim() && form.output.trim()
      ? t("aiServices.prices.dialogPreviewTokens", {
          date,
          input: rate(input),
          output: rate(output),
        })
      : t("aiServices.prices.dialogPreview", { date });
  async function save() {
    setFailure("");
    const problems = formProblems(form, idOf, t);
    if (!hasPrice(form))
      problems.unshift({
        field: idOf("input"),
        message: t("aiServices.prices.errNone"),
      });
    setErrors(problems);
    if (problems.length) return;
    setPending(true);
    try {
      for (const modelId of group.modelIds) {
        const model = pricing.models.find((m) => m.modelId === modelId);
        const target = model?.scheduled?.find(
          (v) => v.effectiveFrom === version.effectiveFrom,
        );
        // Exactly the scheduled time: the new version replaces the scheduled one from then on,
        // and later versions that only repeated it follow.
        await saveRun(port, workspaceId, keys, {
          modelId,
          expectedVersion: model?.latestVersion ?? 0,
          prices: pricesOf({ ...wirePrices(form), status: "active" }),
          sourceNote: form.source.trim(),
          at: [
            version.effectiveFrom,
            ...(model && target
              ? repeatsAfter(model, target.effectiveFrom, target).map(
                  (v) => v.effectiveFrom,
                )
              : []),
          ],
        });
      }
      keys.settle();
      onSaved();
    } catch (error) {
      keys.settle(error);
      setFailure(errorText(text, error));
    } finally {
      setPending(false);
    }
  }
  const money = (field: PriceField, label: string) => {
    const id = idOf(field),
      error = errors.find((e) => e.field === id)?.message;
    return (
      <Field id={id} label={label} error={error} key={field}>
        <span className="ai-money" dir="ltr">
          <span aria-hidden="true">$</span>
          <input
            id={id}
            inputMode="decimal"
            autoComplete="off"
            value={form[field]}
            disabled={pending}
            onChange={(event) =>
              setForm((old) => ({ ...old, [field]: event.target.value }))
            }
            {...described(id, false, error)}
          />
        </span>
      </Field>
    );
  };
  const labels: Record<PriceField, string> = {
    input: t("aiServices.prices.input"),
    output: t("aiServices.prices.output"),
    cached: t("aiServices.prices.cached"),
    perRequest: t("aiServices.prices.perRequest"),
    perSearch: t("aiServices.prices.perSearch"),
    perVideoSecond: t("aiServices.prices.perVideoSecond"),
  };
  const sourceError = errors.find((e) => e.field === idOf("source"))?.message;
  return createPortal(
    <dialog
      ref={ref}
      className="dialog ai-confirm ai-price-dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) onClose();
      }}
    >
      <form
        className="ai-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div>
          <h2 id={titleId}>{t("aiServices.prices.dialogTitle", { date })}</h2>
          <p className="ai-muted">
            <Ltr className="mono">{group.remoteModel}</Ltr>
            {" · "}
            {t("aiServices.prices.dialogIntro", { date })}
          </p>
        </div>
        <ErrorSummary errors={errors} />
        <div className="ai-grid">
          {money("input", labels.input)}
          {money("output", labels.output)}
        </div>
        <details open={extra.some((field) => !!form[field].trim())}>
          <summary>{t("aiServices.prices.more")}</summary>
          <div className="ai-grid">
            {extra.map((field) => money(field, labels[field]))}
          </div>
        </details>
        <Field
          id={idOf("source")}
          label={t("aiServices.prices.source")}
          error={sourceError}
        >
          <input
            id={idOf("source")}
            maxLength={500}
            value={form.source}
            disabled={pending}
            onChange={(event) =>
              setForm((old) => ({ ...old, source: event.target.value }))
            }
            {...described(idOf("source"), false, sourceError)}
          />
        </Field>
        <p className="ai-muted ai-price-preview" aria-live="polite">
          {preview}
        </p>
        {failure && <Message tone="error">{failure}</Message>}
        <div className="ai-actions dialog-footer">
          <button
            type="button"
            className="button secondary"
            onClick={onClose}
            disabled={pending}
          >
            {t("aiServices.confirm.cancel")}
          </button>
          <button type="submit" className="button primary" disabled={pending}>
            {pending
              ? t("aiServices.prices.saving")
              : t("aiServices.prices.dialogSave")}
          </button>
        </div>
      </form>
    </dialog>,
    document.body,
  );
}

/**
 * Saves one model's prices at each of `at` in turn (each version after the one before), so a
 * change and the later versions that only repeated the replaced price move together.
 */
export async function saveRun(
  port: Pick<AiServicesPort, "savePrice">,
  workspaceId: string,
  keys: ReturnType<typeof useRequestKeys>,
  run: {
    modelId: string;
    expectedVersion: number;
    prices: ReturnType<typeof pricesOf>;
    sourceNote: string;
    at: readonly string[];
  },
) {
  let expectedVersion = run.expectedVersion;
  for (const effectiveFrom of run.at) {
    const request = {
      modelId: run.modelId,
      expectedVersion,
      currency: "USD" as const,
      ...run.prices,
      sourceNote: run.sourceNote.slice(0, 500),
      effectiveFrom,
    };
    expectedVersion = (
      await port.savePrice(workspaceId, {
        ...request,
        idempotencyKey: keys.key(request),
      })
    ).version;
  }
  return expectedVersion;
}
