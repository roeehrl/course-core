import { Suspense, lazy, useState } from "react";
import { Eye } from "lucide-react";
import type { AdminClient, Enrollment } from "../domain/contracts";
import {
  learnerViewErrorMessage,
  type LearnerView,
} from "../domain/learnerView";
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
}: {
  client: AdminClient;
  enrollment: Enrollment;
}) {
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
    <Card title="View as learner" eyebrow="Read-only debugging">
      <p>
        See this learner's path, current lesson, personal changes, gate evidence
        and pending reviews exactly as their app shows them. You cannot act as
        the learner. Each opening is recorded and the learner can see that you
        viewed their record. Their companion conversation and their own notes
        are not shown.
      </p>
      <Button disabled={pending || erased} onClick={() => void open()}>
        <Eye size={16} aria-hidden="true" />{" "}
        {pending ? "Opening…" : "Open read-only learner view"}
      </Button>
      <div aria-live="polite">
        {error !== undefined && (
          <Notice tone="red">{learnerViewErrorMessage(error)}</Notice>
        )}
      </div>
      {view && (
        <Dialog
          title={`${view.learner.displayName} · ${view.snapshot.course.title}`}
          eyebrow="Read-only learner view"
          className="learner-view-dialog"
          onClose={() => setView(undefined)}
        >
          <Suspense fallback={<Loading label="Preparing the learner view…" />}>
            <LearnerViewScreen view={view} />
          </Suspense>
        </Dialog>
      )}
    </Card>
  );
}
