import { useId, useState } from "react";
import { Download } from "lucide-react";
import {
  platformErrorMessage,
  type AuditExportQuery,
  type PlatformPort,
} from "../domain/platform";
import { Button, Card, Field, Notice } from "./ui";
import { useT } from "../i18n";

const day = (offset = 0) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

/** Downloads the audit log for a date range as CSV (spreadsheets) or JSON. The file has the same
 * privacy rule as the page, and the download itself is recorded in the log. */
export function AuditExport({
  port,
  workspaceId,
}: {
  port: PlatformPort;
  workspaceId: string;
}) {
  const t = useT();
  const id = useId();
  const [query, setQuery] = useState<AuditExportQuery>({
    format: "csv",
    from: day(-30),
    to: day(),
  });
  const [state, setState] = useState<{
    pending: boolean;
    error?: unknown;
    done?: { rows: number; truncated: boolean; digest: string };
  }>({ pending: false });
  const update = (change: Partial<AuditExportQuery>) => {
    setQuery({ ...query, ...change });
    setState({ pending: false });
  };
  return (
    <Card title={t("auditExport.title")} eyebrow={t("auditExport.eyebrow")}>
      <p>{t("auditExport.intro")}</p>
      <form
        className="stack"
        onSubmit={async (event) => {
          event.preventDefault();
          setState({ pending: true });
          try {
            const file = await port.exportAudit(workspaceId, query);
            const url = URL.createObjectURL(file.body);
            const link = document.createElement("a");
            link.href = url;
            link.download = file.fileName;
            document.body.append(link);
            link.click();
            link.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            setState({
              pending: false,
              done: {
                rows: file.rows,
                truncated: file.truncated,
                digest: file.digest,
              },
            });
          } catch (error) {
            setState({ pending: false, error });
          }
        }}
      >
        <div className="form-grid">
          <Field label={t("auditExport.formatLabel")} htmlFor={`${id}-format`}>
            <select
              id={`${id}-format`}
              value={query.format}
              onChange={(e) =>
                update({ format: e.target.value as AuditExportQuery["format"] })
              }
            >
              <option value="csv">{t("auditExport.format.csv")}</option>
              <option value="json">{t("auditExport.format.json")}</option>
            </select>
          </Field>
          <Field label={t("auditExport.from")} htmlFor={`${id}-from`}>
            <input
              id={`${id}-from`}
              type="date"
              required
              value={query.from}
              max={query.to}
              onChange={(e) => update({ from: e.target.value })}
            />
          </Field>
          <Field label={t("auditExport.to")} htmlFor={`${id}-to`}>
            <input
              id={`${id}-to`}
              type="date"
              required
              value={query.to}
              min={query.from}
              onChange={(e) => update({ to: e.target.value })}
            />
          </Field>
          <Field label={t("auditExport.whoLabel")} htmlFor={`${id}-who`}>
            <select
              id={`${id}-who`}
              value={query.actorKind ?? ""}
              onChange={(e) => {
                const { actorKind: _omit, ...rest } = query;
                const value = e.target.value as
                  NonNullable<AuditExportQuery["actorKind"]> | "";
                setQuery(value ? { ...rest, actorKind: value } : rest);
                setState({ pending: false });
              }}
            >
              <option value="">{t("auditExport.who.everyone")}</option>
              <option value="staff">{t("auditExport.who.staff")}</option>
              <option value="system">{t("auditExport.who.system")}</option>
              <option value="learner">{t("auditExport.who.learner")}</option>
              <option value="agent">{t("auditExport.who.agent")}</option>
            </select>
          </Field>
        </div>
        <small>{t("auditExport.limits")}</small>
        {state.error !== undefined && (
          <Notice tone="red">{platformErrorMessage(state.error, t)}</Notice>
        )}
        {state.done && (
          <Notice tone={state.done.truncated ? "gold" : "green"}>
            {state.done.truncated
              ? t("auditExport.truncated", { rows: state.done.rows })
              : t("auditExport.done", { rows: state.done.rows })}{" "}
            <small className="mono" dir="ltr">
              {state.done.digest.slice(0, 16)}
            </small>
          </Notice>
        )}
        <Button
          type="submit"
          kind="primary"
          disabled={state.pending || !query.from || !query.to}
        >
          <Download size={16} aria-hidden="true" />
          {state.pending
            ? t("auditExport.downloading")
            : t("auditExport.download")}
        </Button>
      </form>
    </Card>
  );
}
