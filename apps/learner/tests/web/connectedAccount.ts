import type { Page } from "@playwright/test";

/** A fictional signed-in learner with a password and one course, served by route fixtures. */
export const LEARNER = {
  id: "public-learner",
  displayName: "Public learner",
  loginName: "public.learner",
  hasPassword: true,
};

/**
 * Routes the connected learner host (`/`) to fixtures for the account settings: the session,
 * the course library, the learner's notifications, passkeys and the password change.
 */
export async function mockSignedInLearner(page: Page) {
  const state = { passwordChanges: [] as unknown[] };
  await page.route("**/auth/session", (route) =>
    route.fulfill({ json: { user: LEARNER } }),
  );
  await page.route("**/auth/password", async (route) => {
    state.passwordChanges.push(route.request().postDataJSON());
    await route.fulfill({ json: { changed: true } });
  });
  await page.route("**/auth/passkeys", (route) =>
    route.fulfill({
      json: {
        available: true,
        passkeys: [
          {
            id: "pk-1",
            name: "Passkey on phone",
            createdAt: "2026-10-01T09:30:00.000Z",
            lastUsedAt: "2026-10-20T15:10:00.000Z",
            backedUp: true,
          },
        ],
      },
    }),
  );
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/enrollments")
      return route.fulfill({
        json: [
          {
            id: "enrollment-1",
            title: "Sorting, step by step",
            version: "1.0.0",
            status: "active",
            releaseId: "release-1",
          },
        ],
      });
    if (path === "/api/workspaces") return route.fulfill({ json: [] });
    if (path === "/api/me/locale")
      return route.fulfill({
        json: { preference: null, locale: "en", source: "request" },
      });
    if (path === "/api/me/notifications")
      return route.fulfill({
        json: { items: [], unread: 0, nextCursor: null },
      });
    return route.fulfill({ status: 404, json: { error: "NOT_FOUND" } });
  });
  return state;
}
