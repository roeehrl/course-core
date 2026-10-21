import { Suspense, lazy, useState } from "react";
import { Eye } from "lucide-react";
import type { AdminClient, Enrollment, Permission } from "../domain/contracts";
import {
  learnerViewErrorMessage,
  type LearnerView,
} from "../domain/learnerView";
import { useT } from "../i18n";
import { Button, Card, Dialog, Loading, Notice } from "./ui";

// The renderer (with the visual runtime) loads only when a view is opened.
const LearnerViewScreen = lazy(() =>
  import("./LearnerViewScreen").then((module) => ({
    default: module.LearnerViewScreen,
  })),
);

/** Owner/admin entry point to the read-only, audited "view as learner". */
export function LearnerViewCard({
  client,
  enrollment,
  permissions = [],
}: {
  client: AdminClient;
  enrollment: Enrollment;
  /** With run.inspect, each block of the view opens the debug inspector. */
  permissions?: readonly Permission[];
}) {
  const t = useT();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const [view, setView] = useState<LearnerView>();
  if (!client.learnerView) return null;
  const port = client.learnerView;
  const erased = enrollment.status === "erased";
  async function open() {
    setPending(true);
    setError(undefined);
    try {
      setView(await port.open(enrollment.id));
    } catch (caught) {
      setError(caught);
    } finally {
      setPending(false);
    }
  }
  return (
    <Card
      title={t("learnerViewCard.title")}
      eyebrow={t("learnerViewCard.eyebrow")}
    >
      <p>{t("learnerViewCard.intro")}</p>
      <Button disabled={pending || erased} onClick={() => void open()}>
        <Eye size={16} aria-hidden="true" />{" "}
        {pending ? t("learnerViewCard.opening") : t("learnerViewCard.open")}
      </Button>
      <div aria-live="polite">
        {error !== undefined && (
          <Notice tone="red">{learnerViewErrorMessage(error, t)}</Notice>
        )}
      </div>
      {view && (
        <Dialog
          title={t("learnerViewCard.dialog.title", {
            learner: view.learner.displayName,
            course: view.snapshot.course.title,
          })}
          eyebrow={t("learnerViewCard.dialog.eyebrow")}
          className="learner-view-dialog"
          onClose={() => setView(undefined)}
        >
          <Suspense
            fallback={<Loading label={t("learnerViewCard.preparing")} />}
          >
            <LearnerViewScreen
              view={view}
              inspector={
                permissions.includes("run.inspect")
                  ? { client, enrollmentId: enrollment.id, permissions }
                  : undefined
              }
            />
          </Suspense>
        </Dialog>
      )}
    </Card>
  );
}
