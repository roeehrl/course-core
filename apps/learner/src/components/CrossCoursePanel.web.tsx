import React, { useCallback, useEffect, useRef, useState } from "react";
import type { CourseApi } from "../client/apiClient";
import type { CrossCoursePanelProps } from "./CrossCoursePanel";

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
const quote = (o: Objective | null | undefined) => `“${o?.description ?? ""}”`;
function describe(s: Suggestion): { title: string; body: string } {
  const other = s.otherObjectives;
  if (s.kind === "shown_elsewhere")
    return {
      title: `You already showed ${quote(other[0])} in ${s.otherCourseTitle}`,
      body: `It matches ${quote(s.objective)} here. Confirming tells this course, which may offer you a shorter check. It does not count as passing here: this course still decides from its own checks.`,
    };
  if (s.kind === "prerequisite_reminder")
    return {
      title: `${quote(other[0])} in ${s.otherCourseTitle} comes before ${quote(s.objective)}`,
      body: `You have not shown it in ${s.otherCourseTitle} yet. You might review it there first.`,
    };
  return {
    title: "Pacing across your courses",
    body: `This lesson builds on ${other.length === 1 ? "an objective" : `${other.length} objectives`} in ${s.otherCourseTitle} you have not shown yet: ${other.map(quote).join(", ")}. Consider spending your next session there.`,
  };
}

/** The learner's own choice, per pair of their courses, whether what they showed in one may be used
 * for suggestions in the other; and those suggestions. Off by default. Nothing here grants credit. */
export function CrossCoursePanel({ api, enrollmentId, courseTitle }: CrossCoursePanelProps) {
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
      setError("Your choice could not be saved. Nothing changed.");
    } finally {
      setDesired({});
      setBusy(false);
    }
  }
  const pending = view.suggestions.filter((s) => s.state === "pending");
  return (
    <section className="connected-reading-card cross-course" aria-labelledby="cross-course-title">
      <h2 id="cross-course-title">Sharing between your courses</h2>
      <p className="connected-muted">
        Your course teams linked some objectives of {courseTitle} with your other courses. If you turn sharing on for a pair, what you
        have shown in one may be used for suggestions in the other — only whether you met an objective, never your answers, questions,
        notes or goal. Course staff do not see these choices or suggestions. Turning sharing off removes everything shared through that pair.
      </p>
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
                    e.target.checked ? `Sharing with ${pair.otherCourse.title} is on.` : `Sharing with ${pair.otherCourse.title} is off. What was shared was removed.`);
                }}
              />
              <span>Share with {pair.otherCourse.title}</span>
            </label>
            {!pair.canGrant && !pair.consent.granted && <p className="connected-muted">Not available: one of the courses is closed or no longer linked.</p>}
          </li>
        ))}
      </ul>
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
      {view.suggestions.length > 0 && (
        <>
          <h3>Suggestions from your other courses</h3>
          {pending.length === 0 && <p className="connected-muted">No open suggestions.</p>}
          <ul className="cross-course-suggestions">
            {view.suggestions.map((s) => {
              const text = describe(s);
              return (
                <li key={s.id}>
                  <article className="cross-course-card" aria-labelledby={`cross-course-${s.id}`}>
                    <h4 id={`cross-course-${s.id}`}>{text.title}</h4>
                    <p>{text.body}</p>
                    {s.state === "pending" ? (
                      <div className="cross-course-actions">
                        <button type="button" disabled={busy}
                          onClick={() => act(`confirm:${s.id}`, `/suggestions/${encodeURIComponent(s.id)}/decision`, { action: "confirm" }, "Thanks. This course was told.")}>
                          Confirm<span className="cross-course-hidden">: {text.title}</span>
                        </button>
                        <button type="button" className="quiet" disabled={busy}
                          onClick={() => act(`dismiss:${s.id}`, `/suggestions/${encodeURIComponent(s.id)}/decision`, { action: "dismiss" }, "Suggestion dismissed.")}>
                          Dismiss<span className="cross-course-hidden">: {text.title}</span>
                        </button>
                      </div>
                    ) : (
                      <p className="connected-muted">{s.state === "confirmed" ? "Confirmed" : "Dismissed"}</p>
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
