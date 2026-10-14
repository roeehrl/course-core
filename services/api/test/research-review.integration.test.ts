import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import type { ResearchPolicy } from "@course-core/research";
import { syntheticResearchInspector, researchPage as page } from "./research-fixture.js";
import { createDatabase, type Database } from "../src/database.js";
import { migrate } from "../src/migrations.js";
import { createServer } from "../src/server.js";
import { issueLoginCode } from "../src/auth.js";
import { fixture } from "./fixture.js";

const origin = "http://localhost:4382",
  schema = "research_review_" + randomUUID().replaceAll("-", ""),
  directory = fileURLToPath(new URL("../migrations", import.meta.url));
let root: Database, db: Database, app: Awaited<ReturnType<typeof createServer>>;
let workspace: string, release: string, owner: Session, learner: Session, author: Session, reviewer: Session;
const inspected: { policy: ResearchPolicy; sourceId: string }[] = [];
let failNext: string | undefined;
interface Session {
  userId: string;
  cookie: string;
  csrf: string;
}
const inspector = syntheticResearchInspector({
  record: inspected,
  failNext: () => {
    const code = failNext;
    failNext = undefined;
    return code;
  },
});
async function session(role: string, workspaceId = workspace): Promise<Session> {
  const id = randomUUID();
  await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [id, "research:" + id, "Research test"]);
  await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspaceId, id, role]);
  const r = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, id) } });
  expect(r.statusCode).toBe(200);
  return { userId: id, cookie: r.cookies.map((c) => c.name + "=" + c.value).join("; "), csrf: r.json().csrfToken };
}
function call(who: Session, method: "GET" | "POST", url: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    headers: { origin, cookie: who.cookie, "x-csrf-token": who.csrf },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
}
const days = (n: number) => new Date(Date.now() + n * 86400_000).toISOString();
const key = () => "k-" + randomUUID();
async function library(who = owner) {
  const r = await call(who, "GET", `/api/admin/releases/${release}/research/library`);
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
}
async function addSource(body: Record<string, unknown>, who = owner) {
  return call(who, "POST", `/api/admin/releases/${release}/research/sources`, {
    topicId: "minimum-research",
    kind: "web",
    url: "https://docs.python.org/3/library/functions.html",
    expiresAt: days(30),
    idempotencyKey: key(),
    ...body,
  });
}
const approval = (contentDigest: string, extra: Record<string, unknown> = {}) => ({
  decision: "approved",
  contentDigest,
  rationale: "Explains the running-minimum invariant with a concrete comparison loop.",
  evidence: [{ quote: "Each comparison keeps the smaller value", relevance: "States the invariant learners must explain in the episode." }],
  suitability: { topicRelevant: true, accurateEnoughForUse: true, safeForAudience: true },
  rights: { use: "link_only", basis: "link_only", reference: "Linked with attribution only; no copy." },
  acknowledgesTruncation: false,
  idempotencyKey: key(),
  ...extra,
});
async function resources(episodeId = "min", who = learner, enrollment?: string) {
  const id = enrollment ?? (await call(who, "POST", "/api/enrollments", { releaseId: release })).json().id;
  const r = await call(who, "GET", `/api/enrollments/${id}/resources?episodeId=${episodeId}`);
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
}
beforeAll(async () => {
  const connection = process.env.TEST_DATABASE_URL ?? "";
  const url = new URL(connection);
  if (
    process.env.DATABASE_URL ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    !/^\/course_core_(?:ci|test(?:_[a-z0-9_]+)?)$/.test(url.pathname) ||
    url.search ||
    url.hash
  )
    throw Error("Explicit disposable loopback database required");
  root = createDatabase(connection);
  await root.query("CREATE SCHEMA " + schema);
  url.searchParams.set("options", "-csearch_path=" + schema);
  db = createDatabase(url.href);
  await migrate(db, directory);
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false, researchInspector: inspector });
});
beforeEach(async () => {
  workspace = randomUUID();
  inspected.length = 0;
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspace, "research-" + workspace, "Research example"]);
  owner = await session("owner");
  learner = await session("learner");
  author = await session("author");
  reviewer = await session("reviewer");
  const manifest = fixture();
  manifest.research = {
    publicTopics: [
      { id: "minimum-research", objectiveIds: ["minimum"], queryText: "Public explanation of finding the minimum of a list", allowedDomains: ["docs.python.org"] },
      { id: "maximum-research", objectiveIds: ["maximum"], queryText: "Public explanation of finding the maximum of a list" },
    ],
  };
  const created = await call(owner, "POST", `/api/workspaces/${workspace}/releases`, manifest);
  expect(created.statusCode, created.body).toBe(200);
  release = created.json().id;
  expect((await call(owner, "POST", `/api/releases/${release}/publish`)).statusCode).toBe(200);
});
afterAll(async () => {
  await app?.close();
  await db?.end();
  if (root) {
    await root.query("DROP SCHEMA " + schema + " CASCADE");
    await root.end();
  }
});

describe("research source inspection, review and optional delivery", () => {
  it("binds a staff-approved source through inspection, evidence-backed review, scoped attachment and revocation", async () => {
    const offDomain = await addSource({ url: "https://evil.example/minimum" });
    expect(offDomain.statusCode).toBe(409);
    expect(offDomain.json().error).toBe("RESEARCH_DOMAIN_NOT_ALLOWED");
    for (const url of ["http://docs.python.org/3/", "https://127.0.0.1/x", "https://user@docs.python.org/3/", "https://docs.python.org/3/?q=private"])
      expect((await addSource({ url })).statusCode, url).toBe(400);
    expect((await addSource({ topicId: "unapproved-topic" })).statusCode).toBe(409);
    expect((await addSource({ expiresAt: days(400) })).statusCode).toBe(400);
    expect((await addSource({}, learner)).statusCode).toBe(403);
    expect((await addSource({}, reviewer)).statusCode).toBe(403);

    const added = await addSource({}, author);
    expect(added.statusCode, added.body).toBe(200);
    const sourceId = added.json().sourceId;
    expect(added.json().contentUse).toBe("not_reviewed");
    expect((await addSource({})).json().error).toBe("RESEARCH_SOURCE_EXISTS");
    // A learner sees nothing before review and attachment.
    const enrollment = (await call(learner, "POST", "/api/enrollments", { releaseId: release })).json().id;
    expect((await resources("min", learner, enrollment)).resources).toEqual([]);

    expect((await call(learner, "POST", `/api/admin/research/sources/${sourceId}/inspect`, {})).statusCode).toBe(403);
    const inspection = await call(author, "POST", `/api/admin/research/sources/${sourceId}/inspect`, {});
    expect(inspection.statusCode, inspection.body).toBe(200);
    expect(inspection.json()).toMatchObject({ state: "unreviewed", trust: "untrusted_external_content", contentUse: "not_reviewed" });
    // Only the stored approval reaches the inspector: one source, one host, no learner data.
    expect(inspected).toHaveLength(1);
    expect(inspected[0]!.policy.allowedHosts).toEqual(["docs.python.org"]);
    expect(inspected[0]!.policy.sources.map((s) => s.url)).toEqual(["https://docs.python.org/3/library/functions.html"]);
    expect(JSON.stringify(inspected[0])).not.toContain(learner.userId);
    expect(JSON.stringify(inspected[0])).not.toContain(enrollment);

    const inspectionId = inspection.json().inspectionId;
    const before = await library();
    const view = before.sources[0];
    expect(view.inspections[0]).toMatchObject({ id: inspectionId, basis: "page", text: page });
    expect(before.grantsCredit).toBe(false);
    expect(before.topics[0].episodes).toEqual([{ id: "min", title: "Minimum" }]);
    const contentDigest = view.inspections[0].contentDigest;
    const review = (body: unknown, who = reviewer) => call(who, "POST", `/api/admin/research/inspections/${inspectionId}/review`, body);

    expect((await review(approval(contentDigest), author)).statusCode).toBe(403);
    const fabricated = await review(approval(contentDigest, { evidence: [{ quote: "The minimum is always the first element seen", relevance: "Fabricated quote that is not in the source text." }] }));
    expect(fabricated.json().error).toBe("RESEARCH_REVIEW_EVIDENCE_REQUIRED");
    expect((await review(approval("0".repeat(64)))).json().error).toBe("RESEARCH_INSPECTION_CHANGED");
    expect((await review(approval(contentDigest, { evidence: [] }))).json().error).toBe("RESEARCH_REVIEW_EVIDENCE_REQUIRED");
    expect((await review(approval(contentDigest, { suitability: { topicRelevant: true, accurateEnoughForUse: false, safeForAudience: true } }))).json().error).toBe("RESEARCH_REVIEW_EVIDENCE_REQUIRED");
    expect((await review(approval(contentDigest, { rights: { use: "excerpt", basis: "link_only", reference: "No licence" } }))).json().error).toBe("RESEARCH_RIGHTS_REQUIRED");
    expect((await review(approval(contentDigest, { rights: { use: "embed", basis: "provider_embed", reference: "Not a video" } }))).json().error).toBe("RESEARCH_RIGHTS_REQUIRED");

    const approvedBody = approval(contentDigest);
    const approved = await review(approvedBody);
    expect(approved.statusCode, approved.body).toBe(200);
    expect(approved.json()).toMatchObject({ decision: "approved", grantsCredit: false, qualification: "author_content_review_not_truth_certification" });
    // Idempotent replay returns the original receipt; a changed body under the same key conflicts.
    expect((await review(approvedBody)).json()).toEqual(approved.json());
    expect((await review({ ...approvedBody, rationale: "A different rationale reusing the same idempotency key." })).json().error).toBe("IDEMPOTENCY_CONFLICT");
    const reviewId = approved.json().reviewId;
    // Still nothing is delivered until a publisher attaches it to an in-scope episode.
    expect((await resources("min", learner, enrollment)).resources).toEqual([]);

    const attach = (body: Record<string, unknown>, who = owner) =>
      call(who, "POST", `/api/admin/research/reviews/${reviewId}/attachments`, { episodeId: "min", expiresAt: days(10), idempotencyKey: key(), ...body });
    expect((await attach({}, reviewer)).statusCode).toBe(403);
    expect((await attach({ episodeId: "max" })).json().error).toBe("RESEARCH_EPISODE_OUT_OF_SCOPE");
    expect((await attach({ expiresAt: days(31) })).json().error).toBe("RESEARCH_EXPIRY_INVALID");
    expect((await attach({ expiresAt: new Date(Date.now() - 1000).toISOString() })).json().error).toBe("RESEARCH_EXPIRY_INVALID");
    const progressBefore = (await call(learner, "GET", "/api/enrollments/" + enrollment)).json();
    const attached = await attach({});
    expect(attached.statusCode, attached.body).toBe(200);
    expect(attached.json()).toMatchObject({ optional: true, grantsCredit: false, state: "active" });
    expect((await attach({})).json().error).toBe("RESEARCH_ATTACHMENT_EXISTS");

    const delivered = await resources("min", learner, enrollment);
    expect(delivered).toMatchObject({ optional: true, grantsCredit: false });
    expect(delivered.resources).toHaveLength(1);
    expect(delivered.resources[0]).toMatchObject({
      title: "Finding a minimum",
      url: "https://docs.python.org/3/library/functions.html",
      excerpts: [],
      rightsUse: "link_only",
      qualification: "author_content_review_not_truth_certification",
    });
    expect(JSON.stringify(delivered)).not.toContain(page);
    expect((await resources("max", learner, enrollment)).resources).toEqual([]);
    const progressAfter = (await call(learner, "GET", "/api/enrollments/" + enrollment)).json();
    expect(progressAfter.revision).toBe(progressBefore.revision);
    expect(progressAfter.lessons).toEqual(progressBefore.lessons);
    // Another learner cannot read this enrollment's delivery.
    const other = await session("learner");
    expect((await call(other, "GET", `/api/enrollments/${enrollment}/resources?episodeId=min`)).statusCode).toBe(404);

    const attachmentId = attached.json().attachmentId;
    const revoke = (body: Record<string, unknown>, who = reviewer) => call(who, "POST", `/api/admin/research/attachments/${attachmentId}/revoke`, { reason: "Source page changed its explanation.", idempotencyKey: key(), ...body });
    expect((await revoke({}, author)).statusCode).toBe(403);
    expect((await revoke({ reason: "short" })).statusCode).toBe(400);
    expect((await revoke({})).statusCode).toBe(200);
    expect((await revoke({})).json().error).toBe("RESEARCH_ATTACHMENT_ALREADY_REVOKED");
    expect((await resources("min", learner, enrollment)).resources).toEqual([]);
    const after = await library();
    expect(after.attachments[0]).toMatchObject({ state: "revoked", revokeReason: "Source page changed its explanation." });
    const events = (await db.query("SELECT event_type FROM learning_events WHERE workspace_id=$1 AND event_type LIKE 'research.%' ORDER BY sequence", [workspace])).rows.map((r) => r.event_type);
    expect(events).toEqual(["research.source.added", "research.source.inspected", "research.source.reviewed", "research.resource.attached", "research.resource.revoked"]);
    const evidence = await db.query("SELECT count(*)::int AS n FROM evidence WHERE enrollment_id=$1", [enrollment]);
    expect(evidence.rows[0].n).toBe(0);
  });

  it("expires deliveries, lets later reviews supersede approval and records inspection failures without content", async () => {
    const sourceId = (await addSource({ topicId: "maximum-research", url: "https://example.org/maximum", expiresAt: days(5) })).json().sourceId;
    failNext = "HTTP_STATUS";
    const failed = await call(owner, "POST", `/api/admin/research/sources/${sourceId}/inspect`, {});
    expect(failed.statusCode).toBe(409);
    expect(failed.json().error).toBe("RESEARCH_HTTP_STATUS");
    expect((await library()).sources[0]).toMatchObject({ inspections: [], failures: [{ code: "HTTP_STATUS" }] });
    const inspectionId = (await call(owner, "POST", `/api/admin/research/sources/${sourceId}/inspect`, {})).json().inspectionId;
    const digest = (await library()).sources[0].inspections[0].contentDigest;
    const first = (await call(owner, "POST", `/api/admin/research/inspections/${inspectionId}/review`, approval(digest))).json().reviewId;
    const attached = await call(owner, "POST", `/api/admin/research/reviews/${first}/attachments`, { episodeId: "max", expiresAt: days(1), idempotencyKey: key() });
    expect(attached.statusCode, attached.body).toBe(200);
    const enrollment = (await call(learner, "POST", "/api/enrollments", { releaseId: release })).json().id;
    expect((await resources("max", learner, enrollment)).resources).toHaveLength(1);
    await db.query("UPDATE research_attachments SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [attached.json().attachmentId]);
    expect((await resources("max", learner, enrollment)).resources).toEqual([]);
    expect((await library()).attachments[0].state).toBe("expired");
    // A later rejection supersedes the earlier approval for new attachments.
    const rejected = await call(owner, "POST", `/api/admin/research/inspections/${inspectionId}/review`, {
      ...approval(digest),
      decision: "rejected",
      rationale: "A newer reading shows the page omits the empty-list case entirely.",
    });
    expect(rejected.statusCode, rejected.body).toBe(200);
    expect((await call(owner, "POST", `/api/admin/research/reviews/${first}/attachments`, { episodeId: "max", expiresAt: days(1), idempotencyKey: key() })).json().error).toBe("RESEARCH_REVIEW_SUPERSEDED");
    expect((await call(owner, "POST", `/api/admin/research/reviews/${rejected.json().reviewId}/attachments`, { episodeId: "max", expiresAt: days(1), idempotencyKey: key() })).json().error).toBe("RESEARCH_REVIEW_NOT_APPROVED");
    // An expired source approval can no longer be inspected.
    await db.query("UPDATE research_sources SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [sourceId]);
    expect((await call(owner, "POST", `/api/admin/research/sources/${sourceId}/inspect`, {})).json().error).toBe("RESEARCH_SOURCE_EXPIRED");
  });

  it("requires a written alternative before approving an embeddable video and scopes staff by workspace", async () => {
    const bare = (await addSource({ topicId: "maximum-research", kind: "youtube", url: "https://youtu.be/dQw4w9WgXcQ" })).json().sourceId;
    const bareInspection = (await call(owner, "POST", `/api/admin/research/sources/${bare}/inspect`, {})).json().inspectionId;
    const bareDigest = (await library()).sources[0].inspections[0].contentDigest;
    const embed = { rights: { use: "embed", basis: "provider_embed", reference: "YouTube embedded player terms" } };
    expect((await call(owner, "POST", `/api/admin/research/inspections/${bareInspection}/review`, { ...approval(bareDigest), ...embed, evidence: [] })).json().error).toBe("RESEARCH_REVIEW_EVIDENCE_REQUIRED");

    const fallback = "The video walks through keeping the larger value after each comparison, then checks the final value against every element.";
    const added = await addSource({ topicId: "maximum-research", kind: "youtube", url: "https://www.youtube.com/watch?v=aqz-KE-bpKQ", fallbackText: fallback });
    expect(added.statusCode, added.body).toBe(200);
    expect(added.json().url).toBe("https://www.youtube.com/watch?v=aqz-KE-bpKQ");
    const inspectionId = (await call(owner, "POST", `/api/admin/research/sources/${added.json().sourceId}/inspect`, {})).json().inspectionId;
    const view = (await library()).sources.find((s: { id: string }) => s.id === added.json().sourceId);
    expect(inspected.at(-1)!.policy.allowedHosts).toEqual(["www.youtube.com"]);
    const reviewed = await call(owner, "POST", `/api/admin/research/inspections/${inspectionId}/review`, {
      ...approval(view.inspections[0].contentDigest),
      ...embed,
      evidence: [{ quote: "keeping the larger value after each comparison", relevance: "Matches the maximum invariant the episode assesses." }],
    });
    expect(reviewed.statusCode, reviewed.body).toBe(200);
    expect((await call(owner, "POST", `/api/admin/research/reviews/${reviewed.json().reviewId}/attachments`, { episodeId: "max", expiresAt: days(2), idempotencyKey: key() })).statusCode).toBe(200);
    const delivered = (await resources("max")).resources[0];
    expect(delivered.youtube.embed).toMatchObject({ src: "https://www.youtube-nocookie.com/embed/aqz-KE-bpKQ?playsinline=1&rel=0", requiresUserActivation: true });
    expect(delivered.youtube.fallback.text).toBe(fallback);

    const otherWorkspace = randomUUID();
    await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [otherWorkspace, "other-" + otherWorkspace, "Other"]);
    const foreignOwner = await session("owner", otherWorkspace);
    expect((await call(foreignOwner, "GET", `/api/admin/releases/${release}/research/library`)).statusCode).toBe(403);
    expect((await call(foreignOwner, "POST", `/api/admin/research/sources/${added.json().sourceId}/inspect`, {})).statusCode).toBe(403);
  });
});
