import React, { useEffect, useId, useState } from "react";
import type { ServerSnapshot } from "../client/apiClient";
import { useI18n } from "../i18n";

// i18n-ignore: local storage key, not shown to people
const seenKey = (enrollmentId: string, noticeId: string) => `course-version-notice:${enrollmentId}:${noticeId}`;
function seen(key: string) {
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

/** "Your course was updated": staff moved the learner to a newer version of the course (K13).
 * Says what that means for them in plain words, until they dismiss it on this device. */
export function CourseVersionNotice({ server }: { server: ServerSnapshot }) {
  const id = useId();
  const i18n = useI18n(),
    t = i18n.t;
  const notice = server.courseVersionNotice;
  const key = notice ? seenKey(server.enrollmentId, notice.id) : "";
  const [hidden, setHidden] = useState(() => (key ? seen(key) : false));
  useEffect(() => setHidden(key ? seen(key) : false), [key]);
  if (!notice || hidden) return null;
  return (
    <section className="connected-reading-card connected-version-notice" role="status" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>{t("courseVersionNotice.title")}</h2>
      <p>
        {t("courseVersionNotice.moved", {
          from: notice.fromVersion,
          to: notice.toVersion,
          date: i18n.dateTime(notice.movedAt),
        })}
      </p>
      <ul>
        <li>{t("courseVersionNotice.kept")}</li>
        {(notice.carriedCheckpoints ?? 0) > 0 && (
          <li>{t("courseVersionNotice.carried", { count: notice.carriedCheckpoints ?? 0 })}</li>
        )}
        <li>{t("courseVersionNotice.checkpoints")}</li>
        <li>{t("courseVersionNotice.deadlines")}</li>
        {notice.personalChanges && <li>{t(`courseVersionNotice.personal.${notice.personalChanges}`)}</li>}
      </ul>
      <button
        type="button"
        className="connected-secondary"
        onClick={() => {
          try {
            window.localStorage.setItem(key, "1");
          } catch {
            // Not remembered: the notice shows again next time.
          }
          setHidden(true);
        }}
      >
        {t("courseVersionNotice.dismiss")}
      </button>
    </section>
  );
}
