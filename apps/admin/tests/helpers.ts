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
