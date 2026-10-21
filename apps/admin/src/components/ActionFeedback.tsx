import type { WorkspaceActions } from "../hooks/useAdmin";
import { useT } from "../i18n";
import { ErrorState, Notice } from "./ui";
export function ActionFeedback({ actions }: { actions: WorkspaceActions }) {
  const t = useT();
  return (
    <>
      {actions.error && (
        <ErrorState error={actions.error} onRetry={actions.refresh} />
      )}
      {actions.receipt && (
        <Notice tone="green">
          <span>{actions.receipt.message}</span>
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
