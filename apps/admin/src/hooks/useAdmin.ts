import { useEffect, useRef, useState } from "react";
import type {
  AdminClient,
  CourseWorkspace,
  MutationContext,
  MutationResult,
} from "../domain/contracts";
import { randomId } from "../domain/webCrypto";

export function useRemote<T>(
  load: (signal: AbortSignal) => Promise<T>,
  dependencies: unknown[],
) {
  const [state, setState] = useState<{
    data?: T;
    error?: unknown;
    loading: boolean;
  }>({ loading: true });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setState({ loading: true });
    load(controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setState({ data, loading: false });
      })
      .catch((error) => {
        if (!controller.signal.aborted) setState({ error, loading: false });
      });
    return () => controller.abort();
  }, [...dependencies, attempt]);
  return { ...state, reload: () => setAttempt((value) => value + 1) };
}
export function useWorkspace(client: AdminClient, courseId: string) {
  const remote = useRemote(
    (signal) => client.getCourse(courseId, signal),
    [client, courseId],
  );
  const [workspace, setWorkspace] = useState<CourseWorkspace>();
  const [error, setError] = useState<unknown>();
  const [receipt, setReceipt] = useState<MutationResult>();
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const active = useRef(true);
  const readGeneration = useRef(0);
  const retries = useRef(new Map<string, string>());
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    setWorkspace(remote.data);
  }, [remote.data]);
  async function run(
    fingerprint: string,
    command: (context: MutationContext) => Promise<MutationResult>,
  ) {
    if (!workspace || busy.current) return;
    busy.current = true;
    readGeneration.current++;
    setPending(true);
    setError(undefined);
    setReceipt(undefined);
    let key = retries.current.get(fingerprint);
    if (!key) {
      key = randomId();
      retries.current.set(fingerprint, key);
    }
    try {
      const result = await command({
        expectedRevision: workspace.revision,
        idempotencyKey: key,
      });
      if (active.current) {
        setWorkspace(result.workspace);
        setReceipt(result);
        retries.current.delete(fingerprint);
      }
      return result;
    } catch (cause) {
      if (active.current) setError(cause);
    } finally {
      busy.current = false;
      if (active.current) setPending(false);
    }
  }
  return {
    workspace,
    loading: remote.loading,
    loadError: remote.error,
    error,
    pending,
    receipt,
    run,
    resync: async () => {
      const token = ++readGeneration.current;
      try {
        const latest = await client.getCourse(courseId);
        if (active.current && token === readGeneration.current)
          setWorkspace(latest);
      } catch (cause) {
        if (active.current && token === readGeneration.current) setError(cause);
      }
    },
    clear: () => {
      setError(undefined);
      setReceipt(undefined);
    },
    refresh: () => {
      if (busy.current) return;
      setError(undefined);
      setReceipt(undefined);
      retries.current.clear();
      remote.reload();
    },
  };
}
export type WorkspaceActions = ReturnType<typeof useWorkspace>;
