import { useCallback, useEffect, useState } from "react";
import type { EnrollmentPolicy, PolicyClient } from "../client/policyClient";
import { isAbortError } from "../client/apiClient";
export function useEnrollmentPolicy(
  client: PolicyClient,
  id: string | undefined,
  revision: number,
) {
  const [attempt, setAttempt] = useState(0),
    [saved, setSaved] = useState<{
      client: PolicyClient;
      id: string;
      revision: number;
      attempt: number;
      data?: EnrollmentPolicy;
      error?: string;
    }>();
  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    void client
      .load(id, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted)
          setSaved({ client, id, revision, attempt, data });
      })
      .catch((error) => {
        if (!controller.signal.aborted && !isAbortError(error))
          setSaved({
            client,
            id,
            revision,
            attempt,
            error:
              "Study dates and extension offers could not be refreshed. Your saved progress is unchanged.",
          });
      });
    return () => controller.abort();
  }, [client, id, revision, attempt]);
  const matches = saved?.client === client && saved.id === id;
  const loading =
    Boolean(id) &&
    (!matches || saved.revision !== revision || saved.attempt !== attempt);
  return {
    data: matches ? saved.data : undefined,
    error: matches ? saved.error : undefined,
    loading,
    reload,
  };
}
