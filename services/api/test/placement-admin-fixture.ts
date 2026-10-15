import type { FastifyInstance } from "fastify";

/** Placement is off until staff enable it. Tests that exercise placement turn it on for every
 * course of a workspace through the real admin settings route (as an owner or admin would). */
export async function enablePlacement(
  app: Pick<FastifyInstance, "inject">,
  staff: { cookie: string; csrf: string },
  origin: string,
  workspaceId: string,
  settings: Partial<{ retestCooldownHours: number; maxRuns: number; maxItems: number | null; minFamiliesPerEpisode: number | null }> = {},
) {
  const headers = { origin, cookie: staff.cookie, "x-csrf-token": staff.csrf };
  const session = await app.inject({ method: "GET", url: "/api/admin/session", headers });
  const courses = (session.json().courses as { id: string; workspaceId: string }[]).filter((c) => c.workspaceId === workspaceId);
  if (!courses.length) throw new Error("No course to enable placement for");
  for (const course of courses) {
    const current = await app.inject({ method: "GET", url: `/api/admin/courses/${course.id}/placement`, headers });
    if (current.statusCode !== 200) throw new Error(`Placement settings unreadable: ${current.body}`);
    const saved = await app.inject({ method: "POST", url: `/api/admin/courses/${course.id}/placement/settings`, headers, payload: {
      expectedRevision: current.json().settings.revision, enabled: true, retestCooldownHours: 0, maxRuns: 1, maxItems: null, minFamiliesPerEpisode: null, ...settings } });
    if (saved.statusCode !== 200) throw new Error(`Placement settings not saved: ${saved.body}`);
  }
  return courses.map((c) => c.id);
}
