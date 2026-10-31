import { useId, useState } from "react";
import { usd } from "../domain/media";
import { randomId } from "../domain/webCrypto";
import {
  parseDollars,
  platformErrorMessage,
  type Billing,
  type PlatformPort,
} from "../domain/platform";
import { useRemote } from "../hooks/useAdmin";
import { Button, Card, Field, Loading, Notice } from "./ui";
import { useFormatters, useI18n, useT } from "../i18n";

const today = () => new Date().toISOString().slice(0, 10);
const newKey = () => `bill-${randomId()}`;

/** Provider-billed amounts typed in from the provider's own invoice or usage page, each next to
 * this workspace's estimate for the same days. Estimates use the operator's price list; only a
 * typed-in statement is what a provider actually charged. */
export function BilledCosts({
  port,
  workspaceId,
}: {
  port: PlatformPort;
  workspaceId: string;
}) {
  const t = useT();
  const remote = useRemote(
    (signal) => port.billing(workspaceId, signal),
    [port, workspaceId],
  );
  const [saved, setSaved] = useState<Billing>();
  const view = saved ?? remote.data;
  return (
    <Card title={t("billedCosts.title")} eyebrow={t("billedCosts.eyebrow")}>
      <Notice tone="blue">{t("billedCosts.explain")}</Notice>
      <StatementForm port={port} workspaceId={workspaceId} onSaved={setSaved} />
      {remote.loading && !view ? (
        <Loading label={t("billedCosts.loading")} />
      ) : remote.error && !view ? (
        <Notice tone="red">{platformErrorMessage(remote.error, t)}</Notice>
      ) : view && view.statements.length === 0 ? (
        <p>{t("billedCosts.empty")}</p>
      ) : (
        view && <Statements value={view} />
      )}
    </Card>
  );
}

function StatementForm({
  port,
  workspaceId,
  onSaved,
}: {
  port: PlatformPort;
  workspaceId: string;
  onSaved: (value: Billing) => void;
}) {
  const t = useT();
  const id = useId();
  const [form, setForm] = useState({
    providerLabel: "",
    periodStart: today(),
    periodEnd: today(),
    amount: "",
    sourceNote: "",
  });
  const [key, setKey] = useState(newKey);
  const [state, setState] = useState<{
    pending: boolean;
    error?: unknown;
    done?: boolean;
  }>({ pending: false });
  const amount = parseDollars(form.amount);
  const set = (field: keyof typeof form) => (value: string) => {
    setForm({ ...form, [field]: value });
    setState({ pending: false });
  };
  return (
    <form
      className="stack billed-form"
      onSubmit={async (event) => {
        event.preventDefault();
        if (amount === null) return;
        setState({ pending: true });
        try {
          const result = await port.recordBilled(workspaceId, {
            idempotencyKey: key,
            providerLabel: form.providerLabel.trim(),
            periodStart: form.periodStart,
            periodEnd: form.periodEnd,
            billedMicroUsd: amount,
            sourceNote: form.sourceNote.trim(),
          });
          onSaved(result);
          setState({ pending: false, done: true });
          setKey(newKey());
          setForm({ ...form, amount: "", sourceNote: "" });
        } catch (error) {
          setState({ pending: false, error });
        }
      }}
    >
      <div className="form-grid">
        <Field
          label={t("billedCosts.provider")}
          htmlFor={`${id}-provider`}
          hint={t("billedCosts.providerHint")}
        >
          <input
            id={`${id}-provider`}
            value={form.providerLabel}
            required
            maxLength={64}
            pattern="[A-Za-z0-9][A-Za-z0-9 ._\-]*"
            onChange={(e) => set("providerLabel")(e.target.value)}
          />
        </Field>
        <Field label={t("billedCosts.from")} htmlFor={`${id}-from`}>
          <input
            id={`${id}-from`}
            type="date"
            value={form.periodStart}
            required
            onChange={(e) => set("periodStart")(e.target.value)}
          />
        </Field>
        <Field label={t("billedCosts.to")} htmlFor={`${id}-to`}>
          <input
            id={`${id}-to`}
            type="date"
            value={form.periodEnd}
            required
            min={form.periodStart}
            onChange={(e) => set("periodEnd")(e.target.value)}
          />
        </Field>
        <Field
          label={t("billedCosts.amount")}
          htmlFor={`${id}-amount`}
          hint={t("billedCosts.amountHint")}
        >
          <input
            id={`${id}-amount`}
            inputMode="decimal"
            dir="ltr"
            value={form.amount}
            required
            aria-invalid={form.amount !== "" && amount === null}
            onChange={(e) => set("amount")(e.target.value)}
          />
        </Field>
      </div>
      <Field
        label={t("billedCosts.source")}
        htmlFor={`${id}-source`}
        hint={t("billedCosts.sourceHint")}
      >
        <input
          id={`${id}-source`}
          value={form.sourceNote}
          required
          minLength={3}
          maxLength={300}
          onChange={(e) => set("sourceNote")(e.target.value)}
        />
      </Field>
      {form.amount !== "" && amount === null && (
        <Notice tone="gold">{t("billedCosts.amountInvalid")}</Notice>
      )}
      {state.error !== undefined && (
        <Notice tone="red">{platformErrorMessage(state.error, t)}</Notice>
      )}
      {state.done && <Notice tone="green">{t("billedCosts.saved")}</Notice>}
      <Button
        type="submit"
        kind="primary"
        disabled={state.pending || amount === null}
      >
        {state.pending ? t("billedCosts.saving") : t("billedCosts.save")}
      </Button>
    </form>
  );
}

function Statements({ value }: { value: Billing }) {
  const i18n = useI18n();
  const t = i18n.t;
  const { when } = useFormatters();
  return (
    <div
      className="table-wrap"
      tabIndex={0}
      role="region"
      aria-label={t("billedCosts.table")}
    >
      <table className="data-table">
        <caption>{t("billedCosts.table")}</caption>
        <thead>
          <tr>
            <th scope="col">{t("billedCosts.col.period")}</th>
            <th scope="col" className="num">
              {t("billedCosts.col.billed")}
            </th>
            <th scope="col" className="num">
              {t("billedCosts.col.estimated")}
            </th>
            <th scope="col">{t("billedCosts.col.difference")}</th>
            <th scope="col">{t("billedCosts.col.source")}</th>
          </tr>
        </thead>
        <tbody>
          {value.statements.map((s) => (
            <tr key={s.id}>
              <th scope="row">
                <bdi>{s.providerLabel}</bdi>
                <br />
                <small dir="ltr">
                  {t("billedCosts.period", {
                    from: s.periodStart,
                    to: s.periodEnd,
                  })}
                </small>
              </th>
              <td className="num">{usd(s.billedMicroUsd, i18n)}</td>
              <td className="num">
                {usd(s.estimate.chargedMicroUsd, i18n)}
                <br />
                <small>
                  {t("billedCosts.calls", { count: s.estimate.calls })}
                </small>
                {s.estimate.unsettledMicroUsd > 0 && (
                  <>
                    <br />
                    <small>
                      {t("billedCosts.unsettled", {
                        amount: usd(s.estimate.unsettledMicroUsd, i18n),
                      })}
                    </small>
                  </>
                )}
              </td>
              <td>
                {s.differenceMicroUsd === 0
                  ? t("billedCosts.match")
                  : s.differenceMicroUsd > 0
                    ? t("billedCosts.over", {
                        amount: usd(s.differenceMicroUsd, i18n),
                      })
                    : t("billedCosts.under", {
                        amount: usd(-s.differenceMicroUsd, i18n),
                      })}
              </td>
              <td>
                <bdi>{s.sourceNote}</bdi>
                <br />
                <small>
                  {t("billedCosts.recorded", {
                    who: s.recordedBy,
                    at: when(s.recordedAt),
                  })}
                </small>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
