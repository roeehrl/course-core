import { randomUUID,randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createDatabase } from "../../../services/api/src/database.ts";
import { migrate } from "../../../services/api/src/migrations.ts";
import { createServer } from "../../../services/api/src/server.ts";
import { authService, issueLoginCode } from "../../../services/api/src/auth.ts";
import {
  registerAdminRoutes,
  ensureCatalog,
} from "../../../services/api/src/admin-routes.ts";
import { unconfiguredProviders } from "../../../services/api/src/provider-composition.ts";
import { fixture } from "../../../services/api/test/fixture.ts";

const connection = process.env.TEST_DATABASE_URL;
if (!connection)
  throw new Error(
    "TEST_DATABASE_URL is required for real admin browser tests.",
  );
const url = new URL(connection);
if (
  process.env.DATABASE_URL ||
  !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
  !["postgres:", "postgresql:"].includes(url.protocol) ||
  !/^\/(course_core_ci|course_core_test(?:_[a-z0-9_]+)?)$/.test(url.pathname) ||
  url.search ||
  url.hash
)
  throw new Error(
    "Use a disposable loopback TEST_DATABASE_URL without overrides or DATABASE_URL.",
  );
const schema = `admin_browser_${randomUUID().replaceAll("-", "")}`,
  root = createDatabase(connection);
await root.query(`CREATE SCHEMA ${schema}`);
url.searchParams.set("options", `-csearch_path=${schema}`);
const db = createDatabase(url.toString()),
  origin = "http://127.0.0.1:4384",
  providers = unconfiguredProviders();
await migrate(
  db,
  fileURLToPath(new URL("../../../services/api/migrations", import.meta.url)),
);
const directory = fileURLToPath(new URL("../dist", import.meta.url));
const {WorkspaceProviders}=await import("../../../services/api/src/provider-setup.ts");
const {credentialVault}=await import("../../../services/api/src/credential-vault.ts");
const app = await createServer(db, {
  workspaceProviders:new WorkspaceProviders(db,credentialVault(randomBytes(32))),
  origin,
  secureCookies: false,
  adminDirectory: directory,
  providers,
});
if (!app.hasRoute({ method: "GET", url: "/api/admin/session" }))
  throw new Error("Production admin routes are not registered.");
if (!app.hasRoute({ method: "GET", url: "/admin/demo" }))
  app.get("/admin/demo", (_request, reply) =>
    reply.sendFile("index.html", directory),
  );
// Test-only fixture endpoint on loopback, never imported by production code.
app.post("/test/admin-fixture", async () => {
  const workspaceId = randomUUID(),
    adminId = randomUUID(),
    learnerId = randomUUID();
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [
    workspaceId,
    `browser-${workspaceId}`,
    "Browser workspace",
  ]);
  for (const [id, role] of [
    [adminId, "admin"],
    [learnerId, "learner"],
  ] as const) {
    await db.query(
      "INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)",
      [
        id,
        `browser:${id}`,
        role === "admin" ? "Browser administrator" : "Public learner",
      ],
    );
    await db.query(
      "INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)",
      [workspaceId, id, role],
    );
  }
  async function login(userId: string) {
    const response = await app.inject({
      method: "POST",
      url: "/auth/redeem",
      headers: { origin },
      payload: { token: await issueLoginCode(db, userId) },
    });
    if (response.statusCode !== 200) throw new Error("Fixture sign-in failed");
    return {
      cookie: response.cookies.map((c) => `${c.name}=${c.value}`).join("; "),
      origin,
      "x-csrf-token": response.json().csrfToken,
    };
  }
  const adminHeaders = await login(adminId);
  const imported = await app.inject({
    method: "POST",
    url: `/api/workspaces/${workspaceId}/releases`,
    headers: adminHeaders,
    payload: fixture(),
  });
  if (imported.statusCode !== 200) throw new Error("Fixture import failed");
  const releaseId = imported.json().id as string;
  const published = await app.inject({
    method: "POST",
    url: `/api/releases/${releaseId}/publish`,
    headers: adminHeaders,
  });
  if (published.statusCode !== 200)
    throw new Error("Fixture publication failed");
  const catalogId = await ensureCatalog(db, releaseId);
  const current = await app.inject({
    url: `/api/admin/courses/${catalogId}`,
    headers: adminHeaders,
  });
  const enrollment = await app.inject({
    method: "POST",
    url: `/api/admin/courses/${catalogId}/enrollments`,
    headers: {
      ...adminHeaders,
      "if-match": current.json().revision,
      "idempotency-key": randomUUID(),
    },
    payload: {
      learnerRef: learnerId,
      releaseId,
      profile: {
        displayName: "Public learner",
        goal: "Understand comparisons.",
        pace: "steady",
      },
    },
  });
  if (enrollment.statusCode !== 200)
    throw new Error(`Fixture enrollment failed: ${enrollment.json().error}`);
  const enrollmentId = enrollment.json().workspace.enrollments[0].id as string;
  const learnerHeaders = await login(learnerId);
  const challenge = await app.inject({
    method: "POST",
    url: `/api/enrollments/${enrollmentId}/challenges`,
    headers: learnerHeaders,
    payload: {
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
      episodeId: "min",
      assessmentId: "min-a",
      mode: "independent",
    },
  });
  if (challenge.statusCode !== 200) throw new Error("Fixture challenge failed");
  const answer = await app.inject({
    method: "POST",
    url: `/api/enrollments/${enrollmentId}/answers`,
    headers: learnerHeaders,
    payload: {
      expectedRevision: challenge.json().revision,
      idempotencyKey: randomUUID(),
      challengeId: challenge.json().challengeId,
      answer: "five",
    },
  });
  if (answer.statusCode !== 200) throw new Error("Fixture answer failed");
  return {
    code: await issueLoginCode(db, adminId),
    catalogId,
    enrollmentId,
    learnerId,
  };
});
app.addHook("onClose", async () => {
  await db.end();
  await root.query(`DROP SCHEMA ${schema} CASCADE`);
  await root.end();
});
await app.listen({ host: "127.0.0.1", port: 4384 });
process.on("SIGINT", () => {
  void app.close();
});
process.on("SIGTERM", () => {
  void app.close();
});
