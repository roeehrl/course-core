import { useEffect, useId, useState } from "react";
import {
  SUPPORTED_LOCALES,
  localeInfo,
  type SupportedLocale,
} from "@course-core/i18n";
import { useT } from "../i18n";
import { fetchWorkspaceLocale, saveWorkspaceLocale } from "../i18n/localeApi";
import { Button, Card, Field, Notice } from "./ui";

export interface OwnedWorkspace {
  id: string;
  title: string;
}

/** Owner setting: the language a workspace's people see until they choose their own. */
export function WorkspaceLocaleSetting({
  workspaces,
  headers,
  onClose,
}: {
  workspaces: OwnedWorkspace[];
  headers: () => HeadersInit;
  onClose: () => void;
}) {
  const t = useT();
  return (
    <Card title={t("workspaceLocaleSetting.title")} className="change-password">
      <p>{t("workspaceLocaleSetting.description")}</p>
      {workspaces.map((workspace) => (
        <WorkspaceRow
          key={workspace.id}
          workspace={workspace}
          headers={headers}
        />
      ))}
      <div className="tag-row">
        <Button type="button" onClick={onClose}>
          {t("workspaceLocaleSetting.close")}
        </Button>
      </div>
    </Card>
  );
}

function WorkspaceRow({
  workspace,
  headers,
}: {
  workspace: OwnedWorkspace;
  headers: () => HeadersInit;
}) {
  const t = useT();
  const id = useId();
  const [value, setValue] = useState<SupportedLocale | "" | undefined>();
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "failed">(
    "idle",
  );
  useEffect(() => {
    let live = true;
    fetchWorkspaceLocale(workspace.id)
      .then((result) => live && setValue(result.defaultLocale ?? ""))
      .catch(() => live && setStatus("failed"));
    return () => {
      live = false;
    };
  }, [workspace.id]);
  return (
    <div className="stack">
      <Field
        label={t("workspaceLocaleSetting.field", {
          workspace: workspace.title,
        })}
        htmlFor={id}
      >
        <select
          id={id}
          value={value ?? ""}
          disabled={value === undefined || status === "saving"}
          onChange={(event) => {
            const next = event.target.value as SupportedLocale | "";
            setValue(next);
            setStatus("saving");
            saveWorkspaceLocale(workspace.id, next || null, headers())
              .then(() => setStatus("saved"))
              .catch(() => setStatus("failed"));
          }}
        >
          <option value="">{t("workspaceLocaleSetting.none")}</option>
          {SUPPORTED_LOCALES.map((locale) => (
            <option key={locale} value={locale} lang={locale}>
              {localeInfo(locale).nativeName}
            </option>
          ))}
        </select>
      </Field>
      {status === "saved" && (
        <Notice tone="green">{t("workspaceLocaleSetting.saved")}</Notice>
      )}
      {status === "failed" && (
        <Notice tone="red">{t("workspaceLocaleSetting.failed")}</Notice>
      )}
    </div>
  );
}
