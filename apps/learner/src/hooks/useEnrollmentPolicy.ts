import { startTransition, useCallback, useEffect, useState } from "react";
import type { EnrollmentPolicy, PolicyClient } from "../client/policyClient";
import { isAbortError } from "../client/apiClient";
import { useT } from "../i18n";
export function useEnrollmentPolicy(
  client: PolicyClient,
  id: string | undefined,
  revision: number,
) {
  const t = useT();
  const [attempt, setAttempt] = useState(0),
    [saved, setSaved] = useState<{
      client: PolicyClient;
      id: string;
      revision: number;
      attempt: number;
      data?: EnrollmentPolicy;
      /** The last read failed; translated when returned, so it follows the UI locale. */
      failed?: boolean;
    }>();
  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  useEffect(() => {
    if (!id) return;
    // A background reload after a revision: applied as a transition, so it never holds back the
    // paint of what the learner just did (an answer's result, a started check).
    const controller = new AbortController();
    void client
      .load(id, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted)
          startTransition(() => setSaved({ client, id, revision, attempt, data }));
      })
      .catch((error) => {
        if (!controller.signal.aborted && !isAbortError(error))
          startTransition(() =>
            setSaved({
              client,
              id,
              revision,
              attempt,
              failed: true,
            }),
          );
      });
    return () => controller.abort();
  }, [client, id, revision, attempt]);
  const matches = saved?.client === client && saved.id === id;
  const loading =
    Boolean(id) &&
    (!matches || saved.revision !== revision || saved.attempt !== attempt);
  return {
    data: matches ? saved.data : undefined,
    error: matches && saved.failed ? t("useEnrollmentPolicy.refreshFailed") : undefined,
    loading,
    reload,
  };
}
