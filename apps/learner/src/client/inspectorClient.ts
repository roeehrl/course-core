import type { CourseApi } from "./apiClient";

/**
 * Whether the signed-in account may open the debug inspector beside this enrollment's activity
 * (U01). The server answers from the account's role on the enrollment: owners and admins get it
 * (for example a workspace owner who is also enrolled); a learner never does. This only decides
 * whether the entry is shown; every read the inspector makes is authorized and audited again by
 * the server.
 */
export type InspectorAccess = { available: true; path: string } | { available: false };

/** Only a same-origin path to the inspector page is ever framed. */
const SAFE_PATH = /^\/admin\/inspector$/;

export function parseInspectorAccess(value: unknown): InspectorAccess {
  if (!value || typeof value !== "object") return { available: false };
  const row = value as { available?: unknown; path?: unknown };
  return row.available === true && typeof row.path === "string" && SAFE_PATH.test(row.path) ? { available: true, path: row.path } : { available: false };
}

export function createInspectorClient(api: CourseApi) {
  return {
    async access(enrollmentId: string, signal?: AbortSignal): Promise<InspectorAccess> {
      return parseInspectorAccess(await api.request(`/api/enrollments/${encodeURIComponent(enrollmentId)}/debug-inspector`, "GET", undefined, { signal }));
    },
  };
}
export type InspectorClient = ReturnType<typeof createInspectorClient>;

/** The inspector page for one place in the lesson. */
export function inspectorUrl(path: string, place: { enrollmentId: string; episodeId: string; blockId?: string | undefined }) {
  const query = new URLSearchParams({ enrollment: place.enrollmentId, episode: place.episodeId, ...(place.blockId ? { block: place.blockId } : {}) });
  return `${path}?${query}`;
}
