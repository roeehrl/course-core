import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { authService } from "./auth.js";
import { transaction, type Database } from "./database.js";
import { requireCondition } from "./errors.js";
import { appendEvent } from "./events.js";
import { findAssessment } from "./gates.js";
import { enrollmentCommand, enrollmentFor } from "./admin-routes.js";
import { checkAttempts, courseChecks, enrollmentAssessmentPolicy, type Check } from "./assessment-policy.js";
import type { EnrollmentContext } from "./repository.js";
import type { PoolClient } from "pg";

type Auth = ReturnType<typeof authService>;
const key = z.string().regex(/^[A-Za-z0-9:_-]{8,200}$/);
const checkId = z.string().regex(/^(gate|item):[A-Za-z0-9._:-]{1,200}$/);
const grantInput = z.strictObject({
  expectedRevision: z.number().int().positive(),
  idempotencyKey: key,
  checkId,
  reason: z.string().trim().min(1).max(1000),
});
function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value);
  requireCondition(parsed.success, "INVALID_REQUEST");
  return parsed.data;
}
const enrollmentId = (request: FastifyRequest) => (request.params as { enrollmentId: string }).enrollmentId;

/** Every check of the enrollment's course and any single item the learner already answered
 * outside a gate, with graded-attempt use under the policy in force for this enrollment. */
async function attemptsView(client: PoolClient, context: EnrollmentContext) {
  const course = context.release.server_bundle, policy = await enrollmentAssessmentPolicy(client, context.enrollment);
  const checks: Check[] = courseChecks(course);
  const gated = new Set(checks.flatMap((c) => c.itemIds));
  const loose = (await client.query<{ assessment_id: string }>(
    "SELECT DISTINCT assessment_id FROM attempts WHERE enrollment_id=$1 AND mode='independent' ORDER BY assessment_id", [context.enrollment.id])).rows
    .map((r) => r.assessment_id).filter((id) => !gated.has(id) && findAssessment(course, id));
  for (const id of loose) checks.push({ checkId: `item:${id}`, title: id, itemIds: [id] });
  return { enrollmentId: context.enrollment.id, revision: context.enrollment.revision, policy,
    checks: await Promise.all(checks.map((check) => checkAttempts(client, context.enrollment.id, check, policy))) };
}

/** Staff view of graded-attempt use per check, and the audited "allow one more attempt" action.
 * A grant raises this learner's limit at one check by one and ends any retry wait there; it never
 * changes recorded attempts or evidence. */
export function registerAssessmentPolicyRoutes(app: FastifyInstance, db: Database, auth: Auth) {
  const base = "/api/admin/enrollments/:enrollmentId/assessment-attempts";
  app.get(base, async (request) => {
    const actor = await auth.authenticate(request);
    return transaction(db, async (client) => attemptsView(client, await enrollmentFor(client, actor, enrollmentId(request), "policy.read")));
  });
  app.post(`${base}/grant`, async (request) => {
    const actor = await auth.authenticate(request), input = parse(grantInput, request.body);
    const { expectedRevision, idempotencyKey, ...semantic } = input;
    return enrollmentCommand(db, actor, enrollmentId(request), "policy.write", "admin.assessment.grant_attempt", { expectedRevision, idempotencyKey }, semantic,
      async (client, context) => {
        const course = context.release.server_bundle;
        const known = courseChecks(course).some((c) => c.checkId === input.checkId)
          || (input.checkId.startsWith("item:") && Boolean(findAssessment(course, input.checkId.slice(5))));
        requireCondition(known, "UNKNOWN_CHECK", 404);
        const event = await appendEvent(client, { workspaceId: context.enrollment.workspace_id, enrollmentId: context.enrollment.id, actorId: actor.id, actorKind: "staff",
          type: "assessment.attempt_granted", payload: { checkId: input.checkId, count: 1, reason: input.reason, grantedBy: actor.id },
          idempotencyKey: `${context.enrollment.id}:${idempotencyKey}`, supervise: true });
        await client.query("UPDATE enrollments SET revision=revision+1 WHERE id=$1", [context.enrollment.id]);
        const updated = await enrollmentFor(client, actor, context.enrollment.id, "policy.read");
        return { ...(await attemptsView(client, updated)), receipt: { id: event.id, authority: "server" as const, outcome: "granted" } };
      });
  });
}
