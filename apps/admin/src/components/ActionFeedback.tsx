import type { WorkspaceActions } from "../hooks/useAdmin";
import { useI18n } from "../i18n";
import { serverMessageText } from "../domain/serverMessages";
import { ErrorState, Notice } from "./ui";
export function ActionFeedback({ actions }: { actions: WorkspaceActions }) {
  const i18n = useI18n();
  const { t } = i18n;
  return (
    <>
      {actions.error && (
        <ErrorState error={actions.error} onRetry={actions.refresh} />
      )}
      {actions.receipt && (
        <Notice tone="green">
          <span>{serverMessageText(i18n, actions.receipt.message)}</span>
          <small className="receipt">
            {actions.receipt.receipt.authority === "demo"
              ? t("actionFeedback.demoReceipt")
              : t("actionFeedback.serverReceipt")}{" "}
            · <span dir="ltr">{actions.receipt.receipt.id}</span>
          </small>
        </Notice>
      )}
    </>
  );
}
