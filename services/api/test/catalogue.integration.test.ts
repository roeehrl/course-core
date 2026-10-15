import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import { compileCourse } from "@course-core/sdk/compiler";
import { createDatabase, type Database } from "../src/database.js";
import { migrate } from "../src/migrations.js";
import { createTestDatabase, type TestDatabase } from "./test-database.js";
import { createServer } from "../src/server.js";
import { issueLoginCode } from "../src/auth.js";
import { fixture } from "./fixture.js";

const origin = "http://localhost:4381",
  schema = "catalogue_" + randomUUID().replaceAll("-", ""),
  directory = fileURLToPath(new URL("../migrations", import.meta.url));
let root: Database,
  db: Database,
  app: Awaited<ReturnType<typeof createServer>>,
  connection: string;
let workspace: string,
  catalog: string,
  old: string,
  owner: Session,
  learner: Session;
interface Session {
  userId: string;
  cookie: string;
  csrf: string;
}
async function session(
  role: string,
  workspaceId = workspace,
): Promise<Session> {
  const id = randomUUID();
  await db.query(
    "INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)",
    [id, "catalogue:" + id, "Catalogue test"],
  );
  await db.query(
    "INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)",
    [workspaceId, id, role],
  );
  const r = await app.inject({
    method: "POST",
    url: "/auth/redeem",
    headers: { origin },
    payload: { token: await issueLoginCode(db, id) },
  });
  expect(r.statusCode).toBe(200);
  return {
    userId: id,
    cookie: r.cookies.map((c) => c.name + "=" + c.value).join("; "),
    csrf: r.json().csrfToken,
  };
}
function request(
  who: Session,
  method: "GET" | "POST",
  url: string,
  payload?: unknown,
  headers: Record<string, string> = {},
) {
  return app.inject({
    method,
    url,
    headers: {
      origin,
      cookie: who.cookie,
      "x-csrf-token": who.csrf,
      ...headers,
    },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
}
async function view() {
  const r = await request(owner, "GET", "/api/admin/courses/" + catalog);
  expect(r.statusCode).toBe(200);
  return r.json();
}
async function transition(
  id: string,
  action: string,
  who = owner,
  headers?: Record<string, string>,
) {
  return request(
    who,
    "POST",
    `/api/admin/courses/${catalog}/releases/${id}/transitions`,
    { action },
    headers ?? {
      "if-match": (await view()).revision,
      "idempotency-key": randomUUID(),
    },
  );
}
async function draft(version: string) {
  const manifest = fixture();
  manifest.version = version;
  const r = await request(
    owner,
    "POST",
    `/api/workspaces/${workspace}/releases`,
    manifest,
  );
  expect(r.statusCode, r.body).toBe(200);
  return r.json().id as string;
}
async function reviewed(version: string) {
  const id = await draft(version);
  for (const action of ["submit-review", "approve"]) {
    const r = await transition(id, action);
    expect(r.statusCode, r.body).toBe(200);
  }
  return id;
}
async function published(version: string) {
  const id = await reviewed(version),
    r = await transition(id, "publish");
  expect(r.statusCode, r.body).toBe(200);
  return id;
}
async function courses(who = learner, history = false) {
  return request(
    who,
    "GET",
    `/api/workspaces/${workspace}/courses${history ? "?includeHistorical=true" : ""}`,
  );
}
let testDatabase: TestDatabase | undefined;
beforeAll(async () => {
  connection = process.env.TEST_DATABASE_URL ?? "";
  const url = new URL(connection);
  if (
    process.env.DATABASE_URL ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    !/^\/course_core_(?:ci|test(?:_[a-z0-9_]+)?)$/.test(url.pathname) ||
    url.search ||
    url.hash
  )
    throw Error("Explicit disposable loopback database required");
  testDatabase = await createTestDatabase(schema);
  root = createDatabase(testDatabase.rootUrl);
  db = createDatabase(testDatabase.url);
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false });
});
beforeEach(async () => {
  workspace = randomUUID();
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [
    workspace,
    "catalogue-" + workspace,
    "Catalogue example",
  ]);
  owner = await session("owner");
  learner = await session("learner");
  old = await draft("1.0.0");
  catalog = (await request(owner, "GET", "/api/admin/session")).json()
    .courses[0].id;
  const r = await request(owner, "POST", `/api/releases/${old}/publish`);
  expect(r.statusCode, r.body).toBe(200);
});
afterAll(async () => {
  await app?.close();
  await db?.end();
  if (root) {
    await root.end(); await testDatabase?.drop();
  }
});
describe("one selected course release with immutable enrollment pins", () => {
  it("discovers one current release, retains existing pins and exposes history only to scoped staff", async () => {
    const saved = (
      await request(learner, "POST", "/api/enrollments", { releaseId: old })
    ).json().id;
    const before = (
      await request(learner, "GET", "/api/enrollments/" + saved)
    ).json();
    const next = await published("1.1.0");
    expect((await courses()).json().map((r: { id: string }) => r.id)).toEqual([
      next,
    ]);
    expect((await courses(owner, true)).json()).toHaveLength(2);
    expect((await courses(learner, true)).statusCode).toBe(403);
    expect(
      (
        await request(learner, "POST", "/api/enrollments", { releaseId: old })
      ).json().id,
    ).toBe(saved);
    const after = (
      await request(learner, "GET", "/api/enrollments/" + saved)
    ).json();
    expect(after.courseDigest).toBe(before.courseDigest);
    expect(after.course.version).toBe("1.0.0");
    expect(after.revision).toBe(before.revision);
    expect(after.lessons).toEqual(before.lessons);
    // Replaying the old publication endpoint must not reset a deliberate selection.
    expect(
      (await request(owner, "POST", `/api/releases/${old}/publish`)).statusCode,
    ).toBe(200);
    expect((await courses()).json()[0].id).toBe(next);
    expect(
      (await view()).releases
        .filter(
          (r: { availableForNewLearners: boolean }) =>
            r.availableForNewLearners,
        )
        .map((r: { id: string }) => r.id),
    ).toEqual([next]);
  });
  it("allows a reversible selection of an older published release without migrating newer enrollments", async () => {
    const next = await published("1.1.0"),
      enrollment = (
        await request(learner, "POST", "/api/enrollments", { releaseId: next })
      ).json().id;
    const before = (
      await db.query("SELECT * FROM enrollments WHERE id=$1", [enrollment])
    ).rows;
    const r = await transition(old, "activate");
    expect(r.statusCode, r.body).toBe(200);
    expect((await courses()).json()[0].id).toBe(old);
    expect(
      (await db.query("SELECT * FROM enrollments WHERE id=$1", [enrollment]))
        .rows,
    ).toEqual(before);
    expect(
      (await courses(owner, true))
        .json()
        .every((r: { status: string }) => r.status === "published"),
    ).toBe(true);
  });
  it("rejects draft selection, unauthorized reviewers and cross-catalogue identity at API and database boundaries", async () => {
    const pending = await draft("1.1.0");
    expect((await transition(pending, "activate")).json().error).toBe(
      "PUBLISHED_RELEASE_REQUIRED",
    );
    const reviewer = await session("reviewer");
    expect((await transition(old, "activate", reviewer)).statusCode).toBe(403);
    const observer = await session("observer");
    expect((await courses(observer, true)).json().map((r: { id: string }) => r.id)).toEqual([old]);
    const another = fixture();
    another.id = "another-course";
    const imported = await request(
      owner,
      "POST",
      `/api/workspaces/${workspace}/releases`,
      another,
    );
    expect(imported.statusCode).toBe(200);
    const foreign = imported.json().id;
    expect((await transition(foreign, "activate")).statusCode).toBe(404);
    await expect(
      db.query(
        "UPDATE admin_course_catalog SET active_release_id=$2 WHERE id=$1",
        [catalog, foreign],
      ),
    ).rejects.toMatchObject({ code: "23503" });
    expect((await courses()).json()[0].id).toBe(old);
  });
  it("fences stale choices and replays one receipt without applying different semantics", async () => {
    const next = await published("1.1.0"),
      before = await view(),
      headers = {
        "if-match": before.revision,
        "idempotency-key": randomUUID(),
      };
    const first = await transition(old, "activate", owner, headers);
    expect(first.statusCode).toBe(200);
    const repeat = await transition(old, "activate", owner, headers);
    expect(repeat.statusCode).toBe(200);
    expect(repeat.json().receipt.id).toBe(first.json().receipt.id);
    expect(
      (await transition(next, "activate", owner, headers)).json().error,
    ).toBe("IDEMPOTENCY_CONFLICT");
    expect(
      (
        await transition(next, "activate", owner, {
          ...headers,
          "idempotency-key": randomUUID(),
        })
      ).json().error,
    ).toBe("STALE_REVISION");
    expect((await courses()).json()[0].id).toBe(old);
  });
  it("rolls publication and discovery back together if the audit transaction fails", async () => {
    const next = await reviewed("1.1.0"),
      before = await view(),
      headers = {
        "if-match": before.revision,
        "idempotency-key": randomUUID(),
      };
    await db.query(
      "CREATE FUNCTION reject_catalogue_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='admin.release.transition' THEN RAISE EXCEPTION 'owned test failure'; END IF; RETURN NEW; END $$",
    );
    await db.query(
      "CREATE TRIGGER reject_catalogue_event BEFORE INSERT ON learning_events FOR EACH ROW EXECUTE FUNCTION reject_catalogue_event()",
    );
    try {
      expect(
        (await transition(next, "publish", owner, headers)).statusCode,
      ).toBe(500);
      expect((await courses()).json()[0].id).toBe(old);
      expect((await view()).revision).toBe(before.revision);
      expect(
        (await view()).releases.find((r: { id: string }) => r.id === next)
          .state,
      ).toBe("approved");
    } finally {
      await db.query("DROP TRIGGER reject_catalogue_event ON learning_events");
      await db.query("DROP FUNCTION reject_catalogue_event()");
    }
    expect((await transition(next, "publish", owner, headers)).statusCode).toBe(
      200,
    );
    expect((await courses()).json()[0].id).toBe(next);
  });
  it("serializes competing selections and legacy publication without losing the catalogue fence", async () => {
    const next = await published("1.1.0"),
      before = await view();
    const choices = await Promise.all(
      [old, next].map((id) =>
        transition(id, "activate", owner, {
          "if-match": before.revision,
          "idempotency-key": randomUUID(),
        }),
      ),
    );
    expect(choices.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(Number((await view()).revision)).toBe(Number(before.revision) + 1);
    expect((await courses()).json()).toHaveLength(1);
    const fresh = await reviewed("1.2.0"),
      revision = (await view()).revision;
    const results = await Promise.all([
      request(owner, "POST", `/api/releases/${fresh}/publish`),
      transition(old, "activate", owner, {
        "if-match": revision,
        "idempotency-key": randomUUID(),
      }),
    ]);
    expect(results[0]!.statusCode, results[0]!.body).toBe(200);
    expect([200, 409]).toContain(results[1]!.statusCode);
    expect((await courses()).json()[0].id).toBe(fresh);
  });
  it("backfills a real previous schema without rewriting saved enrollment rows", async () => {
    const legacySchema = "catalogue_legacy_" + randomUUID().replaceAll("-", ""),
      temporary = await mkdtemp(
        path.join(tmpdir(), "course-catalogue-migrations-"),
      ),
      url = new URL(testDatabase!.rootUrl);
    url.searchParams.set("options", "-csearch_path=" + legacySchema);
    let legacy: Database | undefined;
    await root.query("CREATE SCHEMA " + legacySchema);
    try {
      for (const file of await readdir(directory))
        if (file.endsWith(".sql") && file < "015_catalogue_selection.sql")
          await writeFile(
            path.join(temporary, file),
            await readFile(path.join(directory, file)),
          );
      legacy = createDatabase(url.href);
      await migrate(legacy, temporary);
      const w = randomUUID(),
        u = randomUUID(),
        c = randomUUID(),
        older = randomUUID(),
        newer = randomUUID(),
        enrollment = randomUUID();
      await legacy.query(
        "INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)",
        [w, "legacy-example", "Legacy"],
      );
      await legacy.query(
        "INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)",
        [u, "legacy:" + u, "Legacy learner"],
      );
      for (const [id, version, date] of [
        [older, "1.0.0", "2026-10-10T00:00:00Z"],
        [newer, "1.1.0", "2026-10-11T00:00:00Z"],
      ]) {
        const f = fixture();
        f.version = version!;
        const compiled = compileCourse(f);
        await legacy.query(
          "INSERT INTO course_releases(id,workspace_id,course_key,version,digest,server_bundle,learner_bundle,status,created_by,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,'published',$8,$9)",
          [
            id,
            w,
            f.id,
            version,
            compiled.digest,
            JSON.stringify(compiled.server),
            JSON.stringify(compiled.learner),
            u,
            date,
          ],
        );
      }
      await legacy.query(
        "INSERT INTO admin_course_catalog(id,workspace_id,course_key,title,description) VALUES($1,$2,$3,$4,$5)",
        [c, w, fixture().id, "Legacy", "Previous catalogue"],
      );
      await legacy.query(
        "INSERT INTO enrollments(id,workspace_id,course_release_id,user_id,policy,profile) VALUES($1,$2,$3,$4,$5,$6)",
        [
          enrollment,
          w,
          older,
          u,
          JSON.stringify(fixture().policy),
          JSON.stringify({
            displayName: "Legacy learner",
            goal: "",
            pace: "steady",
          }),
        ],
      );
      const before = (await legacy.query("SELECT * FROM enrollments")).rows;
      // Only 015 and later migrations run; nothing already applied repeats.
      const applied = await migrate(legacy, directory);
      expect(applied[0]).toBe("015_catalogue_selection.sql");
      expect(applied.every((file) => file >= "015_catalogue_selection.sql")).toBe(true);
      expect(
        (
          await legacy.query(
            "SELECT active_release_id FROM admin_course_catalog",
          )
        ).rows[0].active_release_id,
      ).toBe(newer);
      expect((await legacy.query("SELECT * FROM enrollments")).rows).toEqual(
        before,
      );
      expect(await migrate(legacy, directory)).toEqual([]);
    } finally {
      await legacy?.end();
      await rm(temporary, { recursive: true, force: true });
    }
  }, 30000);
});
