import { useRef, useState } from "react";
import type { AdminClient } from "../domain/contracts";
import type { AccommodationPreview, AccommodationRequest, AccommodationResult, LearningPolicy } from "../domain/policy";
import { Button, Dialog, ErrorState, Field, Notice, when } from "./ui";
import { randomId } from "../domain/webCrypto";

/** An individual accommodation or approved pause for one learner. It is
 * authorized and audited separately; extension pools and other learners are
 * unchanged. The reason is a reference (such as an approval ticket), never
 * health or personal details. */
export function AccommodationEditor({
  client,
  policy,
  scopeId,
  onClose,
  onUpdated,
}: {
  client: AdminClient;
  policy: LearningPolicy;
  scopeId: string;
  onClose: () => void;
  onUpdated: (result: AccommodationResult) => void;
}) {
  const scope = policy.scopes.find((s) => s.scopeId === scopeId)!;
  const deadlineKind: "window" | "absolute" | null = scope.window ? "window" : scope.hardDeadline ? "absolute" : null;
  const [kind, setKind] = useState<AccommodationRequest["kind"]>("accommodation");
  const [days, setDays] = useState(deadlineKind ? "3" : "");
  const [minutes, setMinutes] = useState("");
  const [episodes, setEpisodes] = useState("");
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<AccommodationPreview>();
  const [error, setError] = useState<unknown>();
  const [pending, setPending] = useState(false);
  const busy = useRef(false),
    keys = useRef(new Map<string, string>());
  const reset = () => {
    setPreview(undefined);
    setError(undefined);
  };
  function request(): AccommodationRequest {
    const n = (v: string) => (v.trim() ? Number(v) : undefined);
    const work = kind === "accommodation" ? { ...(n(minutes) ? { additionalMinutes: n(minutes)! } : {}), ...(n(episodes) ? { additionalEpisodes: n(episodes)! } : {}) } : {};
    return {
      scopeId,
      kind,
      change: {
        ...(deadlineKind && n(days) ? { deadline: { kind: deadlineKind, calendarDays: n(days)! } } : {}),
        ...(Object.keys(work).length ? { work } : {}),
      },
    };
  }
  async function run(action: () => Promise<void>) {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError(undefined);
    try {
      await action();
    } catch (cause) {
      setError(cause);
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  const newDeadline = preview?.adjustment.windowDeadline ?? preview?.adjustment.absoluteDeadline;
  return (
    <Dialog title={`Accommodation for ${scope.label}`} onClose={onClose} pending={pending}>
      <Notice tone="gold">
        Applies to this learner only and does not draw on extension pools. Record a reference such as an approval
        ticket, not health or personal details.
      </Notice>
      <fieldset className="segmented">
        <legend>Type</legend>
        {(["accommodation", "approved_pause"] as const).map((value) => (
          <label key={value}>
            <input type="radio" name="accommodation-kind" checked={kind === value} onChange={() => { setKind(value); reset(); }} />
            {value === "accommodation" ? "Accommodation" : "Approved pause (moves the window only)"}
          </label>
        ))}
      </fieldset>
      {deadlineKind && (
        <Field label="Extra calendar days" htmlFor="accommodation-days">
          <input id="accommodation-days" type="number" min={1} max={366} value={days} onChange={(e) => { setDays(e.target.value); reset(); }} />
        </Field>
      )}
      {kind === "accommodation" && (
        <>
          <Field label="Extra planned minutes (optional)" htmlFor="accommodation-minutes">
            <input id="accommodation-minutes" type="number" min={1} value={minutes} onChange={(e) => { setMinutes(e.target.value); reset(); }} />
          </Field>
          <Field label="Extra episodes (optional)" htmlFor="accommodation-episodes">
            <input id="accommodation-episodes" type="number" min={1} value={episodes} onChange={(e) => { setEpisodes(e.target.value); reset(); }} />
          </Field>
        </>
      )}
      {Boolean(error) && <ErrorState error={error} />}
      <Button
        onClick={() => void run(async () => setPreview(await client.previewAccommodation!(policy.enrollmentId, request())))}
        disabled={pending}
      >
        {pending && !preview ? "Computing…" : "Preview the effect"}
      </Button>
      {preview && (
        <div className="stack">
          <h3>Effect for this learner</h3>
          <small className="mono">{preview.previewDigest} · expires {when(preview.expiresAt)}</small>
          <ul>
            {newDeadline && <li>New deadline: {when(newDeadline)}</li>}
            {preview.adjustment.additionalMinutes > 0 && <li>+{preview.adjustment.additionalMinutes} planned minutes</li>}
            {preview.adjustment.additionalEpisodes > 0 && <li>+{preview.adjustment.additionalEpisodes} episodes</li>}
          </ul>
          <Field label="Reason reference" htmlFor="accommodation-reason" hint="For example an approval ticket number.">
            <input id="accommodation-reason" maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <Button
            kind="primary"
            disabled={pending || !reason.trim()}
            onClick={() =>
              void run(async () => {
                const fingerprint = JSON.stringify([preview.previewId, reason.trim()]);
                let key = keys.current.get(fingerprint);
                if (!key) {
                  key = randomId();
                  keys.current.set(fingerprint, key);
                }
                const result = await client.applyAccommodation!(
                  policy.enrollmentId,
                  { previewId: preview.previewId, previewDigest: preview.previewDigest, reason: reason.trim() },
                  { expectedRevision: preview.revision, idempotencyKey: key },
                );
                onUpdated(result);
                onClose();
              })
            }
          >
            Apply for this learner
          </Button>
        </div>
      )}
    </Dialog>
  );
}
