import type { SupportedLocale } from "@course-core/i18n";

/** The learner API client's request function (client/apiClient.ts): cookie session and CSRF header. */
type Request = <T>(url: string, method?: string, payload?: unknown) => Promise<T>;

/** GET/PUT /api/me/locale (services/api/src/locale.ts). */
export interface ServerLocale {
  preference: SupportedLocale | null;
  locale: SupportedLocale;
  source: "user" | "request" | "workspace" | "default";
}
export const fetchServerLocale = (request: Request) =>
  request<ServerLocale>("/api/me/locale", "GET");
export const saveServerLocale = (request: Request, locale: SupportedLocale | null) =>
  request<ServerLocale>("/api/me/locale", "PUT", { locale });
