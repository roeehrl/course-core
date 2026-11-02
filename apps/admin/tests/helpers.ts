import { createDemoAdminClient } from "../src/client/demoClient";
import type { AdminClient, MutationContext } from "../src/domain/contracts";
let sequence = 0;
export const demo = (
  options: Parameters<typeof createDemoAdminClient>[0] = {},
) => createDemoAdminClient({ latency: 0, ...options });
export const context = (expectedRevision = "1"): MutationContext => ({
  expectedRevision,
  idempotencyKey: `test-${++sequence}`,
});
export const enrollmentId = "sorting-learner-01";
export const request = { scopeId: "chapter:foundations", days: 2 };
export const proposal = {
  ...request,
  rationaleEventIds: ["ev-02"],
  episodeIds: ["notice"],
  planImpact:
    "Two more calendar days to complete existing work; no additional work.",
  alternatives: ["Continue with the current deadline."],
};
export const enrollmentContext = (expectedRevision = 1) => ({
  expectedRevision,
  idempotencyKey: `calendar-${++sequence}`,
});
export async function currentContext(client: AdminClient) {
  return context((await client.getCourse("sorting")).revision);
}
/** Opens the app at an address, as a deep link would (before rendering it). */
export function openAddress(path: string) {
  window.history.replaceState(null, "", path);
}
/** Opens the app on a course page (Course & releases of the first demo course by default). */
export const atCourse = (page = "releases", course = "sorting") =>
  openAddress(`/admin/courses/${course}/${page}`);
