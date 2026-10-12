import type { WorkspaceActions } from "../hooks/useAdmin";
import { ErrorState, Notice } from "./ui";
export function ActionFeedback({ actions }: { actions: WorkspaceActions }) {
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
              ? "Simulated receipt"
              : "Server receipt"}{" "}
            · {actions.receipt.receipt.id}
          </small>
        </Notice>
      )}
    </>
  );
}
