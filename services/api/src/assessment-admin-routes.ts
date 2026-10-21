import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import { z } from "zod";
import type { Assessment, CourseManifest } from "@course-core/sdk";
import { compileCourse } from "@course-core/sdk/compiler";
import type { authService } from "./auth.js";
import { transaction, type Database } from "./database.js";
import { ApiError, requireCondition } from "./errors.js";
import { appendEvent } from "./events.js";
import { adminPermissionMatrix, catalogFor, releasesFor, type Catalog, type ReleaseRow } from "./admin-routes.js";
import { gradeDeterministic } from "./learning.js";
import { DETERMINISTIC_ITEM_TYPES, reviewedRubric } from "./gates.js";
import { REVIEW_WINDOWS, sourceFreshness } from "./source-freshness.js";

/**
 * Answer keys, rubrics and test answers for a course's questions (Q09).
 *
 * Keys and rubrics are part of a course release, and published releases never change (learners'
 * attempts stay bound to what graded them, see grading-provenance.ts). Staff therefore edit them on a
 * draft release, which is validated like any draft and must then be reviewed and published.
 *
 * Test answers ("fixtures") belong to the course, not to one release: an answer a question must
 * reject (a wrong-answer fixture, usually a likely misconception) or must accept. A test run grades
 * every fixture against one release's keys with the same deterministic grader learners get, and is
 * recorded for the validation report. A key change is previewed against the fixtures first, and a
 * change that makes a fixture fail is saved only when staff say so explicitly. Code and written
 * items are reported as not runnable here: code needs the sandbox evaluator and written answers a
 * reviewer, and this screen never starts either. Keys and fixtures are visible to `course.write`
 * only (they reveal answers); learners never see them.
 */
const MAX_FIXTURES_PER_ITEM = 50, MAX_FIXTURES_PER_COURSE = 2000;
const id = z.string().min(1).max(200);
const text = (max: number) => z.string().trim().min(1).max(max);
const explanation = text(4000);
/** The key shapes Core grades itself (SDK 0.5 grading of deterministic items). */
const keySchemas = {
  choice: z.strictObject({ correctOptionId: id, explanation }),
  numeric: z.strictObject({ expected: z.number().finite(), absoluteTolerance: z.number().finite().min(0), relativeTolerance: z.number().finite().min(0).max(1).optional(),
    unit: z.string().trim().min(1).max(50).optional(), explanation }),
  trace: z.strictObject({ expected: z.array(z.strictObject({ stepId: id, answer: z.string().max(2000) })).min(1).max(100),
    match: z.enum(["exact", "case_insensitive", "normalized_whitespace"]), explanation }),
};
const keySchemaFor = (type: string) => type === "choice" ? keySchemas.choice : type === "numeric" || type === "prediction" ? keySchemas.numeric : type === "trace" ? keySchemas.trace : undefined;
const criteriaSchema = z.array(z.strictObject({ id: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/), description: text(2000), required: z.boolean() })).min(1).max(12)
  .refine((rows) => new Set(rows.map((r) => r.id)).size === rows.length);
/** Learner answer shapes, as the answers route accepts them. */
const answerSchema = z.union([z.string().max(2000), z.number().finite(),
  z.strictObject({ value: z.number().finite(), unit: z.string().min(1).max(50) }),
  z.record(z.string().min(1).max(200), z.string().max(2000)).refine((v) => Object.keys(v).length <= 100)]);
const digest = z.string().regex(/^[a-f0-9]{64}$/);

type Outcome = "correct" | "incorrect" | "invalid_answer" | "not_runnable" | "item_missing";
interface FixtureRow { id: string; assessment_id: string; label: string; answer: unknown; expected: "correct" | "incorrect"; created_at: Date; created_by_name?: string }
/** Grades one test answer against an item's key, exactly as a learner's answer is graded. */
export function gradeFixture(item: Assessment | undefined, answer: unknown): Outcome {
  if (!item) return "item_missing";
  if (!DETERMINISTIC_ITEM_TYPES.has(item.type)) return "not_runnable";
  try { return gradeDeterministic(item, answer).passed ? "correct" : "incorrect"; }
  catch (error) { if (error instanceof ApiError) return "invalid_answer"; throw error; }
}
const fixtureResult = (fixture: FixtureRow, outcome: Outcome) => ({
  fixtureId: fixture.id, assessmentId: fixture.assessment_id, label: fixture.label, expected: fixture.expected, outcome,
  /** Passes when graded as expected; not runnable here is neither a pass nor a failure. */
  status: outcome === "not_runnable" ? "not_runnable" as const : outcome === fixture.expected ? "passed" as const : "failed" as const,
});
async function liveFixtures(client: PoolClient, catalog: Catalog, assessmentId?: string) {
  return (await client.query<FixtureRow>(
    `SELECT f.id,f.assessment_id,f.label,f.answer,f.expected,f.created_at,u.display_name AS created_by_name FROM assessment_fixtures f JOIN app_users u ON u.id=f.created_by
      WHERE f.workspace_id=$1 AND f.course_key=$2 AND f.removed_at IS NULL AND ($3::text IS NULL OR f.assessment_id=$3) ORDER BY f.assessment_id,f.created_at,f.id LIMIT ${MAX_FIXTURES_PER_COURSE}`,
    [catalog.workspace_id, catalog.course_key, assessmentId ?? null])).rows;
}
/** Course text and keys of one release's questions, for the editor. */
function itemView(item: Assessment, course: CourseManifest, fixtures: FixtureRow[], editable: boolean) {
  const base = { assessmentId: item.id, type: item.type, prompt: item.prompt, objectiveIds: item.objectiveIds, familyId: item.familyId, fixtures: fixtures.filter((f) => f.assessment_id === item.id).length };
  if (item.type === "choice") return { ...base, kind: "key" as const, editable, options: item.options.map((o) => ({ id: o.id, text: o.text })), key: item.grading };
  if (item.type === "numeric" || item.type === "prediction" || item.type === "trace")
    return { ...base, kind: "key" as const, editable, ...(item.type === "trace" ? { steps: item.steps } : {}), key: item.grading };
  const rubric = reviewedRubric(course, item.id);
  if (item.type === "rubric") return { ...base, kind: "item_rubric" as const, editable, criteria: item.grading.rubric };
  if (rubric?.rubricRef) return { ...base, kind: "course_rubric" as const, editable: false, rubricId: rubric.rubricRef.id };
  return { ...base, kind: "not_editable" as const, editable: false };
}
const releaseOf = async (client: PoolClient, catalog: Catalog, releaseId: string) => {
  const release = (await releasesFor(client, catalog)).find((r) => r.id === releaseId);
  requireCondition(release, "RELEASE_NOT_FOUND", 404);
  return release;
};
/** Saves an edited draft manifest the way the draft editor does: compiled, digest renewed, approval cleared. */
async function saveDraft(client: PoolClient, release: ReleaseRow, catalog: Catalog, manifest: CourseManifest) {
  let compiled: ReturnType<typeof compileCourse>;
  try { compiled = compileCourse(manifest); } catch (error) {
    throw new ApiError(400, "COURSE_INVALID", "COURSE_INVALID", { message: String((error as Error).message).slice(0, 400) });
  }
  requireCondition(compiled.server.id === catalog.course_key && compiled.server.version === release.version, "COURSE_IDENTITY_MISMATCH");
  await client.query("UPDATE course_releases SET server_bundle=$2,learner_bundle=$3,digest=$4 WHERE id=$1",
    [release.id, JSON.stringify(compiled.server), JSON.stringify(compiled.learner), compiled.digest]);
  await client.query("UPDATE admin_release_reviews SET state='draft',reviewed_digest=NULL,reviewed_by=NULL,updated_at=now() WHERE release_id=$1", [release.id]);
  await client.query("UPDATE admin_course_catalog SET revision=revision+1 WHERE id=$1", [catalog.id]);
  return compiled.digest;
}
/** A locked draft release whose content is still what the editor last saw. */
async function lockedDraft(client: PoolClient, catalog: Catalog, releaseId: string, expectedDigest: string) {
  const release = await releaseOf(client, catalog, releaseId);
  const locked = (await client.query<{ status: string; digest: string }>("SELECT status,digest FROM course_releases WHERE id=$1 FOR UPDATE", [release.id])).rows[0]!;
  requireCondition(locked.status === "draft", "PUBLISHED_RELEASE_IMMUTABLE", 409);
  requireCondition(locked.digest === expectedDigest, "RELEASE_CHANGED", 409);
  return release;
}
/** The draft with one item's key replaced. */
function withKey(course: CourseManifest, assessmentId: string, grading: unknown) {
  const manifest = structuredClone(course);
  const item = manifest.assessments.find((a) => a.id === assessmentId);
  requireCondition(item, "ASSESSMENT_NOT_FOUND", 404);
  const schema = keySchemaFor(item.type);
  requireCondition(schema, "KEY_NOT_EDITABLE", 409);
  const parsed = schema.safeParse(grading);
  requireCondition(parsed.success, "INVALID_KEY", 400);
  if (item.type === "choice") requireCondition(item.options.some((o) => o.id === (parsed.data as { correctOptionId: string }).correctOptionId), "INVALID_KEY", 400);
  if (item.type === "trace") {
    const steps = (parsed.data as { expected: { stepId: string }[] }).expected.map((s) => s.stepId);
    requireCondition(steps.length === item.steps.length && item.steps.every((s) => steps.includes(s.id)), "INVALID_KEY", 400);
  }
  (item as { grading: unknown }).grading = parsed.data;
  return { manifest, before: course.assessments.find((a) => a.id === assessmentId)!, after: item };
}
/** How the item's fixtures grade under the current and the proposed key. */
function keyImpact(fixtures: FixtureRow[], before: Assessment, after: Assessment) {
  const results = fixtures.filter((f) => f.assessment_id === after.id).map((f) => {
    const was = gradeFixture(before, f.answer), now = gradeFixture(after, f.answer);
    return { ...fixtureResult(f, now), before: was, changed: was !== now };
  });
  return { results, failing: results.filter((r) => r.status === "failed").length, changed: results.filter((r) => r.changed).length };
}

export function registerAssessmentAdminRoutes(app: FastifyInstance, db: Database, auth: ReturnType<typeof authService>) {
  const base = "/api/admin/courses/:courseId";
  const p = (request: FastifyRequest) => request.params as Record<string, string>;
  const body = <S extends z.ZodType>(schema: S, value: unknown): z.output<S> => {
    const parsed = schema.safeParse(value);
    requireCondition(parsed.success, "INVALID_REQUEST", 400);
    return parsed.data;
  };
  const audit = (client: PoolClient, catalog: Catalog, actorId: string, type: string, payload: Record<string, unknown>) =>
    appendEvent(client, { workspaceId: catalog.workspace_id, actorId, actorKind: "staff", type, payload: { catalogId: catalog.id, ...payload }, idempotencyKey: `${type}:${randomUUID()}` });

  /** When each source the release cites was last reviewed, against a review window (Q09). */
  app.get(`${base}/releases/:releaseId/sources`, async (request, reply) => {
    const actor = await auth.authenticate(request);
    const { windowDays } = body(z.strictObject({ windowDays: z.coerce.number().int().refine((n) => (REVIEW_WINDOWS as readonly number[]).includes(n)).default(365) }), request.query ?? {});
    const view = await transaction(db, async (client) => {
      const { catalog } = await catalogFor(client, actor, p(request).courseId!, "course.read");
      const release = await releaseOf(client, catalog, p(request).releaseId!);
      return { release: { id: release.id, version: release.version, status: release.status }, ...sourceFreshness(release.server_bundle, new Date(), windowDays) };
    });
    reply.header("Cache-Control", "no-store");
    return view;
  });
  /** One release's questions with their keys and rubrics, and how many test answers each has. */
  app.get(`${base}/releases/:releaseId/assessments`, async (request, reply) => {
    const actor = await auth.authenticate(request);
    const view = await transaction(db, async (client) => {
      const { catalog } = await catalogFor(client, actor, p(request).courseId!, "course.write");
      const release = await releaseOf(client, catalog, p(request).releaseId!);
      const course = release.server_bundle, editable = release.status === "draft", fixtures = await liveFixtures(client, catalog);
      return {
        release: { id: release.id, version: release.version, status: release.status, digest: release.digest, editable },
        items: course.assessments.map((item) => itemView(item, course, fixtures, editable)),
        rubrics: (course.rubrics ?? []).map((r) => ({ id: r.id, version: r.version, title: r.title, criteria: r.criteria.map(({ id, description, required }) => ({ id, description, required })),
          usedBy: course.assessments.filter((a) => reviewedRubric(course, a.id)?.rubricRef?.id === r.id).map((a) => a.id) })),
      };
    });
    reply.header("Cache-Control", "no-store");
    return view;
  });

  const keyInput = z.strictObject({ grading: z.unknown() });
  /** Test before save: how the item's test answers grade under the proposed key. Nothing is written. */
  app.post(`${base}/releases/:releaseId/assessments/:assessmentId/key/preview`, async (request) => {
    const actor = await auth.authenticate(request), input = body(keyInput, request.body);
    return transaction(db, async (client) => {
      const { catalog } = await catalogFor(client, actor, p(request).courseId!, "course.write");
      const release = await releaseOf(client, catalog, p(request).releaseId!);
      const { before, after } = withKey(release.server_bundle, p(request).assessmentId!, input.grading);
      return keyImpact(await liveFixtures(client, catalog, after.id), before, after);
    });
  });
  app.put(`${base}/releases/:releaseId/assessments/:assessmentId/key`, async (request) => {
    const actor = await auth.authenticate(request);
    const input = body(z.strictObject({ grading: z.unknown(), expectedDigest: digest, acceptFailingFixtures: z.boolean().default(false) }), request.body);
    return transaction(db, async (client) => {
      const { catalog } = await catalogFor(client, actor, p(request).courseId!, "course.write", true);
      const release = await lockedDraft(client, catalog, p(request).releaseId!, input.expectedDigest);
      const { manifest, before, after } = withKey(release.server_bundle, p(request).assessmentId!, input.grading);
      const impact = keyImpact(await liveFixtures(client, catalog, after.id), before, after);
      // A key that marks a recorded test answer the wrong way is saved only on explicit request.
      if (impact.failing && !input.acceptFailingFixtures) throw new ApiError(409, "FIXTURES_FAIL", "FIXTURES_FAIL", impact);
      const saved = await saveDraft(client, release, catalog, manifest);
      await audit(client, catalog, actor.id, "admin.assessment.key_changed", { releaseId: release.id, assessmentId: after.id, failingFixtures: impact.failing, changedFixtures: impact.changed });
      return { releaseId: release.id, digest: saved, ...impact };
    });
  });
  /**
   * A rubric's criteria on a draft: a course rubric (by id, versioned) or a 0.4 written item's own
   * rubric. Changed criteria under an unchanged version would make two different rubrics look the
   * same to past reviews, so a course rubric must get a new version when its criteria change from
   * the latest published release.
   */
  app.put(`${base}/releases/:releaseId/rubrics/:rubricId`, async (request) => {
    const actor = await auth.authenticate(request);
    const input = body(z.strictObject({ criteria: criteriaSchema, version: z.string().regex(/^\d+\.\d+\.\d+$/).optional(), expectedDigest: digest }), request.body);
    return transaction(db, async (client) => {
      const { catalog } = await catalogFor(client, actor, p(request).courseId!, "course.write", true);
      const release = await lockedDraft(client, catalog, p(request).releaseId!, input.expectedDigest);
      const manifest = structuredClone(release.server_bundle), rubricId = p(request).rubricId!;
      const rubric = manifest.rubrics?.find((r) => r.id === rubricId);
      const item = manifest.assessments.find((a) => a.id === rubricId && a.type === "rubric");
      requireCondition(rubric || item, "RUBRIC_NOT_FOUND", 404);
      if (rubric) {
        requireCondition(input.version, "RUBRIC_VERSION_REQUIRED", 400);
        const published = (await releasesFor(client, catalog)).filter((r) => r.status === "published" || r.status === "archived")
          .map((r) => r.server_bundle.rubrics?.find((x) => x.id === rubricId)).filter((x) => x !== undefined);
        const changed = (a: { id: string; description: string; required: boolean }[]) =>
          JSON.stringify(a.map(({ id, description, required }) => ({ id, description, required }))) !== JSON.stringify(input.criteria);
        // A version already published may only carry exactly its published criteria.
        requireCondition(!published.some((r) => r.version === input.version && changed(r.criteria)), "RUBRIC_VERSION_REQUIRED", 409);
        rubric.version = input.version!;
        rubric.criteria = input.criteria.map((c) => ({ ...rubric.criteria.find((x) => x.id === c.id), ...c, evidence: rubric.criteria.find((x) => x.id === c.id)?.evidence ?? rubric.criteria[0]!.evidence }));
      } else if (item && item.type === "rubric") item.grading = { ...item.grading, rubric: input.criteria };
      const saved = await saveDraft(client, release, catalog, manifest);
      await audit(client, catalog, actor.id, "admin.assessment.rubric_changed", { releaseId: release.id, rubricId, version: input.version ?? null, criteria: input.criteria.length });
      return { releaseId: release.id, digest: saved };
    });
  });

  /** The course's test answers, optionally for one question. They reveal answers: course.write only. */
  app.get(`${base}/assessment-fixtures`, async (request, reply) => {
    const actor = await auth.authenticate(request), query = body(z.strictObject({ assessmentId: id.optional() }), request.query ?? {});
    const fixtures = await transaction(db, async (client) => {
      const { catalog } = await catalogFor(client, actor, p(request).courseId!, "course.write");
      return liveFixtures(client, catalog, query.assessmentId);
    });
    reply.header("Cache-Control", "no-store");
    return { fixtures: fixtures.map((f) => ({ fixtureId: f.id, assessmentId: f.assessment_id, label: f.label, answer: f.answer, expected: f.expected, createdAt: f.created_at.toISOString(),
      createdBy: f.created_by_name })), limits: { perItem: MAX_FIXTURES_PER_ITEM, perCourse: MAX_FIXTURES_PER_COURSE } };
  });
  app.post(`${base}/assessment-fixtures`, async (request) => {
    const actor = await auth.authenticate(request);
    const input = body(z.strictObject({ assessmentId: id, answer: answerSchema, expected: z.enum(["correct", "incorrect"]), label: z.string().trim().max(200).default(""),
      releaseId: z.uuid() }), request.body);
    return transaction(db, async (client) => {
      const { catalog } = await catalogFor(client, actor, p(request).courseId!, "course.write", true);
      // The answer must be one a learner could give to this question in the release staff are looking at.
      const release = await releaseOf(client, catalog, input.releaseId);
      const item = release.server_bundle.assessments.find((a) => a.id === input.assessmentId);
      requireCondition(item, "ASSESSMENT_NOT_FOUND", 404);
      requireCondition(DETERMINISTIC_ITEM_TYPES.has(item.type), "FIXTURE_NOT_RUNNABLE", 409);
      const outcome = gradeFixture(item, input.answer);
      requireCondition(outcome !== "invalid_answer", "FIXTURE_ANSWER_INVALID", 400);
      const existing = await liveFixtures(client, catalog);
      requireCondition(existing.length < MAX_FIXTURES_PER_COURSE && existing.filter((f) => f.assessment_id === item.id).length < MAX_FIXTURES_PER_ITEM, "FIXTURE_LIMIT", 409);
      const same = existing.find((f) => f.assessment_id === item.id && JSON.stringify(f.answer) === JSON.stringify(input.answer));
      requireCondition(!same, "FIXTURE_DUPLICATE", 409);
      const fixtureId = randomUUID();
      await client.query("INSERT INTO assessment_fixtures(id,workspace_id,course_key,assessment_id,label,answer,expected,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [fixtureId, catalog.workspace_id, catalog.course_key, item.id, input.label, JSON.stringify(input.answer), input.expected, actor.id]);
      await audit(client, catalog, actor.id, "admin.assessment.fixture_added", { fixtureId, assessmentId: item.id, expected: input.expected });
      // Right away: does the release's current key agree with it?
      return { ...fixtureResult({ id: fixtureId, assessment_id: item.id, label: input.label, answer: input.answer, expected: input.expected, created_at: new Date() }, outcome) };
    });
  });
  app.delete(`${base}/assessment-fixtures/:fixtureId`, async (request) => {
    const actor = await auth.authenticate(request), fixtureId = body(z.uuid(), p(request).fixtureId);
    return transaction(db, async (client) => {
      const { catalog } = await catalogFor(client, actor, p(request).courseId!, "course.write", true);
      const removed = (await client.query<{ assessment_id: string }>(
        "UPDATE assessment_fixtures SET removed_at=clock_timestamp(),removed_by=$4 WHERE id=$1 AND workspace_id=$2 AND course_key=$3 AND removed_at IS NULL RETURNING assessment_id",
        [fixtureId, catalog.workspace_id, catalog.course_key, actor.id])).rows[0];
      requireCondition(removed, "FIXTURE_NOT_FOUND", 404);
      await audit(client, catalog, actor.id, "admin.assessment.fixture_removed", { fixtureId, assessmentId: removed.assessment_id });
      return { fixtureId, removed: true };
    });
  });

  /** Grades every test answer against one release's keys and records the run. */
  app.post(`${base}/releases/:releaseId/fixture-runs`, async (request) => {
    const actor = await auth.authenticate(request);
    return transaction(db, async (client) => {
      const { catalog } = await catalogFor(client, actor, p(request).courseId!, "course.write", true);
      const release = await releaseOf(client, catalog, p(request).releaseId!);
      const results = (await liveFixtures(client, catalog)).map((f) => fixtureResult(f, gradeFixture(release.server_bundle.assessments.find((a) => a.id === f.assessment_id), f.answer)));
      const count = (status: string) => results.filter((r) => r.status === status).length;
      const runId = randomUUID();
      await client.query(`INSERT INTO assessment_fixture_runs(id,workspace_id,course_key,release_id,release_digest,actor_id,passed,failed,not_runnable,results) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [runId, catalog.workspace_id, catalog.course_key, release.id, release.digest, actor.id, count("passed"), count("failed"), count("not_runnable"), JSON.stringify(results)]);
      await audit(client, catalog, actor.id, "admin.assessment.fixtures_run", { runId, releaseId: release.id, passed: count("passed"), failed: count("failed"), notRunnable: count("not_runnable") });
      return { runId, release: { id: release.id, version: release.version, status: release.status }, passed: count("passed"), failed: count("failed"), notRunnable: count("not_runnable"), results };
    });
  });
  /** The validation report: recent runs. Counts for anyone who can read the course; each test answer's result only for course.write. */
  app.get(`${base}/fixture-runs`, async (request, reply) => {
    const actor = await auth.authenticate(request);
    const view = await transaction(db, async (client) => {
      const { catalog, role } = await catalogFor(client, actor, p(request).courseId!, "course.read");
      const detailed = (adminPermissionMatrix[role] ?? []).includes("course.write");
      const rows = (await client.query<{ id: string; release_id: string; version: string; release_digest: string; current_digest: string; passed: number; failed: number; not_runnable: number;
        results: unknown; created_at: Date; display_name: string }>(
        `SELECT f.id,f.release_id,r.version,f.release_digest,r.digest AS current_digest,f.passed,f.failed,f.not_runnable,f.results,f.created_at,u.display_name
           FROM assessment_fixture_runs f JOIN course_releases r ON r.id=f.release_id JOIN app_users u ON u.id=f.actor_id
          WHERE f.workspace_id=$1 AND f.course_key=$2 ORDER BY f.created_at DESC,f.id LIMIT 20`, [catalog.workspace_id, catalog.course_key])).rows;
      return { runs: rows.map((r) => ({ runId: r.id, releaseId: r.release_id, releaseVersion: r.version, passed: r.passed, failed: r.failed, notRunnable: r.not_runnable,
        /** The draft changed after this run: its result may no longer hold. */
        stale: r.release_digest !== r.current_digest, at: r.created_at.toISOString(), by: r.display_name, ...(detailed ? { results: r.results } : {}) })) };
    });
    reply.header("Cache-Control", "no-store");
    return view;
  });
}
