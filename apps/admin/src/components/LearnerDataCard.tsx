import { useId, useState } from "react";
import { Download, Eraser } from "lucide-react";
import {
  isolateLtr,
  isSupportedLocale,
  stripBidiControls,
} from "@course-core/i18n";
import type { AdminClient, Enrollment } from "../domain/contracts";
import { learnerDataErrorMessage } from "../domain/learnerData";
import { englishTranslator, useI18n } from "../i18n";
import { Button, Card, Field, Notice } from "./ui";

/** A typed (or pasted) confirmation as compared: without direction marks, composed, trimmed. */
const typedPhrase = (value: string) =>
  stripBidiControls(value).normalize("NFC").trim();

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
  const i18n = useI18n();
  const t = i18n.t;
  const id = useId();
  // The confirmation phrase in the screen's language, with the id as a left-to-right run. The
  // server accepts the phrase of the language the request names, and the English one. A
  // pseudo-locale shows its own version of the phrase and sends the English one, since
  // pseudo-locales never reach the server.
  const shortId = enrollment.id.slice(0, 8);
  const phrase = t("learnerDataCard.erase.phrase", {
    id: i18n.dir === "rtl" ? isolateLtr(shortId) : shortId,
  });
  const phraseLocale = isSupportedLocale(i18n.locale) ? i18n.locale : "en";
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
    <Card
      title={t("learnerDataCard.title")}
      eyebrow={t("learnerDataCard.eyebrow")}
    >
      {enrollment.status === "erased" ? (
        <Notice tone="gold">{t("learnerDataCard.erased")}</Notice>
      ) : (
        <>
          <p>{t("learnerDataCard.intro")}</p>
          <Button
            disabled={pending}
            onClick={() =>
              void act(async () => {
                const document = await port.exportEnrollment(enrollment.id);
                const url = URL.createObjectURL(
                  new Blob([JSON.stringify(document, null, 2)], {
                    type: "application/json",
                  }),
                );
                const link = Object.assign(window.document.createElement("a"), {
                  href: url,
                  download: `enrollment-${enrollment.id}.json`,
                });
                window.document.body.append(link);
                link.click();
                link.remove();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
                setMessage(t("learnerDataCard.exported"));
              })
            }
          >
            <Download size={16} aria-hidden="true" />{" "}
            {t("learnerDataCard.export")}
          </Button>
          <details>
            <summary>{t("learnerDataCard.erase.summary")}</summary>
            <div className="stack">
              <Notice tone="red">{t("learnerDataCard.erase.warning")}</Notice>
              <Field
                label={t("learnerDataCard.erase.reason")}
                htmlFor={id + "-reason"}
              >
                <textarea
                  id={id + "-reason"}
                  rows={2}
                  maxLength={1000}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </Field>
              <Field
                label={t("learnerDataCard.erase.confirm", { phrase })}
                htmlFor={id + "-confirm"}
              >
                <input
                  id={id + "-confirm"}
                  autoComplete="off"
                  value={confirmation}
                  onChange={(e) => setConfirmation(e.target.value)}
                />
              </Field>
              <Button
                kind="danger"
                disabled={
                  pending ||
                  typedPhrase(confirmation) !== typedPhrase(phrase) ||
                  reason.trim().length < 10
                }
                onClick={() =>
                  void act(async () => {
                    await port.erase(
                      enrollment.id,
                      phraseLocale === i18n.locale
                        ? typedPhrase(confirmation)
                        : englishTranslator().t(
                            "learnerDataCard.erase.phrase",
                            {
                              id: shortId,
                            },
                          ),
                      reason.trim(),
                      phraseLocale,
                    );
                    setMessage(t("learnerDataCard.erased.done"));
                    onErased();
                  })
                }
              >
                <Eraser size={16} aria-hidden="true" />{" "}
                {t("learnerDataCard.erase.submit")}
              </Button>
            </div>
          </details>
        </>
      )}
      <div aria-live="polite">
        {message && <Notice tone="green">{message}</Notice>}
        {error !== undefined && (
          <Notice tone="red">{learnerDataErrorMessage(error, t)}</Notice>
        )}
      </div>
    </Card>
  );
}
