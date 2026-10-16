import { randomBytes, randomUUID, createHash } from "node:crypto";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { validateResearchResult } from "@course-core/sdk";
import type { ProviderAdapter, UsageReceipt } from "@course-core/providers";
import type { ProviderRequest } from "@course-core/supervisor";
import { createDatabase, transaction, type Database } from "../src/database.js";
import { createTestDatabase, type TestDatabase } from "./test-database.js";
import { createServer } from "../src/server.js";
import { issueLoginCode, type Actor } from "../src/auth.js";
import { appendEvent } from "../src/events.js";
import {
  configureSupervisorBudget,
  createPostgresSupervisorBridge,
  resolveSupervisorOperation,
  type PostgresSupervisorBridge,
} from "../src/supervisor-bridge.js";
import { teachingContext } from "../src/provider-context.js";
import { supervisorTools } from "../src/supervisor-tools.js";
import { composeProviders } from "../src/provider-composition.js";
import { WorkspaceProviders, defaultJobPolicy } from "../src/provider-setup.js";
import { credentialVault } from "../src/key-vault.js";
import { workspaceYouTubeSearch, YOUTUBE_SEARCH_CREDENTIAL } from "../src/research-media.js";
import { supervisorSupportFixture } from "./supervisor-support-fixture.js";
import { syntheticResearchInspector } from "./research-fixture.js";
import { allowUnpricedPaidWork } from "./cost-fixture.js";

const schema = "research_media_" + randomUUID().replaceAll("-", ""),
  workspace = randomUUID(),
  origin = "http://localhost:4391",
  token = randomUUID(),
  fixture = supervisorSupportFixture();
const course = fixture.course as typeof fixture.course & { researchTasks?: unknown[] };
course.research = {
  publicTopics: [
    { id: "min-video", objectiveIds: ["minimum"], queryText: "Public walkthrough of finding the minimum of a list" },
    { id: "min-page", objectiveIds: ["minimum"], queryText: "Public explanation of finding a minimum", allowedDomains: ["docs.python.org"] },
    { id: "max-video", objectiveIds: ["maximum"], queryText: "Public walkthrough of finding the maximum of a list" },
  ],
};
course.researchTasks = [
  {
    id: "min-task", objectiveIds: ["minimum"], publicTopicIds: ["min-video"], modalities: ["video", "article"], languages: ["en"],
    requiredOrOptional: "optional", sourcePolicy: { requireReviewedContent: true, maxCandidates: 3, maxToolCalls: 5, deadlineSeconds: 600 },
  },
];
// Synthetic test-only key material, assembled from pieces; never a real credential.
const youtubeKey = ["synthetic", "youtube", "key", randomUUID().slice(0, 8)].join("-");
const ids = ["aB_cD-eF123", "zZ9_yY8-xX7", "mM5_nN6-oO7"];
const youtubeCalls: { url: URL; headers: Record<string, string> }[] = [];
const keys = new Map<string, string>();
async function youtubeFetch(input: string | URL | Request, init?: RequestInit) {
  const url = new URL(String(input));
  youtubeCalls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
  if (url.pathname.endsWith("/search"))
    return Response.json({ items: ids.map((videoId, i) => ({ id: { kind: "youtube#video", videoId }, snippet: { title: "Minimum walkthrough " + (i + 1), channelTitle: "Public channel " + (i + 1) } })) });
  return Response.json({ items: [
    { id: ids[0], contentDetails: { duration: "PT4M13S", caption: "true" }, status: { embeddable: true } },
    { id: ids[1], contentDetails: { duration: "PT10M", caption: "false" }, status: { embeddable: true } },
    { id: ids[2], contentDetails: { duration: "PT2M" }, status: { embeddable: false } },
  ] });
}
const researchCalls: any[] = [];
const usage: UsageReceipt = {
  accounting: { accountingKey: "synthetic" }, providerId: "test", modelId: "planner", operation: "assess",
  attempts: [{ attempt: 1, status: 200, outcome: "response", tokens: { input: 10, output: 20, total: 30, cachedInput: 0, thoughts: 0, toolInput: 0 } }],
  inputCharacters: 100, requestedMaxOutputTokens: 1000, requestedVideoSeconds: null, observedImageCount: null, observedVideoCount: null, cost: null,
};
const modelScripts = new Map<string, (round: number, prompt: any) => any>();
const adapter: ProviderAdapter = {
  providerId: "test",
  validateModel() {},
  ports: {
    research: {
      async research(request) {
        researchCalls.push(structuredClone(request));
        const text = "A minimum is no greater than other members.";
        return {
          usage: { ...usage, operation: "research" as const, accounting: request.accounting },
          output: { text, grounding: "grounded" as const, parts: [{ partIndex: 0, text }],
            sources: [{ uri: "https://docs.python.org/3/library/functions.html#min", title: "Public ordering source" }],
            citations: [{ partIndex: 0, startByte: 0, endByte: 9, sourceIndices: [0] }], searchQueries: ["public ordering"], searchSuggestionsHtml: null },
        };
      },
    },
    structured_assessment: {
      async assess(req) {
        const round = Number(req.accounting.accountingKey.split(":round-")[1]);
        const scripted = modelScripts.get(req.accounting.accountingKey.split(":round-")[0]!);
        if (!scripted) throw new Error("unscripted supervisor call");
        return { usage, output: scripted(round, JSON.parse(req.messages[0]!.text)) };
      },
    },
  },
};
const jobPolicy = { allowance: { microUsd: 100000, tokens: 1200000 } };
let db: Database, app: Awaited<ReturnType<typeof createServer>>, bridge: PostgresSupervisorBridge, releaseId: string;
let owner: Session, author: Session;
interface Session { id: string; cookie: string; csrf: string }
const headers = (s: Session) => ({ cookie: s.cookie, origin, "x-csrf-token": s.csrf });
const call = (who: Session, method: "GET" | "POST", url: string, payload?: unknown) =>
  app.inject({ method, url, headers: headers(who), ...(payload === undefined ? {} : { payload: payload as object }) });
const days = (n: number) => new Date(Date.now() + n * 86400_000).toISOString();
async function login(role = "learner"): Promise<Session> {
  const id = randomUUID();
  await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [id, "test:" + id, "Media test user"]);
  await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspace, id, role]);
  const r = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, id) } });
  expect(r.statusCode, r.body).toBe(200);
  return { id, cookie: r.cookies.map((c) => `${c.name}=${c.value}`).join("; "), csrf: r.json().csrfToken };
}
let testDatabase: TestDatabase | undefined;
beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  const providers = composeProviders({
    registry: { revision: "media-test", models: [{ id: "planner", providerId: "test", remoteModel: "planner", providerConfig: {}, enabled: true,
      capabilities: ["structured_assessment", "research"], tools: ["web_search"], limits: { maxInputCharacters: 40000, maxOutputTokens: 2000 } }] },
    adapters: [{ id: "test", kind: "test", credentialEnv: "COURSE_PROVIDER_TEST_API_KEY" }],
    roles: {
      research: { modelId: "planner", maxInputCharacters: 12000, maxOutputTokens: 1000 },
      supervisor: { modelId: "planner", maxInputCharacters: 30000, maxOutputTokens: 1000, maxToolRounds: 8 },
    },
  }, () => "synthetic", { test: () => adapter });
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false, adaptation: fixture.runtime, providers,
    researchInspector: syntheticResearchInspector(),
    youtubeSearch: workspaceYouTubeSearch(async (ws, name) => keys.get(ws + ":" + name), youtubeFetch),
    supervisor: { serviceToken: token, workspaceIds: [workspace], jobPolicy } });
  bridge = createPostgresSupervisorBridge(db, { workspaceIds: [workspace], jobPolicy });
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspace, "media-" + workspace, "Public media qualification"]);
  await allowUnpricedPaidWork(db, workspace);
  owner = await login("owner");
  author = await login("author");
  const imported = await call(owner, "POST", `/api/workspaces/${workspace}/releases`, course);
  expect(imported.statusCode, imported.body).toBe(200);
  releaseId = imported.json().id;
  expect((await call(owner, "POST", `/api/releases/${releaseId}/publish`)).statusCode).toBe(200);
  await configureSupervisorBudget(db, { workspaceId: workspace }, { microUsd: 10000000, tokens: 100000000 });
}, 30000);
afterAll(async () => {
  await app?.close();
  await db?.end();
  await testDatabase?.drop();
});

const search = (who: Session, topicId = "min-video", body: unknown = { maxResults: 3 }) =>
  call(who, "POST", `/api/admin/releases/${releaseId}/research/topics/${topicId}/youtube-search`, body);
/** Adds, inspects, reviews and attaches one source through the staff HTTP routes. */
async function reviewedAttachment(options: { url: string; kind?: "web" | "youtube"; topicId?: string; fallbackText?: string; searchId?: string;
  segment?: { startSeconds: number; endSeconds: number }; quote?: string; episodeId?: string }) {
  const kind = options.kind ?? "youtube";
  const added = await call(author, "POST", `/api/admin/releases/${releaseId}/research/sources`, {
    topicId: options.topicId ?? "min-video", kind, url: options.url, expiresAt: days(30), idempotencyKey: "k-" + randomUUID(),
    ...(options.fallbackText ? { fallbackText: options.fallbackText } : {}), ...(options.searchId ? { searchId: options.searchId } : {}),
  });
  expect(added.statusCode, added.body).toBe(200);
  const inspected = await call(author, "POST", `/api/admin/research/sources/${added.json().sourceId}/inspect`);
  expect(inspected.statusCode, inspected.body).toBe(200);
  const library = (await call(owner, "GET", `/api/admin/releases/${releaseId}/research/library`)).json();
  const inspection = library.sources.find((s: any) => s.id === added.json().sourceId).inspections[0];
  const review = (extra: Record<string, unknown> = {}) => call(owner, "POST", `/api/admin/research/inspections/${inspection.id}/review`, {
    decision: "approved", contentDigest: inspection.contentDigest,
    rationale: "Walks through the running-minimum comparison loop step by step.",
    evidence: options.quote ? [{ quote: options.quote, relevance: "States the invariant learners explain in the episode." }] : [],
    suitability: { topicRelevant: true, accurateEnoughForUse: true, safeForAudience: true },
    rights: kind === "youtube" ? { use: "embed", basis: "provider_embed", reference: "YouTube embed with attribution." }
      : { use: "link_only", basis: "link_only", reference: "Linked with attribution only; no copy." },
    acknowledgesTruncation: false, idempotencyKey: "k-" + randomUUID(),
    ...(options.segment ? { segment: options.segment } : {}), ...extra,
  });
  const reviewed = await review();
  expect(reviewed.statusCode, reviewed.body).toBe(200);
  const attached = await call(owner, "POST", `/api/admin/research/reviews/${reviewed.json().reviewId}/attachments`,
    { episodeId: options.episodeId ?? "min", expiresAt: days(20), idempotencyKey: "k-" + randomUUID() });
  expect(attached.statusCode, attached.body).toBe(200);
  return { sourceId: added.json().sourceId as string, inspection, reviewId: reviewed.json().reviewId as string, attachmentId: attached.json().attachmentId as string, review };
}
const fallback = "Watch how the running minimum keeps the smaller value at every comparison step of the loop.";

describe("YouTube Data API search and reviewed segments", () => {
  it("keeps keys in the admin provider vault: stored sealed, readable only server-side, never projected", async () => {
    const vault = credentialVault(randomBytes(32)), providers = new WorkspaceProviders(db, vault);
    const ws = randomUUID(), admin = randomUUID();
    await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [ws, "vault-" + ws, "Vault"]);
    await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [admin, "test:" + admin, "Admin"]);
    await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'admin')", [ws, admin]);
    const actor = { id: admin } as Actor;
    expect(await providers.credential(ws, YOUTUBE_SEARCH_CREDENTIAL)).toBeUndefined();
    expect(await workspaceYouTubeSearch((w, n) => providers.credential(w, n), youtubeFetch).forWorkspace(ws)).toBeUndefined();
    await providers.save(actor, ws, {
      expectedRevision: 0, idempotencyKey: "setup-" + randomUUID(),
      configuration: { registry: { revision: "none", models: [] }, adapters: [], roles: {} },
      jobPolicy: defaultJobPolicy, credentials: { [YOUTUBE_SEARCH_CREDENTIAL]: youtubeKey },
    });
    expect(await providers.credential(ws, YOUTUBE_SEARCH_CREDENTIAL)).toBe(youtubeKey);
    const projected = await providers.read(actor, ws);
    expect(JSON.stringify(projected)).not.toContain(youtubeKey);
    expect(projected.credentials).toEqual([{ name: YOUTUBE_SEARCH_CREDENTIAL, configured: true }]);
    const stored = (await db.query("SELECT sealed_credentials FROM workspace_provider_versions WHERE workspace_id=$1", [ws])).rows[0];
    expect(JSON.stringify(stored)).not.toContain(youtubeKey);
    expect(await workspaceYouTubeSearch((w, n) => providers.credential(w, n), youtubeFetch).forWorkspace(ws)).toBeDefined();
  });

  it("searches with only the approved topic query, stores metadata-only leads and reviewed segments, and delivers the segment", async () => {
    youtubeCalls.length = 0;
    const learner = await login();
    const unconfigured = await search(owner);
    expect(unconfigured.statusCode).toBe(409);
    expect(unconfigured.json().error).toBe("YOUTUBE_SEARCH_NOT_CONFIGURED");
    keys.set(workspace + ":" + YOUTUBE_SEARCH_CREDENTIAL, youtubeKey);
    expect((await search(learner)).statusCode).toBe(403);
    expect((await search(owner, "unapproved-topic")).statusCode).toBe(409);
    // A browser cannot add a query, a learner field or a URL: the body is a result count only.
    expect((await search(owner, "min-video", { queryText: "PRIVATE_LEARNER_CANARY" })).statusCode).toBe(400);
    expect((await search(owner, "min-video", { maxResults: 50 })).statusCode).toBe(400);
    expect(youtubeCalls).toHaveLength(0);

    const found = await search(owner);
    expect(found.statusCode, found.body).toBe(200);
    expect(youtubeCalls).toHaveLength(2);
    const [searchCall, detailCall] = youtubeCalls;
    expect(searchCall!.url.searchParams.get("q")).toBe("Public walkthrough of finding the minimum of a list");
    expect(searchCall!.url.searchParams.get("relevanceLanguage")).toBe("en");
    expect(searchCall!.url.searchParams.get("maxResults")).toBe("3");
    expect(detailCall!.url.searchParams.get("id")).toBe(ids.join(","));
    for (const c of youtubeCalls) {
      expect(c.url.href).not.toContain(youtubeKey);
      expect(c.headers["x-goog-api-key"]).toBe(youtubeKey);
      expect([...c.url.searchParams.keys()].sort()).toEqual(c === searchCall
        ? ["maxResults", "part", "q", "relevanceLanguage", "safeSearch", "type", "videoEmbeddable"] : ["id", "maxResults", "part"]);
    }
    expect(found.body).not.toContain(youtubeKey);
    const result = found.json().search;
    expect(result.reviewStatus).toBe("unreviewed");
    expect(result.hits.map((h: any) => h.videoId)).toEqual(ids);
    // F09: metadata is never review: no claims, no segment, unreviewed.
    for (const hit of result.hits)
      for (const candidate of hit.candidates) {
        expect(candidate).toMatchObject({ claims: [], verifiedSegmentIfAny: null, reviewStatus: "unreviewed", inspectedEvidence: { kind: "metadata_only" } });
        expect(candidate.objectiveFit.objective).toBe("minimum");
      }
    expect(result.hits[2].candidates[0].rightsAndEmbeddingStatus).toBe("not_permitted");
    const events = (await db.query("SELECT payload FROM learning_events WHERE workspace_id=$1 AND event_type='research.youtube.searched'", [workspace])).rows;
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain(youtubeKey);
    const stored = (await db.query("SELECT * FROM research_searches WHERE id=$1", [result.id])).rows[0];
    expect(JSON.stringify(stored)).not.toContain(youtubeKey);
    const library = (await call(owner, "GET", `/api/admin/releases/${releaseId}/research/library`)).json();
    expect(library.searches[0].id).toBe(result.id);

    // A source can claim a search only for a video that search actually returned.
    const mismatch = await call(author, "POST", `/api/admin/releases/${releaseId}/research/sources`, {
      topicId: "min-video", kind: "youtube", url: "https://www.youtube.com/watch?v=qQ1_wW2-eE3", searchId: result.id, expiresAt: days(30), idempotencyKey: "k-" + randomUUID() });
    expect(mismatch.json().error).toBe("RESEARCH_SEARCH_MISMATCH");
    const otherTopic = await call(author, "POST", `/api/admin/releases/${releaseId}/research/sources`, {
      topicId: "max-video", kind: "youtube", url: `https://youtu.be/${ids[0]}`, searchId: result.id, expiresAt: days(30), idempotencyKey: "k-" + randomUUID() });
    expect(otherTopic.json().error).toBe("RESEARCH_SEARCH_MISMATCH");

    const added = await call(author, "POST", `/api/admin/releases/${releaseId}/research/sources`, {
      topicId: "min-video", kind: "youtube", url: `https://youtu.be/${ids[0]}`, searchId: result.id, fallbackText: fallback, expiresAt: days(30), idempotencyKey: "k-" + randomUUID() });
    expect(added.statusCode, added.body).toBe(200);
    expect((await call(author, "POST", `/api/admin/research/sources/${added.json().sourceId}/inspect`)).statusCode).toBe(200);
    const lib = (await call(owner, "GET", `/api/admin/releases/${releaseId}/research/library`)).json();
    const source = lib.sources.find((s: any) => s.id === added.json().sourceId);
    expect(source).toMatchObject({ searchId: result.id, durationSeconds: 253, captions: "creator_captions", embeddable: true });
    const inspection = source.inspections[0];
    const review = (segment: unknown) => call(owner, "POST", `/api/admin/research/inspections/${inspection.id}/review`, {
      decision: "approved", contentDigest: inspection.contentDigest, rationale: "Walks through the running-minimum comparison loop step by step.",
      evidence: [{ quote: "keeps the smaller value at every comparison step", relevance: "States the invariant learners explain in the episode." }],
      suitability: { topicRelevant: true, accurateEnoughForUse: true, safeForAudience: true },
      rights: { use: "embed", basis: "provider_embed", reference: "YouTube embed with attribution." }, acknowledgesTruncation: false,
      idempotencyKey: "k-" + randomUUID(), segment });
    expect((await review({ startSeconds: 30, endSeconds: 300 })).json().error).toBe("RESEARCH_SEGMENT_OUT_OF_RANGE");
    expect((await review({ startSeconds: 90, endSeconds: 30 })).statusCode).toBe(400);
    expect((await review({ startSeconds: -1, endSeconds: 30 })).statusCode).toBe(400);
    const reviewed = await review({ startSeconds: 30, endSeconds: 200 });
    expect(reviewed.statusCode, reviewed.body).toBe(200);
    expect(reviewed.json().segment).toEqual({ startSeconds: 30, endSeconds: 200 });
    // A web page has no segment.
    const page = await reviewedAttachment({ url: "https://docs.python.org/3/library/functions.html", kind: "web", topicId: "min-page",
      quote: "Each comparison keeps the smaller value" });
    const pageSegment = await page.review({ segment: { startSeconds: 0, endSeconds: 10 } });
    expect(pageSegment.json().error).toBe("RESEARCH_SEGMENT_NOT_APPLICABLE");

    const attached = await call(owner, "POST", `/api/admin/research/reviews/${reviewed.json().reviewId}/attachments`,
      { episodeId: "min", expiresAt: days(20), idempotencyKey: "k-" + randomUUID() });
    expect(attached.statusCode, attached.body).toBe(200);
    const enrollment = (await call(learner, "POST", "/api/enrollments", { releaseId })).json().id;
    const delivered = await call(learner, "GET", `/api/enrollments/${enrollment}/resources?episodeId=min`);
    expect(delivered.statusCode, delivered.body).toBe(200);
    const video = delivered.json().resources.find((r: any) => r.youtube?.videoId === ids[0]);
    expect(video.youtube.segment).toEqual({ startSeconds: 30, endSeconds: 200 });
    expect(video.youtube.durationSeconds).toBe(253);
    expect(video.suggestedFor).toEqual([]);
    expect(delivered.body).not.toContain(youtubeKey);
    // Provider failures map to stable codes without upstream detail.
    keys.set(workspace + ":" + YOUTUBE_SEARCH_CREDENTIAL, "short");
    const refused = await search(owner);
    expect(refused.json().error).toBe("YOUTUBE_SEARCH_UNAUTHORIZED");
    keys.set(workspace + ":" + YOUTUBE_SEARCH_CREDENTIAL, youtubeKey);
  });
});

// ------------------------------------------------------------------ supervisor jobs

async function prepare(consent = true) {
  const learner = await login(),
    enrolled = await call(learner, "POST", "/api/enrollments", { releaseId });
  expect(enrolled.statusCode, enrolled.body).toBe(200);
  const id = enrolled.json().id;
  const snapshot = async () => (await call(learner, "GET", `/api/enrollments/${id}`)).json();
  const setting = await call(learner, "POST", `/api/enrollments/${id}/supervision`,
    { expectedRevision: (await snapshot()).revision, idempotencyKey: randomUUID(), adaptiveTeaching: consent });
  expect(setting.statusCode, setting.body).toBe(200);
  await configureSupervisorBudget(db, { workspaceId: workspace, enrollmentId: id }, { microUsd: 1000000, tokens: 2000000 });
  return { learner, id, snapshot, ...(await job(learner, id)) };
}
/** A fresh supervisor job for an enrollment, claimed and ready to invoke. */
async function job(learner: Session, id: string) {
  const event = await transaction(db, (client) => appendEvent(client, { workspaceId: workspace, enrollmentId: id, actorId: learner.id, actorKind: "learner",
    type: "learning.review_requested", payload: { episodeId: "min" }, idempotencyKey: randomUUID(), supervise: true }));
  const outbox = (await bridge.claimOutboxEvent(event.id, randomUUID(), 30000))!;
  const [ref] = await bridge.prepareOutbox(outbox);
  await bridge.ackOutbox(outbox);
  const claim = await bridge.transition({ type: "claim", ref: ref!, checkpointId: "generate", ownerId: randomUUID(), availability: { status: "ready" } });
  expect(claim.effect).toBe("invoke");
  const operation = claim.snapshot.operations[0]!;
  const request: ProviderRequest = { schemaVersion: 1, operationId: operation.id, job: claim.snapshot.specification.key, role: "supervisor",
    checkpoint: claim.snapshot.specification.checkpoints[0]!, fence: claim.snapshot.specification.fence };
  return { ref: ref!, request, operation };
}
type Job = { ref: Awaited<ReturnType<typeof job>>["ref"]; request: ProviderRequest; operation: Awaited<ReturnType<typeof job>>["operation"] };
function script(j: Job, steps: { tool: string; args?: (prompt: any) => unknown }[], summary = "Suggest one reviewed resource.") {
  modelScripts.set(createHash("sha256").update(j.request.operationId).digest("hex"), (round, prompt) => round < steps.length
    ? { decision: "tool", tool: steps[round]!.tool, argumentsJson: JSON.stringify(steps[round]!.args?.(prompt) ?? {}), summary: "" }
    : { decision: "finish", tool: "none", argumentsJson: "{}", summary });
}
async function invoke(j: Job) {
  const r = await app.inject({ method: "POST", url: "/v1/operations", headers: { authorization: "Bearer " + token, "idempotency-key": j.request.operationId }, payload: j.request });
  expect(r.statusCode, r.body).toBe(200);
  expect(r.json().status).toBe("succeeded");
  await bridge.transition({ type: "settle", ref: j.ref, operationId: j.operation.id, ownerId: j.operation.ownerId, outcome: r.json() });
  return r.json();
}
const transition = (command: unknown) => app.inject({ method: "POST", url: "/v1/supervisor/bridge", headers: { authorization: "Bearer " + token }, payload: { method: "transition", command } });
async function scopedTools(j: Job) {
  const resolved = await resolveSupervisorOperation(db, j.request);
  return supervisorTools(db, j.request, await teachingContext(db, resolved.ref, resolved.input.context));
}
const resources = async (who: Session, id: string, episodeId = "min") => {
  const r = await call(who, "GET", `/api/enrollments/${id}/resources?episodeId=${episodeId}`);
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
};

describe("supervisor choice of one reviewed resource per objective", () => {
  let video: Awaited<ReturnType<typeof reviewedAttachment>>, second: Awaited<ReturnType<typeof reviewedAttachment>>,
    blocked: Awaited<ReturnType<typeof reviewedAttachment>>;
  beforeAll(async () => {
    video = await reviewedAttachment({ url: `https://www.youtube.com/watch?v=${ids[1]}`, fallbackText: fallback, quote: "keeps the smaller value at every comparison step",
      segment: { startSeconds: 15, endSeconds: 120 } });
    second = await reviewedAttachment({ url: "https://docs.python.org/3/tutorial/datastructures.html", kind: "web", topicId: "min-page",
      quote: "Each comparison keeps the smaller value" });
    // A video the search reported as not embeddable stays visible but cannot be chosen for embedding.
    keys.set(workspace + ":" + YOUTUBE_SEARCH_CREDENTIAL, youtubeKey);
    const found = (await search(owner)).json().search;
    blocked = await reviewedAttachment({ url: `https://www.youtube.com/watch?v=${ids[2]}`, searchId: found.id, fallbackText: fallback,
      quote: "keeps the smaller value at every comparison step" });
  }, 60000);

  it("never approves metadata-only content (F09)", async () => {
    const added = await call(author, "POST", `/api/admin/releases/${releaseId}/research/sources`, {
      topicId: "max-video", kind: "youtube", url: `https://www.youtube.com/watch?v=${ids[0]}`, expiresAt: days(30), idempotencyKey: "k-" + randomUUID() });
    expect(added.statusCode, added.body).toBe(200);
    expect((await call(author, "POST", `/api/admin/research/sources/${added.json().sourceId}/inspect`)).statusCode).toBe(200);
    const library = (await call(owner, "GET", `/api/admin/releases/${releaseId}/research/library`)).json();
    const inspection = library.sources.find((s: any) => s.id === added.json().sourceId).inspections[0];
    expect(inspection.basis).toBe("metadata_only");
    const approved = await call(owner, "POST", `/api/admin/research/inspections/${inspection.id}/review`, {
      decision: "approved", contentDigest: inspection.contentDigest, rationale: "The title sounds relevant to the maximum lesson.", evidence: [],
      suitability: { topicRelevant: true, accurateEnoughForUse: true, safeForAudience: true },
      rights: { use: "embed", basis: "provider_embed", reference: "YouTube embed with attribution." }, acknowledgesTruncation: false,
      idempotencyKey: "k-" + randomUUID(), segment: { startSeconds: 0, endSeconds: 60 } });
    expect(approved.json().error).toBe("RESEARCH_REVIEW_EVIDENCE_REQUIRED");
  });

  it("lists MediaCandidates, refuses metadata-only and unobserved choices, and applies a verified choice to the learner's lesson", async () => {
    const j = await prepare(), tools = await scopedTools(j);
    await expect(tools.invoke("choose_resource", { attachmentId: video.attachmentId, objectiveId: "minimum" }, 0))
      .rejects.toMatchObject({ code: "RESOURCE_NOT_OBSERVED" });
    const listed = (await tools.invoke("list_reviewed_resources", {}, 0)).result as any;
    expect(listed.available).toBe(true);
    const byAttachment = (id: string) => listed.resources.find((r: any) => r.attachmentId === id);
    const v = byAttachment(video.attachmentId), b = byAttachment(blocked.attachmentId);
    expect(v).toMatchObject({ objectiveId: "minimum", choosable: true, candidate: {
      inspectedEvidence: { kind: "viewed_segment" }, verifiedSegmentIfAny: { startSeconds: 15, endSeconds: 120 }, duration: null,
      claims: [{ text: "keeps the smaller value at every comparison step" }], rightsAndEmbeddingStatus: "embeddable", reviewStatus: "reviewed",
      objectiveFit: { objective: "minimum", fit: "direct" } } });
    expect(v.candidate.concerns).toContain("Duration is unknown.");
    expect(b).toMatchObject({ choosable: false, reason: "embedding_not_permitted", candidate: { rightsAndEmbeddingStatus: "not_permitted",
      duration: { seconds: 120 }, captionsOrTranscriptStatus: "unknown", reviewStatus: "reviewed", verifiedSegmentIfAny: null } });
    expect(b.candidate.concerns).toContain("Captions were not confirmed.");
    expect(byAttachment(second.attachmentId).candidate.inspectedEvidence.kind).toBe("full_text");
    // Every candidate is a valid SDK MediaCandidate.
    for (const r of listed.resources)
      expect(validateResearchResult({ requestId: r.candidate.requestId, objective: r.objectiveId, sourcePolicy: {} } as any, r.candidate).valid).toBe(true);
    expect((await tools.invoke("choose_resource", { attachmentId: blocked.attachmentId, objectiveId: "minimum" }, 1)).result)
      .toEqual({ selected: false, reason: "embedding_not_permitted" });
    await expect(tools.invoke("choose_resource", { attachmentId: video.attachmentId, objectiveId: "minimum", url: "https://evil.example" }, 2))
      .rejects.toMatchObject({ code: "SUPERVISOR_TOOL_ARGUMENTS" });
    await expect(tools.invoke("choose_resource", { attachmentId: video.attachmentId, objectiveId: "maximum" }, 2))
      .rejects.toMatchObject({ code: "RESOURCE_NOT_OBSERVED" });

    const planned = await prepare();
    script(planned, [{ tool: "list_reviewed_resources" }, { tool: "choose_resource", args: () => ({ attachmentId: video.attachmentId, objectiveId: "minimum" }) }]);
    const result = await invoke(planned);
    expect(result.status).toBe("succeeded");
    const verified = await transition({ type: "verify", ref: planned.ref });
    expect(verified.json().snapshot.state).toBe("ready");
    const applied = await transition({ type: "apply", ref: planned.ref });
    expect(applied.json().snapshot.state).toBe("applied");
    const replay = await transition({ type: "apply", ref: planned.ref });
    expect(replay.json().snapshot.applicationReceiptId).toBe(applied.json().snapshot.applicationReceiptId);
    const choices = (await db.query("SELECT objective_id,attachment_id,ended_at FROM research_resource_choices WHERE enrollment_id=$1", [planned.id])).rows;
    expect(choices).toEqual([{ objective_id: "minimum", attachment_id: video.attachmentId, ended_at: null }]);
    const delivered = await resources(planned.learner, planned.id);
    expect(delivered.resources[0]).toMatchObject({ id: video.attachmentId, suggestedFor: ["minimum"] });
    expect(delivered.grantsCredit).toBe(false);
    // Another learner of the same release sees the resource without a suggestion.
    const other = await prepare();
    expect((await resources(other.learner, other.id)).resources.find((r: any) => r.id === video.attachmentId).suggestedFor).toEqual([]);
    expect((await db.query("SELECT count(*) FROM evidence WHERE enrollment_id=$1", [planned.id])).rows[0].count).toBe("0");

    // One resource per objective: a later verified choice supersedes the earlier one.
    const next = { learner: planned.learner, id: planned.id, ...(await job(planned.learner, planned.id)) };
    script(next, [{ tool: "list_reviewed_resources" }, { tool: "choose_resource", args: () => ({ attachmentId: second.attachmentId, objectiveId: "minimum" }) }]);
    await invoke(next);
    expect((await transition({ type: "verify", ref: next.ref })).json().snapshot.state).toBe("ready");
    expect((await transition({ type: "apply", ref: next.ref })).json().snapshot.state).toBe("applied");
    const after = (await db.query("SELECT attachment_id,end_reason FROM research_resource_choices WHERE enrollment_id=$1 ORDER BY created_at", [planned.id])).rows;
    expect(after).toEqual([{ attachment_id: video.attachmentId, end_reason: "superseded" }, { attachment_id: second.attachmentId, end_reason: null }]);
    const exported = await call(planned.learner, "GET", `/api/enrollments/${planned.id}/export`);
    expect(exported.statusCode, exported.body).toBe(200);
    expect(exported.body).toContain("suggestedResources");
    const erased = await call(planned.learner, "POST", `/api/enrollments/${planned.id}/erase`,
      { confirmation: `ERASE ${planned.id.slice(0, 8)}`, reason: "Learner asked to erase this course record." });
    expect(erased.statusCode, erased.body).toBe(200);
    expect((await db.query("SELECT end_reason FROM research_resource_choices WHERE enrollment_id=$1 AND ended_at IS NULL", [planned.id])).rows).toEqual([]);
  });

  it("rejects a stale choice after the learner switches lesson (F11), a revoked resource, and missing consent", async () => {
    const noConsent = await prepare(false), tools = await scopedTools(noConsent);
    expect((await tools.invoke("list_reviewed_resources", {}, 0)).result).toEqual({ available: false, reason: "learner_opt_in_required" });

    const moved = await prepare();
    script(moved, [{ tool: "list_reviewed_resources" }, { tool: "choose_resource", args: () => ({ attachmentId: video.attachmentId, objectiveId: "minimum" }) }]);
    await invoke(moved);
    // The learner moves to the next lesson while the plan awaits verification.
    await db.query("UPDATE enrollments SET current_episode_id='max' WHERE id=$1", [moved.id]);
    expect((await transition({ type: "verify", ref: moved.ref })).json().snapshot.state).not.toBe("ready");
    expect((await db.query("SELECT verdict FROM supervisor_verifications WHERE job_id=$1", [moved.ref.jobId])).rows).toEqual([{ verdict: "rejected" }]);
    expect((await db.query("SELECT count(*) FROM research_resource_choices WHERE enrollment_id=$1", [moved.id])).rows[0].count).toBe("0");
    expect((await resources(moved.learner, moved.id, "max")).resources).toEqual([]);

    const revoked = await prepare();
    const extra = await reviewedAttachment({ url: "https://docs.python.org/3/howto/sorting.html", kind: "web", topicId: "min-page",
      quote: "Each comparison keeps the smaller value" });
    script(revoked, [{ tool: "list_reviewed_resources" }, { tool: "choose_resource", args: () => ({ attachmentId: extra.attachmentId, objectiveId: "minimum" }) }]);
    await invoke(revoked);
    const revoke = await call(owner, "POST", `/api/admin/research/attachments/${extra.attachmentId}/revoke`, { reason: "Superseded by a newer page.", idempotencyKey: "k-" + randomUUID() });
    expect(revoke.statusCode, revoke.body).toBe(200);
    expect((await transition({ type: "verify", ref: revoked.ref })).json().snapshot.state).not.toBe("ready");
    expect((await db.query("SELECT count(*) FROM research_resource_choices WHERE enrollment_id=$1", [revoked.id])).rows[0].count).toBe("0");
  });
});

// ------------------------------------------------------------------ structured research requests

const structured = { topicId: "min-video", taskId: "min-task", objectiveId: "minimum", modality: "video", remainingLearningTime: "under_15_min",
  accessibilityNeeds: ["captions"], knownPrerequisites: [] as string[] };
async function stageAndDispatch() {
  const j = await prepare();
  script(j, [{ tool: "list_research_topics" }, { tool: "request_research", args: () => structured }], "Collect public sources for separate review.");
  await invoke(j);
  expect((await transition({ type: "verify", ref: j.ref })).json().snapshot.state).toBe("ready");
  expect((await transition({ type: "apply", ref: j.ref })).json().snapshot.state).toBe("applied");
  const row = (await db.query("SELECT * FROM research_requests WHERE parent_job_id=$1", [j.ref.jobId])).rows[0];
  expect(row.state).toBe("dispatched");
  return { j, row };
}
async function collect(row: { activation_event_id: string }) {
  const envelope = (await bridge.claimOutboxEvent(row.activation_event_id, randomUUID(), 30000))!;
  const [ref] = await bridge.prepareOutbox(envelope);
  await bridge.ackOutbox(envelope);
  const claim = await bridge.transition({ type: "claim", ref: ref!, checkpointId: "generate", ownerId: randomUUID(), availability: { status: "ready" } });
  const op = claim.snapshot.operations[0]!;
  const payload = { schemaVersion: 1, operationId: op.id, job: claim.snapshot.specification.key, role: "research",
    checkpoint: claim.snapshot.specification.checkpoints[0], fence: claim.snapshot.specification.fence };
  const collected = await app.inject({ method: "POST", url: "/v1/operations", headers: { authorization: "Bearer " + token, "idempotency-key": op.id }, payload });
  expect(collected.statusCode, collected.body).toBe(200);
  await bridge.transition({ type: "settle", ref: ref!, operationId: op.id, ownerId: op.ownerId, outcome: collected.json() });
  return { ref: ref!, verified: await transition({ type: "verify", ref: ref! }) };
}

describe("structured research requests, deadlines and cancellation", () => {
  it("builds a learner-free SDK ResearchRequest and refuses widened or undeclared fields before any search", async () => {
    const j = await prepare(), tools = await scopedTools(j), searched = researchCalls.length + youtubeCalls.length;
    await tools.invoke("list_research_topics", {}, 0);
    const refusals: [Record<string, unknown>, string][] = [
      [{ ...structured, objectiveId: "maximum" }, "RESEARCH_SCOPE_MISMATCH"],
      [{ ...structured, taskId: "undeclared-task" }, "UNAPPROVED_RESEARCH_TASK"],
      [{ ...structured, misconceptionHypothesis: "undeclared-hypothesis" }, "UNDECLARED_HYPOTHESIS"],
      [{ ...structured, modality: "interactive" }, "RESEARCH_SCOPE_MISMATCH"],
      [{ ...structured, requiredOrOptional: "required_replacement" }, "RESEARCH_REQUIREMENT_ESCALATED"],
      [{ ...structured, knownPrerequisites: ["maximum"] }, "RESEARCH_SCOPE_MISMATCH"],
      [{ ...structured, topicId: "max-video" }, "RESEARCH_TOPIC_NOT_OBSERVED"],
      [{ ...structured, misconception: "The learner said 10 < 9 in chat" }, "SUPERVISOR_TOOL_ARGUMENTS"],
      [{ ...structured, accessibilityNeeds: ["needs help because of a private condition"] }, "SUPERVISOR_TOOL_ARGUMENTS"],
      [{ topicId: "min-video", modality: "video" }, "SUPERVISOR_TOOL_ARGUMENTS"],
      [{ topicId: "min-video", taskId: "min-task" }, "SUPERVISOR_TOOL_ARGUMENTS"],
    ];
    for (const [args, code] of refusals)
      await expect(tools.invoke("request_research", args, 1), JSON.stringify(args)).rejects.toMatchObject({ code });
    const staged = (await tools.invoke("request_research", structured, 1)).result as any;
    expect(staged).toMatchObject({ staged: true, objectiveId: "minimum", deadlineSeconds: 600, sentToSearch: "approved_public_query_only" });
    const row = (await db.query("SELECT *,extract(epoch FROM deadline_at-created_at)::integer AS window FROM research_requests WHERE id=$1", [staged.requestId])).rows[0];
    expect(row.objective_id).toBe("minimum");
    expect(row.window).toBe(600);
    expect(row.request).toMatchObject({ taskId: "min-task", objective: "minimum", episodeRevision: { episodeId: "min" }, misconceptionHypothesis: null,
      language: "en", modality: "video", remainingLearningTime: "under_15_min", accessibilityNeeds: ["captions"], requiredOrOptional: "optional",
      sourcePolicy: { publicTopicId: "min-video", requireReviewedContent: true, maxCandidates: 3, maxToolCalls: 5, deadlineSeconds: 600 } });
    // A retried identical call reuses the request; changed fields for the same topic are refused.
    expect(((await tools.invoke("request_research", structured, 1)).result as any).requestId).toBe(staged.requestId);
    await expect(tools.invoke("request_research", { ...structured, modality: "article" }, 2)).rejects.toMatchObject({ code: "RESEARCH_SELECTION_CHANGED" });
    // Staging sends nothing anywhere.
    expect(researchCalls.length + youtubeCalls.length).toBe(searched);
  });

  it("sends only the approved query (F10) and keeps a result bound to its original objective after a lesson switch (F11)", async () => {
    const before = researchCalls.length;
    const { j, row } = await stageAndDispatch();
    // The learner switches lesson while research runs.
    await db.query("UPDATE enrollments SET current_episode_id='max' WHERE id=$1", [j.id]);
    const { ref, verified } = await collect(row);
    expect(verified.json().snapshot.state).toBe("ready");
    expect((await transition({ type: "apply", ref })).json().snapshot.state).toBe("applied");
    expect(researchCalls).toHaveLength(before + 1);
    const sent = researchCalls.at(-1);
    expect(sent.messages).toEqual([{ role: "user", text: "Public walkthrough of finding the minimum of a list" }]);
    for (const leaked of ["captions", "under_15_min", "min-task", "min-video", j.id, j.learner.id]) expect(JSON.stringify(sent)).not.toContain(leaked);
    const own = (await call(j.learner, "GET", `/api/enrollments/${j.id}/research`)).json();
    expect(own.requests[0]).toMatchObject({ state: "collected", topicId: "min-video", episodeId: "min", objectiveId: "minimum" });
    // The collected candidate is never injected into the new lesson.
    expect((await resources(j.learner, j.id, "max")).resources).toEqual([]);
  });

  it("a dispatched request that can no longer run ends refused or expired with its reason, never left queued", async () => {
    const prepareOverRpc = async (row: { activation_event_id: string }) => {
      const envelope = (await bridge.claimOutboxEvent(row.activation_event_id, randomUUID(), 30000))!;
      const rpc = (method: string) => app.inject({ method: "POST", url: "/v1/supervisor/bridge", headers: { authorization: "Bearer " + token },
        payload: { method, eventId: envelope.eventId, leaseToken: envelope.leaseToken } });
      const prepared = await rpc("outbox.prepare");
      expect(prepared.statusCode, prepared.body).toBe(200);
      expect(prepared.json()).toEqual({ jobs: [] });
      expect((await rpc("outbox.ack")).json()).toEqual({ accepted: true });
      return (await db.query("SELECT disposition,reason_code FROM supervisor_preparations WHERE event_id=$1", [row.activation_event_id])).rows[0];
    };
    const own = async (j: { learner: Session; id: string }) => (await call(j.learner, "GET", `/api/enrollments/${j.id}/research`)).json().requests[0];

    // Consent withdrawn after dispatch: refused, with the conflict code, everywhere the request is shown.
    const withdrawn = await stageAndDispatch();
    const revoke = await call(withdrawn.j.learner, "POST", `/api/enrollments/${withdrawn.j.id}/supervision`,
      { expectedRevision: (await withdrawn.j.snapshot()).revision, idempotencyKey: randomUUID(), adaptiveTeaching: false });
    expect(revoke.statusCode, revoke.body).toBe(200);
    // Revoking consent does not touch the request itself; only preparation can end it.
    expect((await db.query("SELECT state FROM research_requests WHERE id=$1", [withdrawn.row.id])).rows[0].state).toBe("dispatched");
    expect(await prepareOverRpc(withdrawn.row)).toEqual({ disposition: "refused", reason_code: "SUPERVISION_CONSENT_CHANGED" });
    expect((await db.query("SELECT state,refusal_code,cancel_reason FROM research_requests WHERE id=$1", [withdrawn.row.id])).rows[0])
      .toEqual({ state: "refused", refusal_code: "SUPERVISION_CONSENT_CHANGED", cancel_reason: null });
    expect(await own(withdrawn.j)).toMatchObject({ state: "refused", refusalCode: "SUPERVISION_CONSENT_CHANGED", cancelReason: null });
    const queue = (await call(owner, "GET", `/api/admin/releases/${releaseId}/research`)).json().requests.find((r: { id: string }) => r.id === withdrawn.row.id);
    expect(queue).toMatchObject({ state: "refused", refusalCode: "SUPERVISION_CONSENT_CHANGED" });
    const timeline = (await call(withdrawn.j.learner, "GET", `/api/enrollments/${withdrawn.j.id}/supervision/tools`)).json().calls
      .find((c: { tool: string }) => c.tool === "request_research");
    expect(timeline.outcome.researchState).toBe("refused");
    expect((await db.query("SELECT count(*)::int AS n FROM supervisor_jobs WHERE input_event_id=$1", [withdrawn.row.activation_event_id])).rows[0].n).toBe(0);

    // The deadline passed before the dispatcher reached it: expired (cancelled for the deadline), not refused.
    const late = await stageAndDispatch();
    await db.query("UPDATE research_requests SET deadline_at=clock_timestamp()-interval '1 second' WHERE id=$1", [late.row.id]);
    expect(await prepareOverRpc(late.row)).toEqual({ disposition: "refused", reason_code: "RESEARCH_DEADLINE_PASSED" });
    expect((await db.query("SELECT state,cancel_reason,refusal_code,cancelled_at IS NOT NULL AS ended FROM research_requests WHERE id=$1", [late.row.id])).rows[0])
      .toEqual({ state: "cancelled", cancel_reason: "deadline", refusal_code: null, ended: true });
    expect(await own(late.j)).toMatchObject({ state: "cancelled", cancelReason: "deadline", refusalCode: null });

    // Cancelled by the learner after dispatch: the event is refused, the request keeps its own cancellation.
    const cancelled = await stageAndDispatch();
    expect((await call(cancelled.j.learner, "POST", `/api/enrollments/${cancelled.j.id}/research/${cancelled.row.id}/cancel`)).statusCode).toBe(200);
    expect(await prepareOverRpc(cancelled.row)).toEqual({ disposition: "refused", reason_code: "RESEARCH_REQUEST_NOT_ACTIVATED" });
    expect(await own(cancelled.j)).toMatchObject({ state: "cancelled", cancelReason: "learner", refusalCode: null });

    // A refused request never moves again, and the stored row cannot claim a refusal without its code.
    await expect(db.query("UPDATE research_requests SET state='refused' WHERE id=$1", [late.row.id])).rejects.toThrow();
  });

  it("never collects after the task deadline or after the learner cancels", async () => {
    const late = await stageAndDispatch();
    await db.query("UPDATE research_requests SET deadline_at=clock_timestamp()-interval '1 second' WHERE id=$1", [late.row.id]);
    expect((await call(late.j.learner, "GET", `/api/enrollments/${late.j.id}/research`)).json().requests[0].state).toBe("expired");
    await expect(collect(late.row)).rejects.toBeDefined();
    expect((await db.query("SELECT count(*) FROM research_candidates WHERE request_id=$1", [late.row.id])).rows[0].count).toBe("0");

    const cancelled = await stageAndDispatch();
    const stranger = await login();
    expect((await call(stranger, "POST", `/api/enrollments/${cancelled.j.id}/research/${cancelled.row.id}/cancel`)).statusCode).toBe(404);
    const r = await call(cancelled.j.learner, "POST", `/api/enrollments/${cancelled.j.id}/research/${cancelled.row.id}/cancel`);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({ requestId: cancelled.row.id, state: "cancelled", cancelled: true });
    const again = await call(cancelled.j.learner, "POST", `/api/enrollments/${cancelled.j.id}/research/${cancelled.row.id}/cancel`);
    expect(again.json()).toEqual({ requestId: cancelled.row.id, state: "cancelled", cancelled: true });
    const stored = (await db.query("SELECT state,cancel_reason,cancelled_at FROM research_requests WHERE id=$1", [cancelled.row.id])).rows[0];
    expect(stored).toMatchObject({ state: "cancelled", cancel_reason: "learner" });
    await expect(collect(cancelled.row)).rejects.toBeDefined();
    expect((await db.query("SELECT count(*) FROM research_candidates WHERE request_id=$1", [cancelled.row.id])).rows[0].count).toBe("0");
    expect((await call(cancelled.j.learner, "GET", `/api/enrollments/${cancelled.j.id}/research`)).json().requests[0])
      .toMatchObject({ state: "cancelled", cancelReason: "learner" });
  });
});
