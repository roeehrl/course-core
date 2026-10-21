import type { SupportedLocale } from "@course-core/i18n";

/** GET/PUT /api/me/locale (services/api/src/locale.ts). */
export interface ServerLocale {
  preference: SupportedLocale | null;
  locale: SupportedLocale;
  source: "user" | "request" | "workspace" | "default";
  workspaceDefault: SupportedLocale | null;
  supported: SupportedLocale[];
}

async function send(
  method: "GET" | "PUT",
  url: string,
  headers: HeadersInit,
  body?: unknown,
): Promise<unknown> {
  const response = await fetch(url, {
    method,
    credentials: "include",
    cache: "no-store",
    headers:
      body === undefined
        ? headers
        : { "Content-Type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = (await response.json().catch(() => null)) as {
    error?: unknown;
  } | null;
  if (!response.ok)
    throw new Error(
      typeof data?.error === "string" ? data.error : "UNAVAILABLE",
    );
  return data;
}

export const fetchServerLocale = (headers: HeadersInit = {}) =>
  send("GET", "/api/me/locale", headers) as Promise<ServerLocale>;
export const saveServerLocale = (
  locale: SupportedLocale | null,
  headers: HeadersInit,
) =>
  send("PUT", "/api/me/locale", headers, { locale }) as Promise<ServerLocale>;

export interface WorkspaceLocale {
  defaultLocale: SupportedLocale | null;
  supported: SupportedLocale[];
}
export const fetchWorkspaceLocale = (workspaceId: string) =>
  send(
    "GET",
    `/api/workspaces/${encodeURIComponent(workspaceId)}/locale`,
    {},
  ) as Promise<WorkspaceLocale>;
export const saveWorkspaceLocale = (
  workspaceId: string,
  defaultLocale: SupportedLocale | null,
  headers: HeadersInit,
) =>
  send(
    "PUT",
    `/api/workspaces/${encodeURIComponent(workspaceId)}/locale`,
    headers,
    { defaultLocale },
  ) as Promise<WorkspaceLocale>;
