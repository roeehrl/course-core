import { useCallback, useEffect, useRef, useState } from "react";
import { emptySession, restoreSession, safeRoute } from "../domain/session";
import type {
  Course,
  KeyValueStorage,
  LearnerClient,
  LearnerSnapshot,
  LocalSession,
  MutationResult,
  RequestContext,
  Route,
} from "../domain/types";
import { useT, type MessageKey } from "../i18n";

export function useLearner(
  course: Course,
  client: LearnerClient,
  storage: KeyValueStorage,
  learnerKey: string,
) {
  const t = useT();
  // i18n-ignore: storage key
  const key = `course-core:session:${learnerKey}:${course.id}:${course.version}`;
  const [snapshot, setSnapshot] = useState<LearnerSnapshot>();
  const [session, setSession] = useState<LocalSession>(emptySession);
  // A message key, translated when returned so a shown error follows the UI locale.
  const [error, setError] = useState<MessageKey>();
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<MutationResult["feedback"]>();
  const [attempt, setAttempt] = useState(0);
  const ready = useRef(false);
  const busy = useRef(false);
  const retries = useRef(new Map<string, string>());
  const writes = useRef(Promise.resolve());
  useEffect(() => {
    let active = true;
    ready.current = false;
    setSnapshot(undefined);
    setError(undefined);
    Promise.all([client.load(), storage.getItem(key)])
      .then(([next, raw]) => {
        if (!active) return;
        setSession(restoreSession(raw, course, next));
        setSnapshot(next);
        ready.current = true;
      })
      .catch(() => {
        if (active)
          setError("useLearner.error.load");
      });
    return () => {
      active = false;
    };
  }, [client, course, storage, key, attempt]);
  useEffect(() => {
    if (!ready.current) return;
    // Serialize writes: a slow old write must never overwrite a newer draft.
    writes.current = writes.current
      .catch(() => {})
      .then(() => storage.setItem(key, JSON.stringify(session)))
      .catch(() =>
        setError("useLearner.error.localSave"),
      );
  }, [session, key, storage]);
  const navigate = useCallback(
    (route: Route) => {
      if (!snapshot || busy.current) return;
      setFeedback(undefined);
      setError(undefined);
      setSession((previous) => ({
        ...previous,
        route: safeRoute(course, snapshot, route),
      }));
    },
    [snapshot, course],
  );
  async function run(
    fingerprint: string,
    command: (context: RequestContext) => Promise<MutationResult>,
  ) {
    if (!snapshot || busy.current) return;
    busy.current = true;
    setPending(true);
    setError(undefined);
    setFeedback(undefined);
    let idempotencyKey = retries.current.get(fingerprint);
    if (!idempotencyKey) {
      idempotencyKey = `request-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      retries.current.set(fingerprint, idempotencyKey);
    }
    try {
      const result = await command({
        courseId: course.id,
        courseVersion: course.version,
        expectedRevision: snapshot.revision,
        idempotencyKey,
      });
      setSnapshot(result.snapshot);
      setFeedback(result.feedback);
      retries.current.delete(fingerprint);
      return result;
    } catch {
      setError("useLearner.error.update");
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  return {
    snapshot,
    session,
    setSession,
    error: error && t(error),
    pending,
    feedback,
    navigate,
    run,
    clearFeedback: () => {
      setFeedback(undefined);
      setError(undefined);
    },
    reload: () => {
      retries.current.clear();
      setAttempt((value) => value + 1);
    },
  };
}
