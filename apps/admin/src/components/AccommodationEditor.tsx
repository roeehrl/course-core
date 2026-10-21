import { useRef, useState } from "react";
import type { AdminClient } from "../domain/contracts";
import type {
  AccommodationPreview,
  AccommodationRequest,
  AccommodationResult,
  LearningPolicy,
} from "../domain/policy";
import { Button, Dialog, ErrorState, Field, Notice } from "./ui";
import { randomId } from "../domain/webCrypto";
import { useI18n } from "../i18n";

/** Server times in UTC with the zone name, formatted for the active locale. */
const utc: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "UTC",
  timeZoneName: "short",
};

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
  const i18n = useI18n();
  const t = i18n.t;
  const when = (iso: string) => i18n.dateTime(iso, utc);
  const scope = policy.scopes.find((s) => s.scopeId === scopeId)!;
  const deadlineKind: "window" | "absolute" | null = scope.window
    ? "window"
    : scope.hardDeadline
      ? "absolute"
      : null;
  const [kind, setKind] =
    useState<AccommodationRequest["kind"]>("accommodation");
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
    const work =
      kind === "accommodation"
        ? {
            ...(n(minutes) ? { additionalMinutes: n(minutes)! } : {}),
            ...(n(episodes) ? { additionalEpisodes: n(episodes)! } : {}),
          }
        : {};
    return {
      scopeId,
      kind,
      change: {
        ...(deadlineKind && n(days)
          ? { deadline: { kind: deadlineKind, calendarDays: n(days)! } }
          : {}),
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
  const newDeadline =
    preview?.adjustment.windowDeadline ?? preview?.adjustment.absoluteDeadline;
  return (
    <Dialog
      title={t("accommodationEditor.title", { scope: scope.label })}
      onClose={onClose}
      pending={pending}
    >
      <Notice tone="gold">{t("accommodationEditor.notice")}</Notice>
      <fieldset className="segmented">
        <legend>{t("accommodationEditor.type")}</legend>
        {(["accommodation", "approved_pause"] as const).map((value) => (
          <label key={value}>
            <input
              type="radio"
              name="accommodation-kind"
              checked={kind === value}
              onChange={() => {
                setKind(value);
                reset();
              }}
            />
            {value === "accommodation"
              ? t("accommodationEditor.kind.accommodation")
              : t("accommodationEditor.kind.approvedPause")}
          </label>
        ))}
      </fieldset>
      {deadlineKind && (
        <Field
          label={t("accommodationEditor.days")}
          htmlFor="accommodation-days"
        >
          <input
            id="accommodation-days"
            type="number"
            min={1}
            max={366}
            value={days}
            onChange={(e) => {
              setDays(e.target.value);
              reset();
            }}
          />
        </Field>
      )}
      {kind === "accommodation" && (
        <>
          <Field
            label={t("accommodationEditor.minutes")}
            htmlFor="accommodation-minutes"
          >
            <input
              id="accommodation-minutes"
              type="number"
              min={1}
              value={minutes}
              onChange={(e) => {
                setMinutes(e.target.value);
                reset();
              }}
            />
          </Field>
          <Field
            label={t("accommodationEditor.episodes")}
            htmlFor="accommodation-episodes"
          >
            <input
              id="accommodation-episodes"
              type="number"
              min={1}
              value={episodes}
              onChange={(e) => {
                setEpisodes(e.target.value);
                reset();
              }}
            />
          </Field>
        </>
      )}
      {Boolean(error) && <ErrorState error={error} />}
      <Button
        onClick={() =>
          void run(async () =>
            setPreview(
              await client.previewAccommodation!(
                policy.enrollmentId,
                request(),
              ),
            ),
          )
        }
        disabled={pending}
      >
        {pending && !preview
          ? t("accommodationEditor.computing")
          : t("accommodationEditor.preview")}
      </Button>
      {preview && (
        <div className="stack">
          <h3>{t("accommodationEditor.effect")}</h3>
          <small>
            {i18n.rich(
              "accommodationEditor.expires",
              {
                digest: preview.previewDigest,
                date: when(preview.expiresAt),
              },
              {
                id: (children, key) => (
                  <span key={key} className="mono" dir="ltr">
                    {children}
                  </span>
                ),
              },
            )}
          </small>
          <ul>
            {newDeadline && (
              <li>
                {t("accommodationEditor.newDeadline", {
                  date: when(newDeadline),
                })}
              </li>
            )}
            {preview.adjustment.additionalMinutes > 0 && (
              <li>
                {t("accommodationEditor.addedMinutes", {
                  count: preview.adjustment.additionalMinutes,
                })}
              </li>
            )}
            {preview.adjustment.additionalEpisodes > 0 && (
              <li>
                {t("accommodationEditor.addedEpisodes", {
                  count: preview.adjustment.additionalEpisodes,
                })}
              </li>
            )}
          </ul>
          <Field
            label={t("accommodationEditor.reason")}
            htmlFor="accommodation-reason"
            hint={t("accommodationEditor.reason.hint")}
          >
            <input
              id="accommodation-reason"
              dir="auto"
              maxLength={300}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
          <Button
            kind="primary"
            disabled={pending || !reason.trim()}
            onClick={() =>
              void run(async () => {
                const fingerprint = JSON.stringify([
                  preview.previewId,
                  reason.trim(),
                ]);
                let key = keys.current.get(fingerprint);
                if (!key) {
                  key = randomId();
                  keys.current.set(fingerprint, key);
                }
                const result = await client.applyAccommodation!(
                  policy.enrollmentId,
                  {
                    previewId: preview.previewId,
                    previewDigest: preview.previewDigest,
                    reason: reason.trim(),
                  },
                  { expectedRevision: preview.revision, idempotencyKey: key },
                );
                onUpdated(result);
                onClose();
              })
            }
          >
            {t("accommodationEditor.apply")}
          </Button>
        </div>
      )}
    </Dialog>
  );
}
