import { useId, useState } from "react";
import { Download, Eraser } from "lucide-react";
import type { AdminClient, Enrollment } from "../domain/contracts";
import { learnerDataErrorMessage } from "../domain/learnerData";
import { Button, Card, Field, Notice } from "./ui";

/** Owner/admin data requests for one enrollment. Erasure is irreversible. */
export function LearnerDataCard({
  client,
  enrollment,
  onErased,
}: {
  client: AdminClient;
  enrollment: Enrollment;
  onErased: () => void;
}) {
  const id = useId();
  const phrase = `ERASE ${enrollment.id.slice(0, 8)}`;
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<unknown>();
  const [confirmation, setConfirmation] = useState("");
  const [reason, setReason] = useState("");
  if (!client.learnerData) return null;
  const port = client.learnerData;
  async function act(work: () => Promise<void>) {
    setPending(true);
    setError(undefined);
    setMessage("");
    try {
      await work();
    } catch (caught) {
      setError(caught);
    } finally {
      setPending(false);
    }
  }
  return (
    <Card title="Learner data requests" eyebrow="Export or erase on request">
      {enrollment.status === "erased" ? (
        <Notice tone="gold">This enrollment's learning data was erased. Only an audit skeleton remains.</Notice>
      ) : (
        <>
          <p>
            Export or erase this learner's personal data for this course when they ask. Each action is audited, and
            each export is shown to the learner with your name and role. Your export leaves out the learner's companion
            conversation and their own notes; the learner's own download includes them.
          </p>
          <Button
            disabled={pending}
            onClick={() =>
              void act(async () => {
                const document = await port.exportEnrollment(enrollment.id);
                const url = URL.createObjectURL(new Blob([JSON.stringify(document, null, 2)], { type: "application/json" }));
                const link = Object.assign(window.document.createElement("a"), { href: url, download: `enrollment-${enrollment.id}.json` });
                window.document.body.append(link);
                link.click();
                link.remove();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
                setMessage("Export prepared. Deliver it to the learner through a private channel.");
              })
            }
          >
            <Download size={16} aria-hidden="true" /> Export learner data
          </Button>
          <details>
            <summary>Erase this learner's course data</summary>
            <div className="stack">
              <Notice tone="red">
                Irreversible. Answers, conversations, learner model and personal teaching are redacted; the learner
                cannot continue this enrollment. Usage and extension accounting remain without content.
              </Notice>
              <Field label="Reason (kept with the erasure record)" htmlFor={id + "-reason"}>
                <textarea id={id + "-reason"} rows={2} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
              </Field>
              <Field label={`Type ${phrase} to confirm`} htmlFor={id + "-confirm"}>
                <input id={id + "-confirm"} autoComplete="off" value={confirmation} onChange={(e) => setConfirmation(e.target.value)} />
              </Field>
              <Button
                kind="danger"
                disabled={pending || confirmation.trim() !== phrase || reason.trim().length < 10}
                onClick={() =>
                  void act(async () => {
                    await port.erase(enrollment.id, confirmation.trim(), reason.trim());
                    setMessage("Learning data erased.");
                    onErased();
                  })
                }
              >
                <Eraser size={16} aria-hidden="true" /> Erase permanently
              </Button>
            </div>
          </details>
        </>
      )}
      <div aria-live="polite">
        {message && <Notice tone="green">{message}</Notice>}
        {error !== undefined && <Notice tone="red">{learnerDataErrorMessage(error)}</Notice>}
      </div>
    </Card>
  );
}
