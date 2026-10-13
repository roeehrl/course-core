import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { digestTeachingArtifact, type TeachingArtifact } from "@course-core/sdk";
import { createDatabase, type Database } from "../src/database.js";
import { migrate } from "../src/migrations.js";
import { createServer } from "../src/server.js";
import { issueLoginCode, type Actor } from "../src/auth.js";
import { authoredTeachingBankAdapter, createAdaptationRuntime, stageVerifiedAdaptation, type AdaptationConfiguration } from "../src/adaptation-store.js";
import { fixture } from "./fixture.js";

// Real PostgreSQL only: a fresh random schema per run.
const origin = "http://localhost:4391",
  schema = "episode_insert_" + randomUUID().replaceAll("-", ""),
  directory = fileURLToPath(new URL("../migrations", import.meta.url)),
  adapter = authoredTeachingBankAdapter(),
  runtime = createAdaptationRuntime([adapter]),
  source = "ordering-remedial-reference",
  workspace = randomUUID();
let root: Database, db: Database, app: Awaited<ReturnType<typeof createServer>>;
interface Session { actor: Actor; cookie: string; csrf: string }
let staff: Session;
const entry = {
  id: "minimum-step-by-step",
  kind: "episode" as const,
  title: "Minimum, one comparison at a time",
  blocks: [
    { id: "walk", markdown: "Keep the smallest value seen so far. Compare it with each next value and keep whichever is smaller." },
    { id: "check", markdown: "When every value has been compared once, the kept value is the minimum." },
  ],
  objectiveIds: ["minimum"],
  sourceRefs: [source],
};

async function session(role: string): Promise<Session> {
  const actor = { id: randomUUID(), displayName: role };
  await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [actor.id, "insert:" + actor.id, role]);
  await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspace, actor.id, role]);
  const r = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, actor.id) } });
  return { actor, cookie: r.cookies.map((c) => c.name + "=" + c.value).join("; "), csrf: r.json().csrfToken };
}
const call = (who: Session, method: "GET" | "POST", url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { origin, cookie: who.cookie, "x-csrf-token": who.csrf }, ...(payload === undefined ? {} : { payload: payload as object }) });

function remedialCourse() {
  const course = fixture();
  course.id = "ordering-" + randomUUID().slice(0, 8);
  course.policy.work = { additionalMinutes: 20, additionalEpisodes: 2, remediationCyclesPerConcept: 4 };
  course.sources.push({ id: source, title: "Reviewed ordering walkthrough", url: "urn:example:ordering-remedial", reviewedAt: "2026-01-01T00:00:00Z" });
  course.extensions.push({ id: "remedial-extension", version: "1.0.0", integrity: "sha256-" + adapter.implementationDigest, execution: "server",
    entrypoint: "extensions/authored-teaching-bank-v1.js", platforms: ["web"], capabilities: ["teaching.generate", "teaching.verify"],
    accessibility: { keyboard: true, reducedMotion: true, textAlternative: "Readable remedial text." } });
  course.adaptation = { schemaVersion: 1, sourceRefs: [source], profileFieldIds: [],
    targets: [{ episodeId: "min", objectiveIds: ["minimum"], allowedOperations: ["insert_episode"], replaceableBlockIds: [] }], families: [],
    generators: [{ id: "remedial-generator", version: "1.0.0", extensionId: "remedial-extension", sourceRefs: [source], artifactKinds: ["episode"] }],
    verifiers: [{ id: "remedial-verifier", version: "1.0.0", extensionId: "remedial-extension", sourceRefs: [source], artifactKinds: ["episode"], requiredCheckIds: ["reviewed-teaching-match"] }],
    numericalRecipes: [],
    limits: { maxOperations: 1, maxArtifacts: 1, maxArtifactBytes: 20000, maxPlannedMinutesPerAssignment: 10, maxAdditionalEpisodesPerAssignment: 1, allowedClassifications: ["required", "optional"] } };
  return course;
}
function registry(classification: "required" | "optional", additionalEpisodes = 1): AdaptationConfiguration {
  return { authorizationMinutes: 30,
    verifiers: [{ id: "remedial-verifier", version: "1.0.0", implementationDigest: adapter.implementationDigest, sourceRefs: [source], artifactKinds: ["episode"], checkIds: ["reviewed-teaching-match"] }],
    profiles: [{ id: "remedial-profile", episodeId: "min", operation: "insert_episode", generatorId: "remedial-generator", verifierId: "remedial-verifier",
      adapterId: adapter.id, adapterDigest: adapter.implementationDigest, classification, plannedMinutes: 6, additionalEpisodes, teachingBank: [structuredClone(entry)] }] };
}
async function setup(classification: "required" | "optional") {
  const course = remedialCourse();
  const release = (await call(staff, "POST", `/api/workspaces/${workspace}/releases`, course)).json().id;
  expect((await call(staff, "POST", `/api/releases/${release}/publish`)).statusCode).toBe(200);
  const approved = await call(staff, "POST", `/api/admin/releases/${release}/adaptation-registry`, { expectedRegistryRevision: 0, configuration: registry(classification) });
  expect(approved.statusCode, approved.body).toBe(200);
  const learner = await session("learner");
  const enrollment = (await call(learner, "POST", "/api/enrollments", { releaseId: release })).json().id as string;
  return { course, release, learner, enrollment };
}
type Setup = Awaited<ReturnType<typeof setup>>;
async function view(s: Setup) {
  const r = await call(s.learner, "GET", "/api/enrollments/" + s.enrollment);
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
}
const summary = async (s: Setup) => (await call(s.learner, "GET", `/api/enrollments/${s.enrollment}/adaptation`)).json();
async function send(s: Setup, action: string, body: Record<string, unknown>) {
  return call(s.learner, "POST", `/api/enrollments/${s.enrollment}/${action}`, { expectedRevision: (await view(s)).revision, idempotencyKey: randomUUID(), ...body });
}
async function artifact(s: Setup, change: (a: any) => void = () => {}) {
  const artifactId = "artifact-" + randomUUID();
  const draft: any = { id: artifactId, kind: "episode", title: entry.title, blocks: entry.blocks.map((b) => ({ id: `${artifactId}--${b.id}`, markdown: b.markdown })),
    objectiveIds: ["minimum"], sourceRefs: [source], generator: { id: "remedial-generator", version: "1.0.0" } };
  change(draft);
  return { ...draft, digest: await digestTeachingArtifact(draft as TeachingArtifact) } as TeachingArtifact;
}
async function stage(s: Setup, made: TeachingArtifact, operation: Record<string, unknown> = {}) {
  const plan = await summary(s), operationId = "operation-" + randomUUID();
  return stageVerifiedAdaptation(db, staff.actor, {
    enrollmentId: s.enrollment, expectedRevision: (await view(s)).revision, expectedPlanRevision: plan.planRevision, idempotencyKey: randomUUID(),
    proposal: { schemaVersion: 1, id: "proposal-" + randomUUID(), baseCourseDigest: plan.baseCourseDigest ?? (await view(s)).digest, expectedPlanRevision: plan.planRevision,
      expectedPlanDigest: plan.planDigest, rationale: "Learner missed the minimum check twice; a reviewed step-by-step episode follows.",
      artifacts: [made], operations: [{ id: operationId, type: "insert_episode", afterEpisodeId: "min", artifactId: made.id, ...operation }] },
    profiles: [{ operationId, profileId: "remedial-profile" }],
  } as any, runtime);
}
async function insert(s: Setup) {
  const made = await artifact(s), staged = await stage(s, made);
  const applied = await call(staff, "POST", `/api/enrollments/${s.enrollment}/adaptation/${staged.proposalId}/apply`,
    { expectedRevision: (await view(s)).revision, expectedPlanRevision: (await summary(s)).planRevision, idempotencyKey: randomUUID() });
  expect(applied.statusCode, applied.body).toBe(200);
  return made;
}
async function passMinimum(s: Setup) {
  for (const [assessmentId, answer] of [["min-a", "two"], ["min-b", 4]] as const) {
    const issued = await send(s, "challenges", { episodeId: "min", assessmentId, mode: "independent" });
    expect(issued.statusCode, issued.body).toBe(200);
    expect((await send(s, "answers", { challengeId: issued.json().challengeId, answer })).json().result.passed).toBe(true);
  }
  expect((await send(s, "read", { episodeId: "min", blockId: "min-text" })).statusCode).toBe(200);
  const done = await send(s, "complete", { episodeId: "min" });
  expect(done.statusCode, done.body).toBe(200);
}

beforeAll(async () => {
  const url = new URL(process.env.TEST_DATABASE_URL ?? "");
  if (process.env.DATABASE_URL || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !/^\/course_core_(?:ci|test(?:_[a-z0-9_]+)?)$/.test(url.pathname) || url.search || url.hash)
    throw Error("Explicit disposable loopback database required");
  root = createDatabase(url.href);
  await root.query("CREATE SCHEMA " + schema);
  url.searchParams.set("options", "-csearch_path=" + schema);
  db = createDatabase(url.href);
  await migrate(db, directory);
  app = await createServer(db, { origin, secureCookies: false, adaptation: runtime });
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspace, "insert-" + workspace, "Insertion"]);
  staff = await session("owner");
}, 30000);
afterAll(async () => {
  await app?.close();
  await db?.end();
  if (root) {
    await root.query("DROP SCHEMA IF EXISTS " + schema + " CASCADE");
    await root.end();
  }
});

describe("reviewed remedial episode insertion", () => {
  it("inserts a required personal episode after its anchor that must be covered before the next episode, without grading or evidence", async () => {
    const s = await setup("required");
    const made = await insert(s);
    let v = await view(s);
    const order = v.course.chapters[0].episodes.map((e: any) => e.id);
    expect(order).toEqual(["min", made.id, "max"]);
    const inserted = v.course.chapters[0].episodes[1];
    expect(inserted).toMatchObject({ title: entry.title, objectiveIds: ["minimum"] });
    expect(inserted.gateId).toBeUndefined();
    expect(inserted.blocks.map((b: any) => b.markdown)).toEqual(entry.blocks.map((b) => b.markdown));
    expect(v.lessons.find((l: any) => l.id === made.id)).toMatchObject({ requirement: "required", status: "locked", gate: null });
    await passMinimum(s);
    v = await view(s);
    expect(v.lessons.map((l: any) => [l.id, l.status])).toEqual([["min", "completed"], [made.id, "available"], ["max", "locked"]]);
    expect(v.nextEpisodeId).toBe(made.id);
    // Coverage of every inserted block is required before completion.
    expect((await send(s, "complete", { episodeId: made.id })).json().error).toBe("COVERAGE_REQUIRED");
    for (const block of inserted.blocks) expect((await send(s, "read", { episodeId: made.id, blockId: block.id })).statusCode).toBe(200);
    expect((await send(s, "complete", { episodeId: made.id })).statusCode).toBe(200);
    v = await view(s);
    expect(v.lessons.map((l: any) => [l.id, l.status])).toEqual([["min", "completed"], [made.id, "completed"], ["max", "available"]]);
    // No evidence or demonstrated objective is minted by reading a personal episode.
    expect(Number((await db.query("SELECT count(*) FROM evidence WHERE enrollment_id=$1", [s.enrollment])).rows[0].count)).toBe(2);
    const changes = (await call(s.learner, "GET", `/api/enrollments/${s.enrollment}/personal-changes`)).json().changes;
    expect(changes).toEqual([expect.objectContaining({ kind: "insert_episode", episodeId: made.id, episodeTitle: entry.title, classification: "required", hideable: false })]);
    expect((await send(s, "personal-changes/visibility", { episodeId: made.id, blockId: changes[0].blockId, hidden: true })).json().error).toBe("CHANGE_NOT_HIDEABLE");
  }, 30000);

  it("an optional inserted episode never blocks progress and the learner can hide and restore it whole", async () => {
    const s = await setup("optional");
    const made = await insert(s);
    await passMinimum(s);
    let v = await view(s);
    expect(v.lessons.map((l: any) => [l.id, l.requirement, l.status])).toEqual([["min", "required", "completed"], [made.id, "optional", "available"], ["max", "required", "available"]]);
    expect(v.nextEpisodeId).toBe("max");
    const change = (await call(s.learner, "GET", `/api/enrollments/${s.enrollment}/personal-changes`)).json().changes[0];
    expect(change).toMatchObject({ episodeId: made.id, hideable: true, hidden: false });
    expect((await send(s, "personal-changes/visibility", { episodeId: made.id, blockId: change.blockId, hidden: true })).statusCode).toBe(200);
    v = await view(s);
    expect(v.course.chapters[0].episodes.find((e: any) => e.id === made.id).blocks).toEqual([]);
    expect((await send(s, "personal-changes/visibility", { episodeId: made.id, blockId: change.blockId, hidden: false })).statusCode).toBe(200);
    expect((await view(s)).course.chapters[0].episodes.find((e: any) => e.id === made.id).blocks).toHaveLength(2);
  }, 30000);

  it("rejects changed reviewed text, a wrong anchor, colliding block IDs and an unmetered profile with no plan change", async () => {
    const s = await setup("required");
    const before = await summary(s);
    await expect(stage(s, await artifact(s, (a) => { a.blocks[1].markdown += " Also, the minimum is always the first value."; }))).rejects.toMatchObject({ code: "ADAPTATION_VERIFICATION_FAILED" });
    await expect(stage(s, await artifact(s), { afterEpisodeId: "max" })).rejects.toMatchObject({ code: "PROFILE_BINDING" });
    await expect(stage(s, await artifact(s, (a) => { a.blocks[0].id = "min-text"; }))).rejects.toMatchObject({ code: "DUPLICATE_ID" });
    expect((await summary(s)).planRevision).toBe(before.planRevision);
    expect((await view(s)).course.chapters[0].episodes.map((e: any) => e.id)).toEqual(["min", "max"]);
    const course = remedialCourse();
    const release = (await call(staff, "POST", `/api/workspaces/${workspace}/releases`, course)).json().id;
    expect((await call(staff, "POST", `/api/releases/${release}/publish`)).statusCode).toBe(200);
    const unmetered = await call(staff, "POST", `/api/admin/releases/${release}/adaptation-registry`, { expectedRegistryRevision: 0, configuration: registry("required", 0) });
    expect(unmetered.json().error, unmetered.body).toBe("TEACHING_PROFILE_INVALID");
  }, 30000);
});
