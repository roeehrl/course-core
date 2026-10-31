import React, { useCallback, useEffect, useRef, useState } from "react";
import type { CourseApi } from "../client/apiClient";
import type { CrossCoursePanelProps } from "./CrossCoursePanel";
import { englishTranslator, useI18n, type LearnerTranslator } from "../i18n";

interface Objective { id: string; description: string }
interface Pair {
  otherEnrollmentId: string;
  otherCourse: { title: string; version: string; status: string };
  mapping: { links: number } | null;
  consent: { granted: boolean; revision: number; changedAt: string | null };
  canGrant: boolean;
}
interface Suggestion {
  id: string;
  kind: "prerequisite_reminder" | "shown_elsewhere" | "pacing";
  state: "pending" | "confirmed" | "dismissed";
  objective: Objective | null;
  otherCourseTitle: string;
  otherObjectives: Objective[];
}
export interface CrossCourseView { pairs: Pair[]; suggestions: Suggestion[] }

const key = () => `cross-course-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
const text = (o: Objective | null | undefined) => o?.description ?? "";
/** The title and body of a suggestion, in the active locale. */
export function describe(s: Suggestion, i18n: LearnerTranslator = englishTranslator()): { title: string; body: string } {
  const { t } = i18n;
  const other = s.otherObjectives,
    course = s.otherCourseTitle;
  if (s.kind === "shown_elsewhere")
    return {
      title: t("crossCoursePanel.shownElsewhere.title", { other: text(other[0]), course }),
      body: t("crossCoursePanel.shownElsewhere.body", { objective: text(s.objective) }),
    };
  if (s.kind === "prerequisite_reminder")
    return {
      title: t("crossCoursePanel.prerequisite.title", { other: text(other[0]), course, objective: text(s.objective) }),
      body: t("crossCoursePanel.prerequisite.body", { course }),
    };
  return {
    title: t("crossCoursePanel.pacing.title"),
    body: t("crossCoursePanel.pacing.body", {
      count: other.length,
      course,
      objectives: i18n.list(other.map((o) => t("crossCoursePanel.quoted", { text: text(o) })), "unit"),
    }),
  };
}

/** The learner's own choice, per pair of their courses, whether what they showed in one may be used
 * for suggestions in the other; and those suggestions. Off by default. Nothing here grants credit. */
export function CrossCoursePanel({ api, enrollmentId, courseTitle }: CrossCoursePanelProps) {
  const i18n = useI18n(), t = i18n.t;
  const [view, setView] = useState<CrossCourseView>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  // The choice being saved, shown at once and dropped once the server answers.
  const [desired, setDesired] = useState<Record<string, boolean>>({});
  const keys = useRef(new Map<string, string>());
  const base = `/api/enrollments/${encodeURIComponent(enrollmentId)}/cross-course`;
  const load = useCallback(
    (signal?: AbortSignal) =>
      (api as CourseApi).request<CrossCourseView>(base, "GET", undefined, signal ? { signal } : {}).then((v) => {
        if (!signal?.aborted) setView(v);
      }),
    [api, base],
  );
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal).catch(() => undefined);
    return () => controller.abort();
  }, [load]);
  if (!view || (!view.pairs.length && !view.suggestions.length)) return null;
  async function act(intent: string, path: string, body: Record<string, unknown>, done: string) {
    let k = keys.current.get(intent);
    if (!k) keys.current.set(intent, (k = key()));
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await (api as CourseApi).request(`${base}${path}`, "POST", { ...body, idempotencyKey: k });
      keys.current.delete(intent);
      setNotice(done);
      await load();
    } catch {
      setError(t("crossCoursePanel.error.save"));
    } finally {
      setDesired({});
      setBusy(false);
    }
  }
  const pending = view.suggestions.filter((s) => s.state === "pending");
  return (
    <section className="connected-reading-card cross-course" aria-labelledby="cross-course-title">
      <h2 id="cross-course-title">{t("crossCoursePanel.title")}</h2>
      <p className="connected-muted">{t("crossCoursePanel.intro", { course: courseTitle })}</p>
      <ul className="cross-course-pairs">
        {view.pairs.map((pair) => (
          <li key={pair.otherEnrollmentId}>
            <label className="cross-course-toggle">
              <input
                type="checkbox"
                checked={desired[pair.otherEnrollmentId] ?? pair.consent.granted}
                disabled={busy || (!pair.consent.granted && !pair.canGrant)}
                onChange={(e) => {
                  setDesired({ [pair.otherEnrollmentId]: e.target.checked });
                  void act(`consent:${pair.otherEnrollmentId}:${e.target.checked}`, "/consent", { otherEnrollmentId: pair.otherEnrollmentId, granted: e.target.checked },
                    t(e.target.checked ? "crossCoursePanel.notice.on" : "crossCoursePanel.notice.off", { course: pair.otherCourse.title }));
                }}
              />
              <span>{t("crossCoursePanel.share", { course: pair.otherCourse.title })}</span>
            </label>
            {!pair.canGrant && !pair.consent.granted && <p className="connected-muted">{t("crossCoursePanel.unavailable")}</p>}
          </li>
        ))}
      </ul>
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
      {view.suggestions.length > 0 && (
        <>
          <h3>{t("crossCoursePanel.suggestions")}</h3>
          {pending.length === 0 && <p className="connected-muted">{t("crossCoursePanel.noSuggestions")}</p>}
          <ul className="cross-course-suggestions">
            {view.suggestions.map((s) => {
              const text = describe(s, i18n);
              return (
                <li key={s.id}>
                  <article className="cross-course-card" aria-labelledby={`cross-course-${s.id}`}>
                    <h4 id={`cross-course-${s.id}`}>{text.title}</h4>
                    <p>{text.body}</p>
                    {s.state === "pending" ? (
                      <div className="cross-course-actions">
                        <button type="button" className="quiet" disabled={busy}
                          onClick={() => act(`dismiss:${s.id}`, `/suggestions/${encodeURIComponent(s.id)}/decision`, { action: "dismiss" }, t("crossCoursePanel.notice.dismissed"))}>
                          {i18n.rich("crossCoursePanel.dismiss", { title: text.title }, { hidden: (children, k) => <span key={k} className="cross-course-hidden">{children}</span> })}
                        </button>
                        <button type="button" disabled={busy}
                          onClick={() => act(`confirm:${s.id}`, `/suggestions/${encodeURIComponent(s.id)}/decision`, { action: "confirm" }, t("crossCoursePanel.notice.confirmed"))}>
                          {i18n.rich("crossCoursePanel.confirm", { title: text.title }, { hidden: (children, k) => <span key={k} className="cross-course-hidden">{children}</span> })}
                        </button>
                      </div>
                    ) : (
                      <p className="connected-muted">{t(s.state === "confirmed" ? "crossCoursePanel.state.confirmed" : "crossCoursePanel.state.dismissed")}</p>
                    )}
                  </article>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
